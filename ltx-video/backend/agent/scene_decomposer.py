"""Scene decomposer — breaks analyzed video metadata into sub-clip definitions.

Pure logic module with no state, no Gemini calls, and no side effects.
Takes a ``VideoMetadata`` and produces a list of ``SubClipDefinition``
objects that the frontend can turn into virtual sub-clip assets.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from agent.types import DialogueLine, SceneSegment, VideoMetadata

logger = logging.getLogger(__name__)

_DEFAULT_MIN_DURATION = 5.0   # seconds
_DEFAULT_MAX_DURATION = 120.0  # seconds


@dataclass
class SubClipDefinition:
    """A virtual sub-clip carved from a parent video."""

    parent_asset_id: str
    source_in: float
    source_out: float
    title: str
    description: str
    transcript: str
    topics: list[str] = field(default_factory=list)
    scene_indices: list[int] = field(default_factory=list)


def decompose_to_scenes(
    metadata: VideoMetadata,
    min_clip_duration: float = _DEFAULT_MIN_DURATION,
    max_clip_duration: float = _DEFAULT_MAX_DURATION,
) -> list[SubClipDefinition]:
    """Group adjacent scenes into logical sub-clips.

    Adjacent scenes are merged when the combined duration stays under
    *max_clip_duration*. Very short scenes are always merged with their
    neighbour so no sub-clip is shorter than *min_clip_duration*.

    Each sub-clip receives:
    - A title derived from the first scene's description
    - A combined description of all scenes it covers
    - The transcript (dialogue lines) that fall within its time range
    - Topic tags extracted from the video metadata
    """
    if not metadata.scenes:
        logger.warning("No scenes in metadata for %s — nothing to decompose", metadata.asset_id)
        return []

    sorted_scenes = sorted(metadata.scenes, key=lambda s: s.start_time)
    groups = _group_scenes(sorted_scenes, min_clip_duration, max_clip_duration)

    subclips: list[SubClipDefinition] = []
    for i, group in enumerate(groups, 1):
        source_in = group[0].start_time
        source_out = group[-1].end_time
        scene_indices = [sorted_scenes.index(s) for s in group]

        transcript = _extract_transcript(metadata.dialogue, source_in, source_out)
        topics = _extract_topics_for_range(metadata, source_in, source_out)
        description = " ".join(s.description for s in group if s.description)
        title = _make_title(i, group)

        subclips.append(SubClipDefinition(
            parent_asset_id=metadata.asset_id,
            source_in=round(source_in, 2),
            source_out=round(source_out, 2),
            title=title,
            description=description,
            transcript=transcript,
            topics=topics,
            scene_indices=scene_indices,
        ))

    logger.info(
        "Decomposed %s into %d sub-clips from %d scenes",
        metadata.asset_id, len(subclips), len(sorted_scenes),
    )
    return subclips


def _group_scenes(
    scenes: list[SceneSegment],
    min_dur: float,
    max_dur: float,
) -> list[list[SceneSegment]]:
    """Merge adjacent scenes into groups respecting duration bounds."""
    if not scenes:
        return []

    groups: list[list[SceneSegment]] = [[scenes[0]]]

    for scene in scenes[1:]:
        current_group = groups[-1]
        group_start = current_group[0].start_time
        group_end = scene.end_time
        combined_duration = group_end - group_start

        current_duration = current_group[-1].end_time - group_start

        if current_duration < min_dur or combined_duration <= max_dur:
            current_group.append(scene)
        else:
            groups.append([scene])

    # Post-pass: merge trailing short groups into the previous one
    if len(groups) > 1:
        last = groups[-1]
        last_dur = last[-1].end_time - last[0].start_time
        if last_dur < min_dur:
            groups[-2].extend(groups.pop())

    return groups


def _extract_transcript(
    dialogue: list[DialogueLine],
    start: float,
    end: float,
) -> str:
    """Collect dialogue text that overlaps with the given time range."""
    lines = []
    for dl in dialogue:
        if dl.end_time > start and dl.start_time < end:
            prefix = f"[{dl.speaker}] " if dl.speaker else ""
            lines.append(f"{prefix}{dl.text}")
    return " ".join(lines)


def _extract_topics_for_range(
    metadata: VideoMetadata,
    start: float,
    end: float,
) -> list[str]:
    """Return topic names whose time ranges overlap [start, end]."""
    topics: list[str] = []
    for topic in metadata.topics:
        for tr_start, tr_end in topic.time_ranges:
            if tr_end > start and tr_start < end:
                topics.append(topic.name)
                break
    return topics


def _make_title(index: int, scenes: list[SceneSegment]) -> str:
    """Create a short title for a sub-clip group."""
    desc = scenes[0].description
    if len(desc) > 60:
        desc = desc[:57] + "..."
    return f"Scene {index}: {desc}"
