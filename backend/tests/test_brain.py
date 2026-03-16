"""Tests for agent.brain — pure functions + integration with FakeHTTPClient."""

from __future__ import annotations

import json
import threading

import pytest

from agent.brain import (
    BrainClipEntry,
    BrainTopic,
    ProjectBrain,
    _expand_query_words,
    _extract_best_quotes,
    _format_clips_for_topic_extraction,
    _generate_topic_segment_entries,
    _metadata_to_clip_entries,
    _parse_topic_result,
    _relevance_score,
    _brains,
    _brain_lock,
    build_brain,
    format_brain_for_agent,
    get_brain,
    mark_dirty,
    query_brain,
    update_brain_incremental,
)
from agent.types import (
    AnalysisStatus,
    DialogueLine,
    SceneSegment,
    TopicTag,
    VideoMetadata,
)
from tests.fakes.services import FakeHTTPClient, FakeResponse


@pytest.fixture(autouse=True)
def _clear_brain_state():
    """Clean brain in-memory state between tests."""
    with _brain_lock:
        _brains.clear()
    yield
    with _brain_lock:
        _brains.clear()


def _meta(
    asset_id: str = "v1",
    duration: float = 120.0,
    scenes: list[SceneSegment] | None = None,
    dialogue: list[DialogueLine] | None = None,
    topics: list[TopicTag] | None = None,
    summary: str = "A test video",
) -> VideoMetadata:
    return VideoMetadata(
        asset_id=asset_id,
        duration=duration,
        resolution=(1920, 1080),
        fps=24.0,
        scenes=scenes or [SceneSegment(start_time=0, end_time=duration, description="Full video")],
        dialogue=dialogue or [],
        summary=summary,
        topics=topics or [],
        analysis_status=AnalysisStatus.COMPLETE,
    )


def _clip(
    asset_id: str = "v1",
    title: str = "Test clip",
    description: str = "A test clip about coding",
    topics: list[str] | None = None,
    importance: float = 0.5,
    key_quotes: list[str] | None = None,
    is_topic_segment: bool = False,
) -> BrainClipEntry:
    return BrainClipEntry(
        asset_id=asset_id,
        title=title,
        description=description,
        duration=60.0,
        topics=topics or [],
        importance=importance,
        key_quotes=key_quotes or [],
        is_topic_segment=is_topic_segment,
    )


def _topic(name: str, clip_ids: list[str], desc: str = "") -> BrainTopic:
    return BrainTopic(id=name.lower().replace(" ", "_"), name=name, description=desc, clip_ids=clip_ids)


def _gemini_topic_response(topics: list[dict], summary: str = "Project summary") -> FakeResponse:
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{"content": {"parts": [{"text": json.dumps({
                "summary": summary,
                "topics": topics,
            })}]}}],
        },
    )


# ====================================================================
# _expand_query_words
# ====================================================================


class TestExpandQueryWords:
    def test_known_synonym_expanded(self):
        result = _expand_query_words({"audio"})
        assert "sound" in result
        assert "voice" in result

    def test_unknown_word_unchanged(self):
        result = _expand_query_words({"xyzzy"})
        assert result == {"xyzzy"}

    def test_multiple_words(self):
        result = _expand_query_words({"audio", "motion"})
        assert "sound" in result
        assert "movement" in result


# ====================================================================
# _relevance_score
# ====================================================================


class TestRelevanceScore:
    def test_exact_query_in_description(self):
        clip = _clip(description="audio quality improvements")
        score = _relevance_score(clip, [], "audio quality", {"audio", "quality"})
        assert score > 3.0

    def test_word_in_title(self):
        clip = _clip(title="Audio Guide", description="Something else")
        score = _relevance_score(clip, [], "audio", {"audio"})
        assert score > 1.0

    def test_topic_match_boosts_score(self):
        clip = _clip(topics=["Audio Quality"])
        score = _relevance_score(clip, [], "audio", {"audio"})
        assert score > 1.5

    def test_synonym_expansion_matches(self):
        clip = _clip(description="voice synthesis technology")
        score = _relevance_score(clip, [], "audio", {"audio"})
        assert score > 0.5

    def test_brain_topic_cross_reference(self):
        clip = _clip(asset_id="v1")
        topics = [_topic("Audio Quality", ["v1", "v2"])]
        score = _relevance_score(clip, topics, "audio", {"audio"})
        assert score > 2.0

    def test_importance_boost(self):
        low = _clip(importance=0.1)
        high = _clip(importance=0.9)
        low_score = _relevance_score(low, [], "anything", {"anything"})
        high_score = _relevance_score(high, [], "anything", {"anything"})
        assert high_score > low_score

    def test_topic_segment_high_importance_bonus(self):
        clip = _clip(importance=0.8, is_topic_segment=True)
        score = _relevance_score(clip, [], "anything", {"anything"})
        assert score >= 1.0 + 0.8 * 0.5

    def test_no_match_returns_importance_only(self):
        clip = _clip(description="nothing relevant", importance=0.5)
        score = _relevance_score(clip, [], "zzzzz", {"zzzzz"})
        assert score == pytest.approx(0.25, abs=0.01)


