"""Project Memory — persistent context store for creative decisions and documents.

Each project gets a `.memory/` directory containing:
- ``manifest.json`` — index of all documents
- ``context.md`` — master project context (living summary)
- ``memory.md`` — append-only preferences and decision log
- ``documents/*.md`` — typed documents (scripts, research, storyboards, etc.)

Storage location: ``~/.ltx-desktop/project-memory/{project_id}/``
(mirrors the brain-cache pattern for reliability without external config).
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from agent.types import (
    DocumentMeta,
    MemoryDocument,
    MemoryDocumentType,
    MemoryManifest,
)

logger = logging.getLogger(__name__)

_DEFAULT_MEMORY_ROOT = Path.home() / ".ltx-desktop" / "project-memory"
_MAX_DOCUMENTS_PER_PROJECT = 200
_MAX_DOCUMENT_SIZE_BYTES = 1_048_576  # 1 MB
_SAFE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

_format_cache: dict[str, tuple[float, str]] = {}
_FORMAT_CACHE_TTL = 30.0


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def _sanitize_id(value: str) -> str:
    """Reject identifiers containing path separators or traversal sequences."""
    if not value or "/" in value or "\\" in value or ".." in value:
        raise ValueError(f"Invalid identifier: {value!r}")
    if not _SAFE_ID_PATTERN.match(value):
        raise ValueError(f"Invalid identifier: {value!r}")
    return value


def _memory_dir(project_id: str, assets_path: str | None = None) -> Path:
    """Resolve the .memory/ directory for a project."""
    pid = _sanitize_id(project_id)
    if assets_path:
        base = Path(assets_path) / pid / ".memory"
    else:
        base = _DEFAULT_MEMORY_ROOT / pid
    return base


def _ensure_dirs(memory_dir: Path) -> None:
    """Create the .memory/ and documents/ subdirectories if missing."""
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "documents").mkdir(exist_ok=True)


def has_memory(project_id: str, assets_path: str | None = None) -> bool:
    """Fast existence check — single stat() call, no file parsing."""
    try:
        return _memory_dir(project_id, assets_path).exists()
    except ValueError:
        return False


def invalidate_cache(project_id: str, assets_path: str | None = None) -> None:
    """Clear the format cache after writes so the next read sees fresh data."""
    cache_key = f"{project_id}:{assets_path or ''}"
    _format_cache.pop(cache_key, None)


# ---------------------------------------------------------------------------
# Manifest operations
# ---------------------------------------------------------------------------


def _manifest_path(memory_dir: Path) -> Path:
    return memory_dir / "manifest.json"


def _load_manifest(memory_dir: Path) -> MemoryManifest:
    path = _manifest_path(memory_dir)
    if not path.exists():
        return MemoryManifest(project_id="", documents=[], updated_at="")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return MemoryManifest.model_validate(data)
    except Exception:
        logger.warning("Failed to read manifest at %s", path, exc_info=True)
        return MemoryManifest(project_id="", documents=[], updated_at="")


def _save_manifest(memory_dir: Path, manifest: MemoryManifest) -> None:
    manifest.updated_at = _now_iso()
    data = manifest.model_dump(mode="json")
    _atomic_write(_manifest_path(memory_dir), json.dumps(data, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(title: str) -> str:
    """Convert a title to a filesystem-safe slug."""
    slug = re.sub(r"[^\w\s-]", "", title.lower())
    slug = re.sub(r"[\s_]+", "-", slug).strip("-")
    return slug[:60] or "untitled"


def _atomic_write(path: Path, content: str) -> None:
    """Write to a temp file then rename for atomicity."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            f.write(content)
        Path(tmp).replace(path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def _build_frontmatter(meta: DocumentMeta) -> str:
    """Serialize document metadata as YAML frontmatter."""
    tags_str = json.dumps(meta.tags)
    return (
        f"---\n"
        f"id: \"{meta.id}\"\n"
        f"title: \"{meta.title}\"\n"
        f"type: \"{meta.type}\"\n"
        f"description: \"{meta.description}\"\n"
        f"created_at: \"{meta.created_at}\"\n"
        f"updated_at: \"{meta.updated_at}\"\n"
        f"version: {meta.version}\n"
        f"tags: {tags_str}\n"
        f"created_by: \"{meta.created_by}\"\n"
        f"---\n\n"
    )


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split YAML frontmatter from markdown body. Returns (metadata_dict, body)."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("---", 3)
    if end == -1:
        return {}, text
    fm_block = text[3:end].strip()
    body = text[end + 3:].lstrip("\n")
    meta: dict[str, str] = {}
    for line in fm_block.split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip().strip('"')
    return meta, body


# ---------------------------------------------------------------------------
# Public API — CRUD
# ---------------------------------------------------------------------------


def get_manifest(
    project_id: str,
    assets_path: str | None = None,
) -> MemoryManifest | None:
    """Return the manifest for a project, or None if no memory exists."""
    try:
        mdir = _memory_dir(project_id, assets_path)
        if not mdir.exists():
            return None
        manifest = _load_manifest(mdir)
        manifest.project_id = project_id
        return manifest
    except ValueError:
        return None


def list_documents(
    project_id: str,
    assets_path: str | None = None,
    doc_type: MemoryDocumentType | None = None,
) -> list[DocumentMeta]:
    """List document metadata, optionally filtered by type."""
    manifest = get_manifest(project_id, assets_path)
    if manifest is None:
        return []
    docs = manifest.documents
    if doc_type is not None:
        docs = [d for d in docs if d.type == doc_type]
    return docs


def read_document(
    project_id: str,
    doc_id: str,
    assets_path: str | None = None,
) -> MemoryDocument | None:
    """Read a full document by ID."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return None
    manifest = _load_manifest(mdir)
    meta = next((d for d in manifest.documents if d.id == doc_id), None)
    if meta is None:
        return None
    doc_path = mdir / meta.filename
    if not doc_path.exists():
        return None
    try:
        raw = doc_path.read_text(encoding="utf-8")
        _, body = _parse_frontmatter(raw)
        return MemoryDocument(meta=meta, content=body)
    except Exception:
        logger.warning("Failed to read document %s", doc_path, exc_info=True)
        return None


def write_document(
    project_id: str,
    title: str,
    doc_type: MemoryDocumentType,
    content: str,
    description: str = "",
    tags: list[str] | None = None,
    created_by: str = "user",
    assets_path: str | None = None,
) -> DocumentMeta:
    """Create a new memory document. Returns the metadata."""
    if len(content.encode("utf-8")) > _MAX_DOCUMENT_SIZE_BYTES:
        raise ValueError("Document exceeds 1 MB size limit")

    mdir = _memory_dir(project_id, assets_path)
    _ensure_dirs(mdir)
    manifest = _load_manifest(mdir)
    manifest.project_id = project_id

    if len(manifest.documents) >= _MAX_DOCUMENTS_PER_PROJECT:
        raise ValueError(f"Project has reached the {_MAX_DOCUMENTS_PER_PROJECT} document limit")

    doc_id = str(uuid.uuid4())
    slug = _slugify(title)
    filename = f"documents/{slug}.md"

    # Deduplicate filenames
    existing_filenames = {d.filename for d in manifest.documents}
    if filename in existing_filenames:
        filename = f"documents/{slug}-{doc_id[:8]}.md"

    now = _now_iso()
    meta = DocumentMeta(
        id=doc_id,
        title=title,
        type=doc_type,
        filename=filename,
        description=description,
        created_at=now,
        updated_at=now,
        version=1,
        tags=tags or [],
        created_by=created_by,
    )

    file_content = _build_frontmatter(meta) + content
    _atomic_write(mdir / filename, file_content)

    manifest.documents.append(meta)
    _save_manifest(mdir, manifest)

    invalidate_cache(project_id, assets_path)
    logger.info("Created memory document '%s' (%s) for project %s", title, doc_type, project_id[:8])
    return meta


def update_document(
    project_id: str,
    doc_id: str,
    content: str | None = None,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    assets_path: str | None = None,
) -> DocumentMeta | None:
    """Update an existing document. Returns updated metadata or None if not found."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return None

    manifest = _load_manifest(mdir)
    idx = next((i for i, d in enumerate(manifest.documents) if d.id == doc_id), None)
    if idx is None:
        return None

    meta = manifest.documents[idx]

    if title is not None:
        meta.title = title
    if description is not None:
        meta.description = description
    if tags is not None:
        meta.tags = tags

    meta.version += 1
    meta.updated_at = _now_iso()

    # Re-read existing content if only metadata is being updated
    doc_path = mdir / meta.filename
    if content is None and doc_path.exists():
        raw = doc_path.read_text(encoding="utf-8")
        _, body = _parse_frontmatter(raw)
        content = body

    if content is not None:
        if len(content.encode("utf-8")) > _MAX_DOCUMENT_SIZE_BYTES:
            raise ValueError("Document exceeds 1 MB size limit")
        file_content = _build_frontmatter(meta) + content
        _atomic_write(doc_path, file_content)

    manifest.documents[idx] = meta
    manifest.project_id = project_id
    _save_manifest(mdir, manifest)

    invalidate_cache(project_id, assets_path)
    logger.info("Updated memory document '%s' (v%d) for project %s", meta.title, meta.version, project_id[:8])
    return meta


def delete_document(
    project_id: str,
    doc_id: str,
    assets_path: str | None = None,
) -> bool:
    """Delete a document by ID. Returns True if deleted."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return False

    manifest = _load_manifest(mdir)
    idx = next((i for i, d in enumerate(manifest.documents) if d.id == doc_id), None)
    if idx is None:
        return False

    meta = manifest.documents.pop(idx)
    doc_path = mdir / meta.filename
    doc_path.unlink(missing_ok=True)
    manifest.project_id = project_id
    _save_manifest(mdir, manifest)

    invalidate_cache(project_id, assets_path)
    logger.info("Deleted memory document '%s' from project %s", meta.title, project_id[:8])
    return True


# ---------------------------------------------------------------------------
# Special documents — context.md and memory.md
# ---------------------------------------------------------------------------


def read_context(
    project_id: str,
    assets_path: str | None = None,
) -> str:
    """Read the master project context document."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return ""
    path = mdir / "context.md"
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        logger.warning("Failed to read context.md for %s", project_id[:8], exc_info=True)
        return ""


def update_context(
    project_id: str,
    content: str,
    assets_path: str | None = None,
) -> None:
    """Write the master project context document."""
    mdir = _memory_dir(project_id, assets_path)
    _ensure_dirs(mdir)
    _atomic_write(mdir / "context.md", content)
    invalidate_cache(project_id, assets_path)
    logger.info("Updated project context for %s", project_id[:8])


def read_memory_log(
    project_id: str,
    assets_path: str | None = None,
) -> str:
    """Read the memory/preferences log."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return ""
    path = mdir / "memory.md"
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        logger.warning("Failed to read memory.md for %s", project_id[:8], exc_info=True)
        return ""


def clear_memory_log(
    project_id: str,
    assets_path: str | None = None,
) -> None:
    """Delete the memory/preferences log file."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return
    path = mdir / "memory.md"
    if path.exists():
        path.unlink()
    invalidate_cache(project_id, assets_path)
    logger.info("Cleared memory log for project %s", project_id[:8])


def append_memory_entry(
    project_id: str,
    entry: str,
    assets_path: str | None = None,
) -> None:
    """Append a timestamped entry to the memory/preferences log."""
    mdir = _memory_dir(project_id, assets_path)
    _ensure_dirs(mdir)
    path = mdir / "memory.md"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    line = f"\n- [{timestamp}] {entry.strip()}\n"
    try:
        with open(path, "a", encoding="utf-8") as f:
            if path.stat().st_size == 0:
                f.write("# Project Memory Log\n\n")
            f.write(line)
    except FileNotFoundError:
        _atomic_write(path, f"# Project Memory Log\n\n{line}")
    invalidate_cache(project_id, assets_path)
    logger.info("Appended memory entry for project %s", project_id[:8])


def clear_all_memory(
    project_id: str,
    assets_path: str | None = None,
) -> None:
    """Delete all documents, log, context, and brain cache for a project."""
    try:
        mdir = _memory_dir(project_id, assets_path)
    except ValueError:
        return

    manifest = _load_manifest(mdir)
    for doc in list(manifest.documents):
        doc_path = mdir / doc.filename
        doc_path.unlink(missing_ok=True)
    manifest.documents.clear()
    manifest.project_id = project_id
    _save_manifest(mdir, manifest)

    context_path = mdir / "context.md"
    if context_path.exists():
        context_path.unlink()

    log_path = mdir / "memory.md"
    if log_path.exists():
        log_path.unlink()

    from agent import brain as brain_module
    brain_module.clear_brain(project_id)

    invalidate_cache(project_id, assets_path)
    logger.info("Cleared all memory (docs, log, context, brain) for project %s", project_id[:8])


# ---------------------------------------------------------------------------
# Agent context formatting
# ---------------------------------------------------------------------------

_CONTEXT_MAX_CHARS = 800
_CATALOG_MAX_DOCS = 20
_LOG_MAX_ENTRIES = 10


def format_memory_for_agent(
    project_id: str,
    assets_path: str | None = None,
) -> str:
    """Produce a compact text block for injection into agent context.

    Includes: master context summary, document catalog, and recent memory log entries.
    Total budget: ~500-1000 tokens.

    Results are cached per project_id for ``_FORMAT_CACHE_TTL`` seconds so
    burst calls (orchestrator + N sub-agents) don't re-read disk.
    """
    cache_key = f"{project_id}:{assets_path or ''}"
    cached = _format_cache.get(cache_key)
    if cached and (time.monotonic() - cached[0]) < _FORMAT_CACHE_TTL:
        return cached[1]

    lines: list[str] = []

    context = read_context(project_id, assets_path)
    if context:
        trimmed = context[:_CONTEXT_MAX_CHARS]
        if len(context) > _CONTEXT_MAX_CHARS:
            trimmed += "..."
        lines.append(f"**Project Context:**\n{trimmed}")

    docs = list_documents(project_id, assets_path)
    if docs:
        sorted_docs = sorted(docs, key=lambda d: d.updated_at, reverse=True)[:_CATALOG_MAX_DOCS]
        lines.append(f"\n**Memory Documents** ({len(docs)} total):")
        for doc in sorted_docs:
            tags = ", ".join(doc.tags[:3]) if doc.tags else ""
            tag_str = f" [{tags}]" if tags else ""
            lines.append(f"  - [{doc.type}] \"{doc.title}\" (id={doc.id}, v{doc.version}){tag_str}: {doc.description[:100]}")

    log = read_memory_log(project_id, assets_path)
    if log:
        log_lines = [l for l in log.strip().split("\n") if l.startswith("- [")]
        recent = log_lines[-_LOG_MAX_ENTRIES:]
        if recent:
            lines.append(f"\n**Recent Memory Notes** ({len(log_lines)} total, showing last {len(recent)}):")
            lines.extend(f"  {entry}" for entry in recent)

    result = ("## Project Memory\n\n" + "\n".join(lines)) if lines else ""
    _format_cache[cache_key] = (time.monotonic(), result)
    return result
