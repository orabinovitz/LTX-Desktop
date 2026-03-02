"""Project Brain — compact, queryable index of all content in a project.

The brain maintains a high-level topic map and clip index that the agent
consults before loading detailed metadata. It is:

- Built once after the first video analysis completes
- Incrementally updated when new analyses finish or scenes are decomposed
- Persisted to ``~/.ltx-desktop/brain-cache/{project_id}.json``
- Formatted into a compact text block (~300-500 tokens) for agent context

Brain updates happen in a background thread with a 30-second debounce so
they never block user interactions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from agent.types import VideoMetadata
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

_GEMINI_MODEL = "gemini-3-flash-preview"
_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
_DISK_CACHE_DIR = Path.home() / ".ltx-desktop" / "brain-cache"
_DEBOUNCE_SECONDS = 30


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


class BrainClipEntry(BaseModel):
    """A single clip known to the brain."""

    asset_id: str
    title: str
    description: str = Field(default="", description="1-sentence description")
    duration: float = 0.0
    topics: list[str] = Field(default_factory=list)
    has_dialogue: bool = False
    key_quotes: list[str] = Field(default_factory=list, description="Max 3 representative quotes")
    importance: float = Field(default=0.5, ge=0.0, le=1.0)


class BrainTopic(BaseModel):
    """A thematic topic grouping clips."""

    id: str
    name: str
    description: str = Field(default="", description="1-sentence description")
    clip_ids: list[str] = Field(default_factory=list, description="Asset IDs ordered by relevance")


class ProjectBrain(BaseModel):
    """The complete brain for a single project."""

    project_id: str
    summary: str = Field(default="", description="2-3 sentences about all project content")
    topics: list[BrainTopic] = Field(default_factory=list)
    clips: list[BrainClipEntry] = Field(default_factory=list)
    updated_at: float = 0.0
    version: int = 1
    dirty: bool = False


# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

_brains: dict[str, ProjectBrain] = {}
_brain_lock = threading.Lock()
_pending_updates: dict[str, float] = {}  # project_id -> scheduled_time
_debounce_timer: threading.Timer | None = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_brain(project_id: str) -> ProjectBrain | None:
    """Return the brain for a project, loading from disk if needed."""
    with _brain_lock:
        brain = _brains.get(project_id)
    if brain is not None:
        return brain

    loaded = _load_from_disk(project_id)
    if loaded is not None:
        with _brain_lock:
            _brains[project_id] = loaded
        return loaded
    return None


def build_brain(
    project_id: str,
    all_metadata: list[VideoMetadata],
    gemini_api_key: str,
    http_client: HTTPClient,
    project_save_path: str | None = None,
) -> ProjectBrain:
    """Build a brain from scratch using all available metadata.

    This makes a single Gemini call to extract topics and group clips.
    """
    clips = _metadata_to_clip_entries(all_metadata)
    if not clips:
        brain = ProjectBrain(
            project_id=project_id,
            summary="No analyzed content in this project yet.",
            updated_at=time.time(),
        )
        _store_brain(brain, project_save_path)
        return brain

    clip_summaries = _format_clips_for_topic_extraction(clips)
    topic_result = _call_gemini_for_topics(
        clip_summaries, gemini_api_key, http_client,
    )

    topics = _parse_topic_result(topic_result, clips)
    summary = topic_result.get("summary", "")

    brain = ProjectBrain(
        project_id=project_id,
        summary=summary,
        topics=topics,
        clips=clips,
        updated_at=time.time(),
        version=1,
        dirty=False,
    )
    _store_brain(brain, project_save_path)
    return brain


def update_brain_incremental(
    project_id: str,
    new_metadata: VideoMetadata,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> ProjectBrain:
    """Add new clips from a single video analysis to an existing brain."""
    existing = get_brain(project_id)
    new_clips = _metadata_to_clip_entries([new_metadata])

    if existing is None:
        return build_brain(project_id, [new_metadata], gemini_api_key, http_client)

    existing_ids = {c.asset_id for c in existing.clips}
    added = [c for c in new_clips if c.asset_id not in existing_ids]
    if not added:
        return existing

    all_clips = existing.clips + added
    clip_summaries = _format_clips_for_topic_extraction(all_clips)
    topic_result = _call_gemini_for_topics(
        clip_summaries, gemini_api_key, http_client,
    )

    topics = _parse_topic_result(topic_result, all_clips)
    summary = topic_result.get("summary", "")

    brain = ProjectBrain(
        project_id=project_id,
        summary=summary,
        topics=topics,
        clips=all_clips,
        updated_at=time.time(),
        version=existing.version + 1,
        dirty=False,
    )
    _store_brain(brain)
    return brain


def query_brain(project_id: str, query: str) -> list[BrainClipEntry]:
    """Search the brain for clips relevant to a query string.

    Uses simple keyword matching against topic names, clip descriptions,
    and key quotes. No Gemini call needed — this is instant.
    """
    brain = get_brain(project_id)
    if brain is None:
        return []

    query_lower = query.lower()
    query_words = set(query_lower.split())

    scored: list[tuple[float, BrainClipEntry]] = []
    for clip in brain.clips:
        score = _relevance_score(clip, brain.topics, query_lower, query_words)
        if score > 0:
            scored.append((score, clip))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [clip for _, clip in scored[:20]]


def format_brain_for_agent(brain: ProjectBrain) -> str:
    """Produce a compact text representation for injection into agent context."""
    lines: list[str] = [f"**Project Brain** (v{brain.version}, {len(brain.clips)} clips)"]

    if brain.summary:
        lines.append(f"Summary: {brain.summary}")

    if brain.topics:
        lines.append(f"\n{len(brain.topics)} topic(s):")
        for topic in brain.topics:
            clip_count = len(topic.clip_ids)
            lines.append(f"  - **{topic.name}** ({clip_count} clips): {topic.description}")
    else:
        lines.append("No topics identified yet.")

    return "\n".join(lines)


def mark_dirty(project_id: str) -> None:
    """Flag a brain as needing a rebuild. Schedules a debounced background update."""
    with _brain_lock:
        brain = _brains.get(project_id)
        if brain is not None:
            brain.dirty = True
    _schedule_debounced_update(project_id)


def schedule_brain_build(
    project_id: str,
    all_metadata: list[VideoMetadata],
    gemini_api_key: str,
    http_client: HTTPClient,
    project_save_path: str | None = None,
) -> None:
    """Schedule a brain build/update in a background thread."""
    thread = threading.Thread(
        target=_background_build,
        args=(project_id, all_metadata, gemini_api_key, http_client, project_save_path),
        daemon=True,
        name=f"brain-build-{project_id[:8]}",
    )
    thread.start()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _store_brain(brain: ProjectBrain, project_save_path: str | None = None) -> None:
    """Store brain in memory, persist to global disk cache, and optionally to project folder."""
    with _brain_lock:
        _brains[brain.project_id] = brain
    _save_to_disk(brain)
    if project_save_path:
        _save_brain_to_project_folder(brain, project_save_path)


def _save_brain_to_project_folder(brain: ProjectBrain, project_save_path: str) -> None:
    """Write brain.json and brain-summary.txt to the project's .ltx-desktop/brain/ folder."""
    try:
        brain_dir = Path(project_save_path) / ".ltx-desktop" / "brain"
        brain_dir.mkdir(parents=True, exist_ok=True)

        data = brain.model_dump(mode="json")
        (brain_dir / "brain.json").write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8",
        )

        summary_text = format_brain_for_agent(brain)
        (brain_dir / "brain-summary.txt").write_text(summary_text, encoding="utf-8")

        logger.info("Saved brain artifacts to %s", brain_dir)
    except Exception:
        logger.warning("Failed to save brain to project folder", exc_info=True)


