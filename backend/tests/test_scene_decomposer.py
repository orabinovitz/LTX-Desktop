"""Tests for agent.scene_decomposer — pure logic, no I/O."""

from agent.scene_decomposer import (
    SubClipDefinition,
    decompose_to_scenes,
    _duration_based_segments,
    _extract_transcript,
    _group_scenes_by_duration,
    _make_title,
    _merge_overlapping_intervals,
    _scenes_in_range,
    _snap_to_scene_boundary,
    _split_long_segment,
)
from agent.types import (
    AnalysisStatus,
    DialogueLine,
    SceneSegment,
    TopicTag,
    VideoMetadata,
)


def _scene(start: float, end: float, desc: str = "", importance: float = 0.5) -> SceneSegment:
    return SceneSegment(start_time=start, end_time=end, description=desc, importance=importance)


def _topic(name: str, ranges: list[tuple[float, float]], desc: str = "") -> TopicTag:
    return TopicTag(name=name, description=desc, time_ranges=ranges)


def _dialogue(start: float, end: float, text: str, speaker: str = "") -> DialogueLine:
    return DialogueLine(start_time=start, end_time=end, text=text, speaker=speaker)


def _metadata(
    scenes: list[SceneSegment],
    topics: list[TopicTag] | None = None,
    dialogue: list[DialogueLine] | None = None,
    duration: float = 60.0,
    asset_id: str = "asset-1",
) -> VideoMetadata:
    return VideoMetadata(
        asset_id=asset_id,
        duration=duration,
        resolution=(1920, 1080),
        fps=24.0,
        scenes=scenes,
        topics=topics or [],
        dialogue=dialogue or [],
        analysis_status=AnalysisStatus.COMPLETE,
    )


# ------------------------------------------------------------------
# decompose_to_scenes — top-level
# ------------------------------------------------------------------


class TestDecomposeToScenes:
    def test_empty_scenes_returns_empty(self):
        meta = _metadata(scenes=[])
        assert decompose_to_scenes(meta) == []

    def test_single_scene_no_topics(self):
        meta = _metadata(scenes=[_scene(0, 30, "Opening shot")])
        result = decompose_to_scenes(meta)
        assert len(result) == 1
        assert result[0].parent_asset_id == "asset-1"
        assert result[0].source_in == 0.0
        assert result[0].source_out == 30.0

    def test_multiple_scenes_no_topics_grouped_by_duration(self):
        scenes = [_scene(i * 10, (i + 1) * 10, f"Scene {i}") for i in range(6)]
        meta = _metadata(scenes=scenes, duration=60.0)
        result = decompose_to_scenes(meta)
        assert len(result) >= 1
        for clip in result:
            assert clip.parent_asset_id == "asset-1"
            assert clip.source_out > clip.source_in

    def test_with_topics_uses_topic_driven(self):
        scenes = [_scene(0, 20, "Intro"), _scene(20, 50, "Main"), _scene(50, 60, "Outro")]
        topics = [_topic("Main Topic", [(20, 50)])]
        meta = _metadata(scenes=scenes, topics=topics, duration=60.0)
        result = decompose_to_scenes(meta)
        assert len(result) >= 1
        topic_clip = [c for c in result if "Main Topic" in c.topics]
        assert len(topic_clip) >= 1

    def test_transcript_extracted(self):
        scenes = [_scene(0, 30, "Interview")]
        dialogue = [_dialogue(5, 10, "Hello world", speaker="Alice")]
        meta = _metadata(scenes=scenes, dialogue=dialogue, duration=30.0)
        result = decompose_to_scenes(meta)
        assert len(result) >= 1
        assert "Hello world" in result[0].transcript

    def test_transcript_with_speaker_prefix(self):
        scenes = [_scene(0, 30, "Interview")]
        dialogue = [_dialogue(5, 10, "Hello", speaker="Bob")]
        meta = _metadata(scenes=scenes, dialogue=dialogue, duration=30.0)
        result = decompose_to_scenes(meta)
        assert "[Bob]" in result[0].transcript


# ------------------------------------------------------------------
# _snap_to_scene_boundary
# ------------------------------------------------------------------


class TestSnapToSceneBoundary:
    def test_snaps_to_nearest_start(self):
        scenes = [_scene(0, 10), _scene(10, 20), _scene(20, 30)]
        assert _snap_to_scene_boundary(11.0, scenes, prefer="start") == 10.0

    def test_snaps_to_nearest_end(self):
        scenes = [_scene(0, 10), _scene(10, 20)]
        assert _snap_to_scene_boundary(9.5, scenes, prefer="end") == 10.0

    def test_exact_match(self):
        scenes = [_scene(0, 10), _scene(10, 20)]
        assert _snap_to_scene_boundary(10.0, scenes, prefer="start") == 10.0


# ------------------------------------------------------------------
# _merge_overlapping_intervals
# ------------------------------------------------------------------