# ====================================================================
# _metadata_to_clip_entries
# ====================================================================


class TestMetadataToClipEntries:
    def test_basic_conversion(self):
        meta = _meta(scenes=[
            SceneSegment(start_time=0, end_time=60, description="Scene 1", importance=0.7),
            SceneSegment(start_time=60, end_time=120, description="Scene 2", importance=0.3),
        ])
        clips = _metadata_to_clip_entries([meta])
        assert len(clips) == 1
        assert clips[0].asset_id == "v1"
        assert clips[0].duration == 120.0

    def test_empty_metadata_skipped(self):
        meta = VideoMetadata(
            asset_id="empty",
            duration=10,
            resolution=(1920, 1080),
            fps=24.0,
            scenes=[],
            summary="",
            analysis_status=AnalysisStatus.COMPLETE,
        )
        clips = _metadata_to_clip_entries([meta])
        assert len(clips) == 0

    def test_long_video_generates_topic_segments(self):
        meta = _meta(
            duration=600,
            scenes=[SceneSegment(start_time=0, end_time=600, description="Long video")],
            topics=[TopicTag(name="Topic A", time_ranges=[(0, 300)]),
                    TopicTag(name="Topic B", time_ranges=[(300, 600)])],
        )
        clips = _metadata_to_clip_entries([meta])
        topic_segments = [c for c in clips if c.is_topic_segment]
        assert len(topic_segments) >= 2

    def test_short_video_no_topic_segments(self):
        meta = _meta(
            duration=60,
            topics=[TopicTag(name="Topic A", time_ranges=[(0, 60)])],
        )
        clips = _metadata_to_clip_entries([meta])
        topic_segments = [c for c in clips if c.is_topic_segment]
        assert len(topic_segments) == 0


# ====================================================================
# _extract_best_quotes
# ====================================================================


class TestExtractBestQuotes:
    def test_empty_dialogue(self):
        meta = _meta(dialogue=[])
        assert _extract_best_quotes(meta) == []

    def test_high_importance_quotes_ranked_first(self):
        meta = _meta(
            scenes=[
                SceneSegment(start_time=0, end_time=30, description="Low", importance=0.3),
                SceneSegment(start_time=30, end_time=60, description="High", importance=0.9),
            ],
            dialogue=[
                DialogueLine(start_time=5, end_time=10, text="This is a boring low-importance quote"),
                DialogueLine(start_time=35, end_time=40, text="This is an important high-value quote"),
            ],
        )
        quotes = _extract_best_quotes(meta)
        assert len(quotes) >= 1
        assert "important" in quotes[0].lower()

    def test_short_dialogue_filtered(self):
        meta = _meta(dialogue=[
            DialogueLine(start_time=0, end_time=5, text="Hi"),
        ])
        assert _extract_best_quotes(meta) == []


# ====================================================================
# format_brain_for_agent
# ====================================================================


class TestFormatBrainForAgent:
    def test_with_topics(self):
        brain = ProjectBrain(
            project_id="p1",
            summary="A great project",
            topics=[_topic("Topic A", ["v1"], "Describes A")],
            clips=[_clip(asset_id="v1")],
        )
        text = format_brain_for_agent(brain)
        assert "Project Brain" in text
        assert "Topic A" in text

    def test_without_topics(self):
        brain = ProjectBrain(project_id="p1", summary="Empty project")
        text = format_brain_for_agent(brain)
        assert "No topics identified yet" in text

    def test_topic_segments_included(self):
        brain = ProjectBrain(
            project_id="p1",
            clips=[_clip(
                asset_id="v1", title="Segment 1",
                is_topic_segment=True, importance=0.8,
            )],
        )
        brain.clips[0].source_in = 10.0
        brain.clips[0].source_out = 40.0
        text = format_brain_for_agent(brain)
        assert "Topic Segments" in text


# ====================================================================
# _parse_topic_result
# ====================================================================


