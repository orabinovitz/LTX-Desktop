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
    source_in: float | None = Field(default=None, description="Source in-point for topic segments")
    source_out: float | None = Field(default=None, description="Source out-point for topic segments")
    is_topic_segment: bool = Field(default=False, description="True if this is a virtual topic segment")


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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_all_project_ids() -> list[str]:
    """Return IDs of all projects with a brain in memory."""
    with _brain_lock:
        return list(_brains.keys())


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
    """Produce a compact text representation for injection into agent context.

    Includes topic time ranges and segment info so the agent can plan
    cuts directly without additional tool calls for discovery.
    """
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

    # Include topic segment entries with time ranges
    topic_segments = [c for c in brain.clips if c.is_topic_segment]
    if topic_segments:
        lines.append(f"\n**Topic Segments** ({len(topic_segments)} segments with time ranges):")
        for seg in topic_segments:
            time_range = ""
            if seg.source_in is not None and seg.source_out is not None:
                time_range = f" [{seg.source_in:.0f}s–{seg.source_out:.0f}s]"
            quote_str = ""
            if seg.key_quotes:
                quote_str = f' | quote: "{seg.key_quotes[0][:80]}"'
            lines.append(
                f"  - **{seg.title}** (asset={seg.asset_id}, {seg.duration:.0f}s){time_range}"
                f"  importance={seg.importance:.1f}{quote_str}"
            )

    # Include non-topic clips with their key details
    regular_clips = [c for c in brain.clips if not c.is_topic_segment]
    if regular_clips:
        lines.append(f"\n**Source Clips** ({len(regular_clips)}):")
        for clip in regular_clips:
            topics_str = ", ".join(clip.topics[:3]) if clip.topics else "none"
            lines.append(
                f"  - asset={clip.asset_id} | {clip.duration:.0f}s | topics=[{topics_str}]"
                f" | importance={clip.importance:.1f}"
            )
            if clip.key_quotes:
                lines.append(f'    top quote: "{clip.key_quotes[0][:100]}"')

    return "\n".join(lines)


def clear_brain(project_id: str) -> bool:
    """Remove a project's brain from memory and disk. Returns True if deleted."""
    with _brain_lock:
        _brains.pop(project_id, None)
    path = _disk_path(project_id)
    if path.exists():
        try:
            path.unlink()
            logger.info("Cleared brain cache for project %s", project_id[:8])
            return True
        except Exception:
            logger.warning("Failed to delete brain cache for %s", project_id[:8], exc_info=True)
            return False
    return False


def mark_dirty(project_id: str) -> None:
    """Flag a brain as needing a rebuild (rebuilt lazily on next agent prompt)."""
    with _brain_lock:
        brain = _brains.get(project_id)
        if brain is not None:
            brain.dirty = True
            logger.info("Brain marked dirty for project %s", project_id[:8])


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


_CONCEPT_SYNONYMS: dict[str, list[str]] = {
    "sound": ["audio", "sound", "voice", "lip sync", "synchronization", "speech", "music"],
    "audio": ["audio", "sound", "voice", "lip sync", "music", "speech"],
    "voice": ["voice", "audio", "sound", "speech", "dialogue"],
    "improvements": ["improvements", "fixes", "enhancements", "better", "improved", "upgraded", "quality"],
    "quality": ["quality", "improvements", "better", "enhanced", "fidelity"],
    "video": ["video", "visual", "footage", "clip", "shot"],
    "latent": ["latent", "latent space", "compression", "encoding"],
    "prompt": ["prompt", "adherence", "following", "instructions"],
    "motion": ["motion", "movement", "animation", "ken burns", "dynamic"],
    "community": ["community", "users", "feedback", "discord", "reddit", "open source"],
    "future": ["future", "vision", "roadmap", "next", "upcoming", "rendering"],
    "download": ["download", "downloads", "milestone", "hugging face", "adoption"],
}


