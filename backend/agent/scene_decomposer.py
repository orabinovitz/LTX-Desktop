"""Scene decomposer — breaks analyzed video metadata into sub-clip definitions.

Pure logic module with no state, no Gemini calls, and no side effects.
Takes a ``VideoMetadata`` and produces a list of ``SubClipDefinition``
objects that the frontend can turn into virtual sub-clip assets.

Strategy:
  1. If topics exist, use them as the primary decomposition boundaries.
     Scene timestamps are used to snap topic boundaries to clean cuts.
  2. Very long topics are split at internal scene boundaries weighted
     by importance scores.
  3. Gaps before / between / after topics become separate sub-clips.
  4. Falls back to duration-based grouping when no topics are available.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from agent.types import DialogueLine, SceneSegment, VideoMetadata

logger = logging.getLogger(__name__)

_DEFAULT_MIN_DURATION = 5.0    # seconds
_DEFAULT_MAX_DURATION = 300.0  # seconds — topic segments can be long
_SPLIT_THRESHOLD = 300.0       # split topics longer than this


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
    """Decompose a video into sub-clips using topic boundaries.

    When topics are available the decomposition follows semantic
    boundaries.  Falls back to duration-based scene grouping otherwise.
    """
    if not metadata.scenes:
        logger.warning("No scenes in metadata for %s — nothing to decompose", metadata.asset_id)
        return []

    sorted_scenes = sorted(metadata.scenes, key=lambda s: s.start_time)

    if metadata.topics:
        segments = _topic_driven_segments(metadata, sorted_scenes, min_clip_duration)
    else:
        segments = _duration_based_segments(sorted_scenes, min_clip_duration, max_clip_duration)

    subclips: list[SubClipDefinition] = []
    for i, seg in enumerate(segments, 1):
        source_in, source_out, title, topic_names, scenes_in_range = seg
        scene_indices = [sorted_scenes.index(s) for s in scenes_in_range]
        transcript = _extract_transcript(metadata.dialogue, source_in, source_out)
        description = " ".join(s.description for s in scenes_in_range if s.description)

        subclips.append(SubClipDefinition(
            parent_asset_id=metadata.asset_id,
            source_in=round(source_in, 2),
            source_out=round(source_out, 2),
            title=title,
            description=description,
            transcript=transcript,
            topics=topic_names,
            scene_indices=scene_indices,
        ))

    logger.info(
        "Decomposed %s into %d sub-clips (%s) from %d scenes",
        metadata.asset_id, len(subclips),
        "topic-driven" if metadata.topics else "duration-based",
        len(sorted_scenes),
    )
    return subclips


# ------------------------------------------------------------------
# Topic-driven decomposition
# ------------------------------------------------------------------

_Segment = tuple[float, float, str, list[str], list[SceneSegment]]


def _topic_driven_segments(
    metadata: VideoMetadata,
    sorted_scenes: list[SceneSegment],
    min_dur: float,
) -> list[_Segment]:
    """Build segments from topic time ranges, snapping to scene boundaries."""
    topics = sorted(metadata.topics, key=lambda t: t.time_ranges[0][0] if t.time_ranges else 0.0)
    video_start = sorted_scenes[0].start_time
    video_end = sorted_scenes[-1].end_time

    raw_intervals: list[tuple[float, float, str, list[str]]] = []

    for topic in topics:
        if not topic.time_ranges:
            continue
        t_start = min(r[0] for r in topic.time_ranges)
        t_end = max(r[1] for r in topic.time_ranges)
        snapped_start = _snap_to_scene_boundary(t_start, sorted_scenes, prefer="start")
        snapped_end = _snap_to_scene_boundary(t_end, sorted_scenes, prefer="end")
        if snapped_end <= snapped_start:
            continue
        raw_intervals.append((snapped_start, snapped_end, topic.name, [topic.name]))

    if not raw_intervals:
        return _duration_based_segments(sorted_scenes, min_dur, _DEFAULT_MAX_DURATION)

    merged = _merge_overlapping_intervals(raw_intervals)

    segments: list[_Segment] = []

    # Gap before first topic
    first_start = merged[0][0]
    if first_start - video_start >= min_dur:
        gap_scenes = _scenes_in_range(sorted_scenes, video_start, first_start)
        if gap_scenes:
            segments.append((video_start, first_start, "Introduction", [], gap_scenes))

    for idx, (seg_start, seg_end, title, topic_names) in enumerate(merged):
        seg_scenes = _scenes_in_range(sorted_scenes, seg_start, seg_end)
        duration = seg_end - seg_start

        if duration > _SPLIT_THRESHOLD and len(seg_scenes) > 1:
            splits = _split_long_segment(seg_scenes, title, topic_names, _SPLIT_THRESHOLD)
            segments.extend(splits)
        elif seg_scenes:
            segments.append((seg_start, seg_end, title, topic_names, seg_scenes))

        # Gap between this segment and the next
        if idx < len(merged) - 1:
            gap_start = seg_end
            gap_end = merged[idx + 1][0]
            if gap_end - gap_start >= min_dur:
                gap_scenes = _scenes_in_range(sorted_scenes, gap_start, gap_end)
                if gap_scenes:
                    segments.append((gap_start, gap_end, "Transition", [], gap_scenes))

    # Gap after last topic
    last_end = merged[-1][1]
    if video_end - last_end >= min_dur:
        gap_scenes = _scenes_in_range(sorted_scenes, last_end, video_end)
        if gap_scenes:
            segments.append((last_end, video_end, "Closing", [], gap_scenes))

    return segments


def _snap_to_scene_boundary(
    timestamp: float,
    sorted_scenes: list[SceneSegment],
    prefer: str = "start",
) -> float:
    """Find the scene boundary closest to *timestamp*.

    *prefer* = "start" snaps to scene start_time, "end" snaps to end_time.
    """
    best = timestamp
    best_dist = float("inf")
    for scene in sorted_scenes:
        candidates = [scene.start_time, scene.end_time] if prefer == "start" else [scene.end_time, scene.start_time]
        for boundary in candidates:
            dist = abs(boundary - timestamp)
            if dist < best_dist:
                best_dist = dist
                best = boundary
    return best


def _merge_overlapping_intervals(
    intervals: list[tuple[float, float, str, list[str]]],
) -> list[tuple[float, float, str, list[str]]]:
    """Merge overlapping or adjacent intervals, combining titles and topic names."""
    if not intervals:
        return []
    sorted_iv = sorted(intervals, key=lambda x: x[0])
    merged: list[tuple[float, float, str, list[str]]] = [sorted_iv[0]]

    for start, end, title, topics in sorted_iv[1:]:
        prev_start, prev_end, prev_title, prev_topics = merged[-1]
        if start <= prev_end:
            combined_topics = list(dict.fromkeys(prev_topics + topics))
            combined_title = prev_title if prev_title == title else f"{prev_title} / {title}"
            merged[-1] = (prev_start, max(prev_end, end), combined_title, combined_topics)
        else:
            merged.append((start, end, title, topics))

    return merged


def _split_long_segment(
    scenes: list[SceneSegment],
    title: str,
    topic_names: list[str],
    max_dur: float,
) -> list[_Segment]:
    """Split a long segment at the best internal scene boundary.

    Picks the scene boundary with the highest importance contrast (the
    biggest change in importance score between adjacent scenes), which
    tends to mark natural transition points.
    """
    if len(scenes) < 2:
        return [(scenes[0].start_time, scenes[-1].end_time, title, topic_names, scenes)]

    # Find the best split point — prefer boundaries where importance changes most
    best_idx = len(scenes) // 2
    best_score = -1.0
    for i in range(1, len(scenes)):
        elapsed = scenes[i].start_time - scenes[0].start_time
        remaining = scenes[-1].end_time - scenes[i].start_time
        if elapsed < _DEFAULT_MIN_DURATION or remaining < _DEFAULT_MIN_DURATION:
            continue
        contrast = abs(scenes[i].importance - scenes[i - 1].importance)
        if contrast > best_score:
            best_score = contrast
            best_idx = i

    left = scenes[:best_idx]
    right = scenes[best_idx:]

    result: list[_Segment] = []
    for part_idx, part in enumerate([left, right]):
        if not part:
            continue
        part_start = part[0].start_time
        part_end = part[-1].end_time
        suffix = f" (Part {part_idx + 1})" if len([p for p in [left, right] if p]) > 1 else ""
        part_title = f"{title}{suffix}"
        seg: _Segment = (part_start, part_end, part_title, topic_names, part)
        if part_end - part_start > max_dur and len(part) > 1:
            result.extend(_split_long_segment(part, part_title, topic_names, max_dur))
        else:
            result.append(seg)

    return result


def _scenes_in_range(
    sorted_scenes: list[SceneSegment],
    start: float,
    end: float,
) -> list[SceneSegment]:
    """Return scenes that overlap [start, end)."""
    return [s for s in sorted_scenes if s.end_time > start and s.start_time < end]


# ------------------------------------------------------------------
# Duration-based fallback (original algorithm, kept for videos without topics)
# ------------------------------------------------------------------

def _duration_based_segments(
    sorted_scenes: list[SceneSegment],
    min_dur: float,
    max_dur: float,
) -> list[_Segment]:
    """Group adjacent scenes by duration bounds — fallback when no topics exist."""
    groups = _group_scenes_by_duration(sorted_scenes, min_dur, max_dur)
    segments: list[_Segment] = []
    for i, group in enumerate(groups, 1):
        source_in = group[0].start_time
        source_out = group[-1].end_time
        title = _make_title(i, group)
        segments.append((source_in, source_out, title, [], group))
    return segments


def _group_scenes_by_duration(
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

    if len(groups) > 1:
        last = groups[-1]
        last_dur = last[-1].end_time - last[0].start_time
        if last_dur < min_dur:
            groups[-2].extend(groups.pop())

    return groups


# ------------------------------------------------------------------
# Shared helpers
# ------------------------------------------------------------------

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


def _make_title(index: int, scenes: list[SceneSegment]) -> str:
    """Create a short title for a sub-clip group."""
    desc = scenes[0].description
    if len(desc) > 60:
        desc = desc[:57] + "..."
    return f"Scene {index}: {desc}"