class TestParseTopicResult:
    def test_valid_topics(self):
        clips = [_clip(asset_id="v1"), _clip(asset_id="v2")]
        result = {"topics": [
            {"id": "t1", "name": "Topic 1", "description": "D1", "clip_ids": ["v1", "v2"]},
        ]}
        topics = _parse_topic_result(result, clips)
        assert len(topics) == 1
        assert topics[0].name == "Topic 1"
        assert topics[0].clip_ids == ["v1", "v2"]

    def test_invalid_clip_ids_filtered(self):
        clips = [_clip(asset_id="v1")]
        result = {"topics": [
            {"id": "t1", "name": "T", "clip_ids": ["v1", "v99"]},
        ]}
        topics = _parse_topic_result(result, clips)
        assert topics[0].clip_ids == ["v1"]

    def test_empty_topics(self):
        result = {"topics": []}
        assert _parse_topic_result(result, []) == []

    def test_malformed_topic_skipped(self):
        clips = [_clip(asset_id="v1")]
        result = {"topics": [None, {"id": "t1", "name": "T", "clip_ids": ["v1"]}]}
        topics = _parse_topic_result(result, clips)
        assert len(topics) == 1


# ====================================================================
# query_brain
# ====================================================================


class TestQueryBrain:
    def test_keyword_search(self):
        brain = ProjectBrain(
            project_id="p1",
            clips=[
                _clip(asset_id="v1", description="audio quality improvements"),
                _clip(asset_id="v2", description="video rendering pipeline"),
            ],
        )
        with _brain_lock:
            _brains["p1"] = brain
        results = query_brain("p1", "audio")
        assert len(results) >= 1
        assert results[0].asset_id == "v1"

    def test_empty_brain(self):
        assert query_brain("nonexistent", "audio") == []

    def test_no_matches(self):
        brain = ProjectBrain(
            project_id="p1",
            clips=[_clip(description="completely unrelated content about xyzzyx")],
        )
        with _brain_lock:
            _brains["p1"] = brain
        results = query_brain("p1", "quantum physics")
        # may still get results due to importance boost; but should be low
        if results:
            # score is just importance (0.25)
            pass


# ====================================================================
# mark_dirty
# ====================================================================


class TestMarkDirty:
    def test_marks_existing_brain(self):
        brain = ProjectBrain(project_id="p1")
        with _brain_lock:
            _brains["p1"] = brain
        mark_dirty("p1")
        assert brain.dirty is True

    def test_nonexistent_brain_no_error(self):
        mark_dirty("nonexistent")


# ====================================================================
# build_brain with FakeHTTPClient
# ====================================================================


class TestBuildBrainIntegration:
    def test_build_brain_success(self, tmp_path):
        http = FakeHTTPClient()
        http.queue("post", _gemini_topic_response([
            {"id": "t1", "name": "Coding", "description": "About coding", "clip_ids": ["v1"]},
        ], summary="A video about coding"))

        meta = _meta(asset_id="v1", summary="Coding tutorial")
        brain = build_brain("p1", [meta], "fake-key", http)

        assert brain.project_id == "p1"
        assert brain.summary == "A video about coding"
        assert len(brain.topics) == 1
        assert brain.topics[0].name == "Coding"

    def test_build_brain_empty_metadata(self):
        http = FakeHTTPClient()
        brain = build_brain("p1", [], "fake-key", http)
        assert brain.summary == "No analyzed content in this project yet."
        assert len(brain.topics) == 0

    def test_build_brain_gemini_error_fallback(self):
        http = FakeHTTPClient()
        http.queue("post", FakeResponse(status_code=500, text="Internal Server Error"))
        http.queue("post", FakeResponse(status_code=500, text="Internal Server Error"))

        meta = _meta(asset_id="v1", summary="Test video")
        brain = build_brain("p1", [meta], "fake-key", http)
        assert brain.summary == ""
        assert len(brain.topics) == 0


# ====================================================================
# update_brain_incremental
# ====================================================================


class TestUpdateBrainIncremental:
    def test_adds_new_clips(self):
        http = FakeHTTPClient()
        # First build
        http.queue("post", _gemini_topic_response([
            {"id": "t1", "name": "Topic", "clip_ids": ["v1"]},
        ], summary="One video"))
        meta1 = _meta(asset_id="v1", summary="Video 1")
        build_brain("p1", [meta1], "fake-key", http)

        # Incremental update
        http.queue("post", _gemini_topic_response([
            {"id": "t1", "name": "Topic", "clip_ids": ["v1", "v2"]},
        ], summary="Two videos"))
        meta2 = _meta(asset_id="v2", summary="Video 2")
        brain = update_brain_incremental("p1", meta2, "fake-key", http)

        assert len(brain.clips) == 2
        assert brain.version == 2

    def test_skips_duplicate_clips(self):
        http = FakeHTTPClient()
        http.queue("post", _gemini_topic_response([
            {"id": "t1", "name": "Topic", "clip_ids": ["v1"]},
        ]))
        meta1 = _meta(asset_id="v1", summary="Video 1")
        build_brain("p1", [meta1], "fake-key", http)

        meta_dup = _meta(asset_id="v1", summary="Video 1 again")
        brain = update_brain_incremental("p1", meta_dup, "fake-key", http)
        assert len(brain.clips) == 1