def _relevance_score(
    clip: BrainClipEntry,
    topics: list[BrainTopic],
    query_lower: str,
    query_words: set[str],
) -> float:
    """Score a clip's relevance to a query. Higher = more relevant."""
    score = 0.0

    desc_lower = clip.description.lower()
    title_lower = clip.title.lower()

    if query_lower in desc_lower or query_lower in title_lower:
        score += 3.0

    for word in query_words:
        if word in desc_lower:
            score += 1.0
        if word in title_lower:
            score += 1.5
        for topic_name in clip.topics:
            if word in topic_name.lower():
                score += 2.0
        for quote in clip.key_quotes:
            if word in quote.lower():
                score += 0.5

    for topic in topics:
        topic_name_lower = topic.name.lower()
        if query_lower in topic_name_lower or any(w in topic_name_lower for w in query_words):
            if clip.asset_id in topic.clip_ids:
                rank = topic.clip_ids.index(clip.asset_id)
                score += max(0, 3.0 - rank * 0.3)

    score += clip.importance * 0.5

    return score


def _metadata_to_clip_entries(all_metadata: list[VideoMetadata]) -> list[BrainClipEntry]:
    """Convert video metadata into brain clip entries."""
    clips: list[BrainClipEntry] = []
    for meta in all_metadata:
        if not meta.scenes and not meta.summary:
            continue

        avg_importance = (
            sum(s.importance for s in meta.scenes) / len(meta.scenes)
            if meta.scenes else 0.5
        )

        key_quotes: list[str] = []
        for dl in meta.dialogue[:5]:
            if dl.text and len(key_quotes) < 3:
                text = dl.text[:100] + "..." if len(dl.text) > 100 else dl.text
                key_quotes.append(text)

        topic_names = [t.name for t in meta.topics]

        clips.append(BrainClipEntry(
            asset_id=meta.asset_id,
            title=meta.summary[:80] if meta.summary else f"Video {meta.asset_id[:8]}",
            description=meta.summary,
            duration=meta.duration,
            topics=topic_names,
            has_dialogue=len(meta.dialogue) > 0,
            key_quotes=key_quotes,
            importance=avg_importance,
        ))
    return clips