class TestMergeOverlappingIntervals:
    def test_no_overlap(self):
        intervals = [(0, 10, "A", ["a"]), (20, 30, "B", ["b"])]
        result = _merge_overlapping_intervals(intervals)
        assert len(result) == 2

    def test_overlapping_merged(self):
        intervals = [(0, 15, "A", ["a"]), (10, 25, "B", ["b"])]
        result = _merge_overlapping_intervals(intervals)
        assert len(result) == 1
        assert result[0][0] == 0
        assert result[0][1] == 25
        assert "a" in result[0][3]
        assert "b" in result[0][3]

    def test_adjacent_not_merged(self):
        intervals = [(0, 10, "A", ["a"]), (10.1, 20, "B", ["b"])]
        result = _merge_overlapping_intervals(intervals)
        assert len(result) == 2

    def test_empty_input(self):
        assert _merge_overlapping_intervals([]) == []

    def test_combined_title(self):
        intervals = [(0, 15, "A", ["a"]), (10, 25, "B", ["b"])]
        result = _merge_overlapping_intervals(intervals)
        assert "A" in result[0][2]
        assert "B" in result[0][2]


# ------------------------------------------------------------------
# _scenes_in_range
# ------------------------------------------------------------------


class TestScenesInRange:
    def test_overlapping_scenes_returned(self):
        scenes = [_scene(0, 10), _scene(10, 20), _scene(20, 30)]
        result = _scenes_in_range(scenes, 5, 15)
        assert len(result) == 2

    def test_non_overlapping_excluded(self):
        scenes = [_scene(0, 10), _scene(20, 30)]
        result = _scenes_in_range(scenes, 10, 20)
        assert len(result) == 0

    def test_exact_boundary_excluded(self):
        scenes = [_scene(0, 10), _scene(10, 20)]
        result = _scenes_in_range(scenes, 10, 20)
        assert len(result) == 1
        assert result[0].start_time == 10


# ------------------------------------------------------------------
# _extract_transcript
# ------------------------------------------------------------------


class TestExtractTranscript:
    def test_dialogue_in_range(self):
        dialogue = [_dialogue(5, 10, "Yes"), _dialogue(15, 20, "No")]
        assert "Yes" in _extract_transcript(dialogue, 0, 12)
        assert "No" not in _extract_transcript(dialogue, 0, 12)

    def test_empty_dialogue(self):
        assert _extract_transcript([], 0, 30) == ""

    def test_speaker_prefix(self):
        dialogue = [_dialogue(5, 10, "Hello", speaker="Alice")]
        result = _extract_transcript(dialogue, 0, 30)
        assert "[Alice] Hello" in result


# ------------------------------------------------------------------
# _group_scenes_by_duration
# ------------------------------------------------------------------


class TestGroupScenesByDuration:
    def test_empty_scenes(self):
        assert _group_scenes_by_duration([], 5.0, 300.0) == []

    def test_single_scene(self):
        scenes = [_scene(0, 10)]
        groups = _group_scenes_by_duration(scenes, 5.0, 300.0)
        assert len(groups) == 1
        assert len(groups[0]) == 1

    def test_short_scenes_merged_to_meet_minimum(self):
        scenes = [_scene(0, 2, "A"), _scene(2, 4, "B"), _scene(4, 10, "C")]
        groups = _group_scenes_by_duration(scenes, 5.0, 300.0)
        assert len(groups) == 1

    def test_long_scenes_split_at_max(self):
        scenes = [_scene(i * 100, (i + 1) * 100, f"S{i}") for i in range(5)]
        groups = _group_scenes_by_duration(scenes, 5.0, 200.0)
        assert len(groups) >= 2

    def test_last_group_merged_if_too_short(self):
        scenes = [_scene(0, 10, "A"), _scene(10, 20, "B"), _scene(20, 22, "C")]
        groups = _group_scenes_by_duration(scenes, 5.0, 15.0)
        last_group = groups[-1]
        last_dur = last_group[-1].end_time - last_group[0].start_time
        assert last_dur >= 2.0


# ------------------------------------------------------------------
# _make_title
# ------------------------------------------------------------------


class TestMakeTitle:
    def test_short_description(self):
        scenes = [_scene(0, 10, "A cat sitting")]
        title = _make_title(1, scenes)
        assert title == "Scene 1: A cat sitting"

    def test_long_description_truncated(self):
        scenes = [_scene(0, 10, "A" * 100)]
        title = _make_title(2, scenes)
        assert len(title) <= 70
        assert title.endswith("...")


# ------------------------------------------------------------------
# _split_long_segment
# ------------------------------------------------------------------


class TestSplitLongSegment:
    def test_single_scene_not_split(self):
        scenes = [_scene(0, 400, "Long scene")]
        result = _split_long_segment(scenes, "Title", ["topic"], 300.0)
        assert len(result) == 1

    def test_multiple_scenes_split(self):
        scenes = [
            _scene(0, 100, "A", importance=0.3),
            _scene(100, 200, "B", importance=0.8),
            _scene(200, 350, "C", importance=0.4),
        ]
        result = _split_long_segment(scenes, "Title", ["topic"], 300.0)
        assert len(result) >= 2
        for seg in result:
            assert len(seg[4]) >= 1