def _expand_query_words(query_words: set[str]) -> set[str]:
    """Expand query words with known synonyms/related concepts."""
    expanded = set(query_words)
    for word in query_words:
        synonyms = _CONCEPT_SYNONYMS.get(word, [])
        expanded.update(synonyms)
    return expanded


def _relevance_score(
    clip: BrainClipEntry,
    topics: list[BrainTopic],
    query_lower: str,
    query_words: set[str],
) -> float:
    """Score a clip's relevance to a query. Higher = more relevant."""
    score = 0.0

    expanded_words = _expand_query_words(query_words)

    desc_lower = clip.description.lower()
    title_lower = clip.title.lower()

    # Exact full-query match in title/description
    if query_lower in desc_lower or query_lower in title_lower:
        score += 3.0

    # Expanded word matching with substring support
    for word in expanded_words:
        if word in desc_lower:
            score += 1.0 if word in query_words else 0.5
        if word in title_lower:
            score += 1.5 if word in query_words else 0.8
        for topic_name in clip.topics:
            topic_lower = topic_name.lower()
            if word in topic_lower:
                score += 2.0 if word in query_words else 1.0
        for quote in clip.key_quotes:
            if word in quote.lower():
                score += 0.5

    # Substring matching: "audio" matches "audio quality"
    for word in query_words:
        if len(word) >= 4:
            for topic_name in clip.topics:
                if word in topic_name.lower() and word not in expanded_words:
                    score += 1.5

    # Brain topic cross-reference
    for topic in topics:
        topic_name_lower = topic.name.lower()
        if query_lower in topic_name_lower or any(w in topic_name_lower for w in expanded_words):
            if clip.asset_id in topic.clip_ids:
                rank = topic.clip_ids.index(clip.asset_id)
                score += max(0, 3.0 - rank * 0.3)

    # Importance boost (higher for topic segments with high importance)
    score += clip.importance * 0.5
    if clip.is_topic_segment and clip.importance >= 0.7:
        score += 1.0

    return score


def _metadata_to_clip_entries(all_metadata: list[VideoMetadata]) -> list[BrainClipEntry]:
    """Convert video metadata into brain clip entries.

    For long videos (>5 min) with topics, also generates per-topic segment
    entries so the brain can match queries to specific time ranges within
    the video.
    """
    clips: list[BrainClipEntry] = []
    for meta in all_metadata:
        if not meta.scenes and not meta.summary:
            continue

        avg_importance = (
            sum(s.importance for s in meta.scenes) / len(meta.scenes)
            if meta.scenes else 0.5
        )

        # For the parent clip entry, pick representative quotes from
        # high-importance scenes rather than just the first 3 dialogue lines
        key_quotes = _extract_best_quotes(meta)
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

        # For long videos with topics, generate per-topic segment entries
        if meta.duration >= 300 and meta.topics:
            topic_entries = _generate_topic_segment_entries(meta)
            clips.extend(topic_entries)

    return clips


def _extract_best_quotes(meta: VideoMetadata) -> list[str]:
    """Pick up to 5 representative quotes from high-importance scenes."""
    if not meta.dialogue:
        return []

    # Find dialogue lines that overlap with high-importance scenes
    high_importance_ranges: list[tuple[float, float]] = []
    for scene in meta.scenes:
        if scene.importance >= 0.7:
            high_importance_ranges.append((scene.start_time, scene.end_time))

    scored_quotes: list[tuple[float, str, float]] = []
    for dl in meta.dialogue:
        if not dl.text or len(dl.text) < 10:
            continue
        importance = 0.3
        for s_start, s_end in high_importance_ranges:
            if dl.end_time > s_start and dl.start_time < s_end:
                importance = 0.8
                break
        scored_quotes.append((importance, dl.text, dl.start_time))

    scored_quotes.sort(key=lambda x: (-x[0], x[2]))
    return [
        (q[:100] + "..." if len(q) > 100 else q)
        for _, q, _ in scored_quotes[:5]
    ]