def _format_clips_for_topic_extraction(clips: list[BrainClipEntry]) -> str:
    """Format clip entries into text for Gemini topic extraction."""
    lines: list[str] = []
    for clip in clips:
        topics_str = ", ".join(clip.topics) if clip.topics else "none"
        quotes_str = " | ".join(clip.key_quotes) if clip.key_quotes else ""
        lines.append(
            f"- asset_id={clip.asset_id} dur={clip.duration:.0f}s "
            f"topics=[{topics_str}] desc=\"{clip.description}\" "
            f"quotes=\"{quotes_str}\""
        )
    return "\n".join(lines)


def _call_gemini_for_topics(
    clip_summaries: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Ask Gemini to group clips by topic and produce a project summary."""
    system_prompt = (
        "You are a video project analyst. Given a list of video clips with their "
        "descriptions, durations, and existing topic tags, produce a structured JSON "
        "object with:\n\n"
        '- "summary": 2-3 sentences describing the overall project content.\n'
        '- "topics": array of topic groupings. Each has:\n'
        '    - "id": short snake_case identifier\n'
        '    - "name": human-readable topic name (2-5 words)\n'
        '    - "description": one-sentence description\n'
        '    - "clip_ids": array of asset_id strings ordered by relevance to this topic\n\n'
        "Group clips into 3-15 meaningful topics. A clip can appear in multiple topics. "
        "Order clip_ids within each topic from most to least relevant.\n"
        "Return ONLY valid JSON."
    )

    user_text = f"Here are the clips in this project:\n\n{clip_summaries}\n\nGroup them by topic."

    gemini_url = f"{_GEMINI_BASE_URL}/{_GEMINI_MODEL}:generateContent"
    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    try:
        response = http_client.post(
            gemini_url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_api_key,
            },
            json_payload=payload,
            timeout=60,
        )
    except HttpTimeoutError:
        logger.error("Brain topic extraction timed out")
        return {"summary": "", "topics": []}
    except Exception:
        logger.error("Brain topic extraction failed", exc_info=True)
        return {"summary": "", "topics": []}

    if response.status_code != 200:
        logger.error("Brain Gemini error %d: %s", response.status_code, response.text[:300])
        return {"summary": "", "topics": []}

    try:
        body = response.json()
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except Exception:
        logger.error("Failed to parse brain topic response", exc_info=True)
        return {"summary": "", "topics": []}


def _parse_topic_result(
    result: dict,
    clips: list[BrainClipEntry],
) -> list[BrainTopic]:
    """Parse Gemini topic grouping result into BrainTopic objects."""
    valid_ids = {c.asset_id for c in clips}
    topics: list[BrainTopic] = []

    for t in result.get("topics", []):
        try:
            clip_ids = [cid for cid in t.get("clip_ids", []) if cid in valid_ids]
            topics.append(BrainTopic(
                id=t.get("id", f"topic_{len(topics)}"),
                name=t.get("name", "Unknown"),
                description=t.get("description", ""),
                clip_ids=clip_ids,
            ))
        except Exception:
            logger.warning("Skipping unparseable topic: %s", t)

    return topics


def _background_build(
    project_id: str,
    all_metadata: list[VideoMetadata],
    gemini_api_key: str,
    http_client: HTTPClient,
    project_save_path: str | None = None,
) -> None:
    """Background thread target for building/updating the brain."""
    try:
        t0 = time.monotonic()
        brain = build_brain(project_id, all_metadata, gemini_api_key, http_client, project_save_path)
        elapsed = time.monotonic() - t0
        logger.info(
            "Brain build complete for project %s: %d topics, %d clips in %.1fs",
            project_id[:8], len(brain.topics), len(brain.clips), elapsed,
        )
    except Exception:
        logger.exception("Background brain build failed for %s", project_id[:8])


def _schedule_debounced_update(project_id: str) -> None:
    """Schedule a debounced brain update (no-op if no API key available)."""
    _pending_updates[project_id] = time.time() + _DEBOUNCE_SECONDS
    logger.debug("Brain update scheduled for %s in %ds", project_id[:8], _DEBOUNCE_SECONDS)


# ---------------------------------------------------------------------------
# Disk persistence
# ---------------------------------------------------------------------------


def _disk_path(project_id: str) -> Path:
    key = hashlib.sha256(project_id.encode()).hexdigest()[:16]
    return _DISK_CACHE_DIR / f"{key}.json"


def _save_to_disk(brain: ProjectBrain) -> None:
    try:
        _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        data = brain.model_dump(mode="json")
        _disk_path(brain.project_id).write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        logger.warning("Failed to write brain cache for %s", brain.project_id, exc_info=True)


def _load_from_disk(project_id: str) -> ProjectBrain | None:
    path = _disk_path(project_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return ProjectBrain.model_validate(data)
    except Exception:
        logger.warning("Failed to read brain cache for %s", project_id, exc_info=True)
        return None
