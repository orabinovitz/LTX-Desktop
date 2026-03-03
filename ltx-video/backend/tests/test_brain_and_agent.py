"""Integration tests for brain building and agent multi-clip editing.

Test 1: Build brain from real video metadata, verify query results
Test 2: Run agent with brain context, verify multi-clip output

Requires:
  - Gemini API key in ~/.ltx-video-studio/settings.json
  - Completed analysis for Test_Assets/Zeev-Master.mp4 (or raw metadata files)

Run:
    cd ltx-video/backend
    .venv/bin/python tests/test_brain_and_agent.py
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.brain import (
    build_brain,
    query_brain,
    format_brain_for_agent,
    _metadata_to_clip_entries,
)
from agent.types import VideoMetadata, AnalysisStatus
from services.http_client.http_client_impl import HTTPClientImpl

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

SETTINGS_FILE = Path.home() / ".ltx-video-studio" / "settings.json"
ANALYSIS_DIR = Path("/Users/orabinovitz/Projects/LTX-2/ltx-23/.ltx-desktop/analysis/Zeev-Master")


def load_api_key() -> str:
    data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    key = data.get("gemini_api_key", "")
    if not key:
        raise RuntimeError("No gemini_api_key in settings.json")
    return key


def load_metadata() -> VideoMetadata:
    """Load the Zeev-Master metadata from the project analysis folder."""
    meta_file = ANALYSIS_DIR / "metadata.json"
    if not meta_file.exists():
        raise RuntimeError(f"Metadata not found: {meta_file}")
    data = json.loads(meta_file.read_text(encoding="utf-8"))
    meta = VideoMetadata.model_validate(data)
    logger.info(
        "Loaded metadata: asset=%s, duration=%.0fs, scenes=%d, dialogue=%d, topics=%d",
        meta.asset_id, meta.duration, len(meta.scenes), len(meta.dialogue), len(meta.topics),
    )
    return meta


def test_brain_build_and_query():
    """Test 1: Build brain from metadata, verify query results."""
    logger.info("=" * 60)
    logger.info("TEST 1: Brain build and query")
    logger.info("=" * 60)

    api_key = load_api_key()
    http_client = HTTPClientImpl()
    meta = load_metadata()

    # Step 1: Build clip entries (no Gemini call needed)
    clip_entries = _metadata_to_clip_entries([meta])
    logger.info("Clip entries generated: %d total", len(clip_entries))

    topic_segments = [c for c in clip_entries if c.is_topic_segment]
    regular_clips = [c for c in clip_entries if not c.is_topic_segment]
    logger.info("  Regular clips: %d", len(regular_clips))
    logger.info("  Topic segments: %d", len(topic_segments))

    for seg in topic_segments:
        logger.info(
            "  Topic: '%s' [%.0fs-%.0fs] importance=%.1f quotes=%d",
            seg.title, seg.source_in or 0, seg.source_out or 0,
            seg.importance, len(seg.key_quotes),
        )

    # Step 2: Build brain (makes one Gemini call)
    logger.info("Building brain...")
    t0 = time.monotonic()
    brain = build_brain("test-project", [meta], api_key, http_client)
    elapsed = time.monotonic() - t0
    logger.info("Brain built in %.1fs: %d clips, %d topics", elapsed, len(brain.clips), len(brain.topics))
    logger.info("Summary: %s", brain.summary[:200] if brain.summary else "(empty)")

    # Step 3: Query for sound improvements
    logger.info("\nQuerying brain for 'sound improvements'...")
    results = query_brain("test-project", "sound improvements")
    logger.info("Query returned %d results", len(results))
    for r in results[:5]:
        logger.info(
            "  [%.1f] '%s' (asset=%s, source=%.0fs-%.0fs, topics=%s)",
            r.importance, r.title[:60], r.asset_id[:12],
            r.source_in or 0, r.source_out or 0,
            r.topics,
        )

    # Step 4: Query for "audio quality"
    logger.info("\nQuerying brain for 'audio quality'...")
    results2 = query_brain("test-project", "audio quality")
    logger.info("Query returned %d results", len(results2))
    for r in results2[:5]:
        logger.info(
            "  [%.1f] '%s' (source=%.0fs-%.0fs)",
            r.importance, r.title[:60], r.source_in or 0, r.source_out or 0,
        )

    # Step 5: Check brain format
    brain_text = format_brain_for_agent(brain)
    logger.info("\nBrain agent context (%d chars):", len(brain_text))
    for line in brain_text.split("\n")[:20]:
        logger.info("  %s", line)

    # Assertions
    errors: list[str] = []

    if len(topic_segments) == 0:
        errors.append("FAIL: No topic segments generated from metadata")

    tech_topics = [s for s in topic_segments if "technical" in s.title.lower() or "improvement" in s.title.lower()]
    if not tech_topics:
        errors.append("FAIL: No 'Technical Improvements' topic segment found")

    if len(results) == 0:
        errors.append("FAIL: query_brain('sound improvements') returned 0 results")

    sound_in_range = [r for r in results if r.source_in and 400 <= r.source_in <= 1100]
    if not sound_in_range:
        errors.append("FAIL: No results in 400-1100s range for 'sound improvements'")

    if "Topic Segments" not in brain_text:
        errors.append("FAIL: Brain format missing 'Topic Segments' section")

    if errors:
        logger.error("=== TEST 1 FAILED ===")
        for e in errors:
            logger.error(e)
        return False
    else:
        logger.info("=== TEST 1 PASSED ===")
        return True


def test_agent_multiclip():
    """Test 2: Run agent and verify multi-clip tool calls."""
    from agent import gemini_agent, video_analyzer, brain as brain_module
    from agent.types import AgentExecuteRequest, TimelineState

    logger.info("=" * 60)
    logger.info("TEST 2: Agent multi-clip edit")
    logger.info("=" * 60)

    api_key = load_api_key()
    http_client = HTTPClientImpl()
    meta = load_metadata()

    # Inject metadata into video_analyzer cache so brain can build
    video_analyzer._metadata_cache[meta.asset_id] = meta

    # Build brain (ensures it's available for the agent)
    logger.info("Building brain for agent test...")
    brain = brain_module.build_brain("test-agent-project", [meta], api_key, http_client)
    logger.info("Brain: %d clips, %d topics", len(brain.clips), len(brain.topics))

    # Create agent request
    request = AgentExecuteRequest(
        prompt=(
            "Create an estimated 45 seconds edit talking about the new sound "
            "updates coming to 2.3. This is for Twitter - make it snappy with "
            "a good hook. Use multiple segments from the source video."
        ),
        timeline_state=TimelineState(clips=[], track_count=6, total_duration=0, playhead_time=0),
        project_id="test-agent-project",
    )

    # Run agent
    logger.info("Executing agent prompt...")
    t0 = time.monotonic()
    session_id, response = gemini_agent.execute_prompt(request, api_key, http_client)
    elapsed = time.monotonic() - t0
    logger.info("Agent first response in %.1fs (done=%s, tools=%d)", elapsed, response.done, len(response.tool_calls))

    # Track all tool calls across the session
    all_tool_calls: list[dict] = []
    add_clip_calls: list[dict] = []
    max_rounds = 15

    def record_tools(resp):
        for tc in resp.tool_calls:
            call = {"tool": tc.tool_name, "args": tc.arguments}
            all_tool_calls.append(call)
            if tc.tool_name == "add_clip_to_timeline":
                add_clip_calls.append(call)
            logger.info("  Tool: %s(%s)", tc.tool_name, {k: v for k, v in tc.arguments.items() if k != "result"})

    record_tools(response)

    # Simulate frontend tool execution loop
    round_num = 0
    while not response.done and round_num < max_rounds:
        round_num += 1
        # Build mock results for frontend tools
        from agent.types import ToolResult
        mock_results = []
        for tc in response.tool_calls:
            if tc.tool_name == "get_timeline_state":
                result_data = {
                    "currentTime": 0, "trackCount": 6,
                    "tracks": [{"index": i, "id": f"track-{i}", "name": f"Track {i+1}", "kind": "video" if i < 3 else "audio"} for i in range(6)],
                    "clipCount": len(add_clip_calls),
                    "clips": [],
                }
                mock_results.append(ToolResult(tool_name=tc.tool_name, success=True, result=result_data))
            elif tc.tool_name == "get_project_assets":
                result_data = {
                    "assetCount": 1,
                    "assets": [{
                        "id": meta.asset_id, "type": "video", "prompt": "Zeev Master Interview",
                        "duration": meta.duration, "resolution": list(meta.resolution),
                        "path": "/test/Zeev-Master.mp4", "favorite": False, "bin": None,
                        "parentAssetId": None, "sourceIn": None, "sourceOut": None, "topics": [],
                    }],
                }
                mock_results.append(ToolResult(tool_name=tc.tool_name, success=True, result=result_data))
            else:
                mock_results.append(ToolResult(
                    tool_name=tc.tool_name, success=True,
                    result={"status": "ok", "message": f"{tc.tool_name} executed"},
                ))

        logger.info("Round %d: continuing with %d results...", round_num, len(mock_results))
        response = gemini_agent.continue_with_results(session_id, mock_results, api_key, http_client)
        logger.info("  Response: done=%s, tools=%d, text=%d chars", response.done, len(response.tool_calls), len(response.message))
        record_tools(response)

    # Results
    logger.info("\n=== AGENT RESULTS ===")
    logger.info("Total tool calls: %d", len(all_tool_calls))
    logger.info("add_clip_to_timeline calls: %d", len(add_clip_calls))

    total_clip_duration = 0.0
    for i, call in enumerate(add_clip_calls):
        args = call["args"]
        src_in = args.get("source_in", 0)
        src_out = args.get("source_out", 0)
        dur = (src_out - src_in) if src_in and src_out else 0
        total_clip_duration += dur
        logger.info(
            "  Clip %d: asset=%s, source_in=%.0f, source_out=%.0f (%.0fs)",
            i + 1, str(args.get("asset_id", ""))[:12], src_in or 0, src_out or 0, dur,
        )

    logger.info("Total clip duration: %.0fs", total_clip_duration)
    if response.message:
        logger.info("Agent message: %s", response.message[:300])

    # Assertions
    errors: list[str] = []

    if len(add_clip_calls) < 2:
        errors.append(f"FAIL: Expected >= 2 add_clip_to_timeline calls, got {len(add_clip_calls)}")

    clips_with_source = [c for c in add_clip_calls if c["args"].get("source_in") and c["args"].get("source_out")]
    if len(clips_with_source) < 2:
        errors.append(f"FAIL: Expected >= 2 clips with source_in/source_out, got {len(clips_with_source)}")

    if errors:
        logger.error("=== TEST 2 FAILED ===")
        for e in errors:
            logger.error(e)
        return False
    else:
        logger.info("=== TEST 2 PASSED ===")
        return True


def main():
    passed = 0
    failed = 0

    if test_brain_build_and_query():
        passed += 1
    else:
        failed += 1

    if test_agent_multiclip():
        passed += 1
    else:
        failed += 1

    logger.info("\n=== FINAL: %d passed, %d failed ===", passed, failed)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