def _generate_topic_segment_entries(meta: VideoMetadata) -> list[BrainClipEntry]:
    """Generate per-topic brain entries for a long video.

    Each topic becomes a virtual clip entry with its time ranges,
    scene descriptions, and dialogue quotes from that range.
    """
    entries: list[BrainClipEntry] = []
    for topic in meta.topics:
        if not topic.time_ranges:
            continue

        t_start = min(r[0] for r in topic.time_ranges)
        t_end = max(r[1] for r in topic.time_ranges)
        duration = t_end - t_start

        # Collect scene descriptions within topic range
        scene_descs: list[str] = []
        max_importance = 0.0
        for scene in meta.scenes:
            if scene.end_time > t_start and scene.start_time < t_end:
                if scene.description:
                    scene_descs.append(scene.description)
                max_importance = max(max_importance, scene.importance)

        # Collect key quotes from dialogue within topic range
        topic_quotes: list[str] = []
        for dl in meta.dialogue:
            if dl.end_time > t_start and dl.start_time < t_end and dl.text:
                if len(dl.text) >= 15 and len(topic_quotes) < 3:
                    text = dl.text[:100] + "..." if len(dl.text) > 100 else dl.text
                    topic_quotes.append(text)

        description = topic.description
        if scene_descs:
            description += " | " + " ".join(scene_descs[:3])

        entries.append(BrainClipEntry(
            asset_id=meta.asset_id,
            title=topic.name,
            description=description,
            duration=duration,
            topics=[topic.name],
            has_dialogue=len(topic_quotes) > 0,
            key_quotes=topic_quotes,
            importance=max_importance or 0.5,
            source_in=t_start,
            source_out=t_end,
            is_topic_segment=True,
        ))

    return entries


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


from agent.json_repair import repair_simple_json as _repair_topic_json


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

    max_attempts = 2
    for attempt in range(max_attempts):
        max_tokens = 8192 if attempt > 0 else 4096
        gemini_url = f"{_GEMINI_BASE_URL}/{_GEMINI_MODEL}:generateContent"
        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": max_tokens,
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
                timeout=90,
            )
        except HttpTimeoutError:
            logger.error("Brain topic extraction timed out (attempt %d)", attempt + 1, exc_info=True)
            if attempt < max_attempts - 1:
                time.sleep(5 * (attempt + 1))
            continue
        except Exception:
            logger.error("Brain topic extraction failed (attempt %d)", attempt + 1, exc_info=True)
            if attempt < max_attempts - 1:
                time.sleep(5 * (attempt + 1))
            continue

        if response.status_code != 200:
            logger.error("Brain Gemini error %d: %s", response.status_code, response.text[:300])
            continue

        try:
            body = response.json()
            text = body["candidates"][0]["content"]["parts"][0]["text"]
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                logger.warning(
                    "Brain topic JSON parse failed (attempt %d, %d chars), trying repair...",
                    attempt + 1, len(text),
                )
                repaired = _repair_topic_json(text)
                if repaired and repaired.get("topics"):
                    logger.info("Repaired brain topic JSON: %d topics recovered", len(repaired["topics"]))
                    return repaired
                if attempt < max_attempts - 1:
                    logger.info("Retrying with higher maxOutputTokens...")
                    continue
                logger.error("Brain topic JSON repair failed, raw text: %s", text[:500])
        except Exception:
            logger.error("Failed to parse brain topic response (attempt %d)", attempt + 1, exc_info=True)
            continue

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
            logger.warning("Skipping unparseable topic: %s", t, exc_info=True)

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
        logger.error("Background brain build failed for %s", project_id[:8], exc_info=True)
        with _brain_lock:
            if project_id not in _brains:
                _brains[project_id] = ProjectBrain(
                    project_id=project_id, dirty=True,
                )


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
