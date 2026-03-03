"""End-to-end edit quality pipeline: agent -> export -> Gemini review.

Runs the agentic editor against the Zeev-Master video, exports the edit
via ffmpeg, uploads to Gemini for quality review, and asserts the edit
meets professional standards.

Run:
    cd ltx-video/backend
    .venv/bin/python tests/test_edit_quality.py
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import gemini_agent, video_analyzer, brain as brain_module
from agent.types import AgentExecuteRequest, TimelineState, ToolResult, VideoMetadata
from agent.video_analyzer import _upload_file_to_gemini
from services.http_client.http_client_impl import HTTPClientImpl

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

SETTINGS_FILE = Path.home() / ".ltx-video-studio" / "settings.json"
ANALYSIS_DIR = Path("/Users/orabinovitz/Projects/LTX-2/ltx-23/.ltx-desktop/analysis/Zeev-Master")
TEST_VIDEO = Path(__file__).resolve().parent.parent.parent / "Test_Assets" / "Zeev-Master.mp4"
OUTPUT_DIR = TEST_VIDEO.parent


def load_api_key() -> str:
    data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    key = data.get("gemini_api_key", "")
    if not key:
        raise RuntimeError("No gemini_api_key in settings.json")
    return key


def get_ffmpeg() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        result = subprocess.run(["which", "ffmpeg"], capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.strip()
        raise RuntimeError("ffmpeg not found")


def load_metadata() -> VideoMetadata:
    meta_file = ANALYSIS_DIR / "metadata.json"
    data = json.loads(meta_file.read_text(encoding="utf-8"))
    return VideoMetadata.model_validate(data)


# ---------------------------------------------------------------------------
# Stage 1: Run the agent and collect tool calls
# ---------------------------------------------------------------------------

def run_agent_edit(
    meta: VideoMetadata, api_key: str, http_client: HTTPClientImpl,
    prompt: str,
) -> list[dict]:
    """Run the agent and return all add_clip_to_timeline calls."""
    video_analyzer._metadata_cache[meta.asset_id] = meta
    brain = brain_module.build_brain("edit-test", [meta], api_key, http_client)
    logger.info("Brain built: %d clips, %d topics", len(brain.clips), len(brain.topics))

    request = AgentExecuteRequest(
        prompt=prompt,
        timeline_state=TimelineState(clips=[], track_count=6, total_duration=0, playhead_time=0),
        project_id="edit-test",
    )

    session_id, response = gemini_agent.execute_prompt(request, api_key, http_client)
    all_tool_calls: list[dict] = []
    add_clip_calls: list[dict] = []

    def record(resp):
        for tc in resp.tool_calls:
            call = {"tool": tc.tool_name, "args": tc.arguments}
            all_tool_calls.append(call)
            if tc.tool_name == "add_clip_to_timeline":
                add_clip_calls.append(call)

    record(response)

    max_rounds = 15
    round_num = 0
    while not response.done and round_num < max_rounds:
        round_num += 1
        mock_results = []
        for tc in response.tool_calls:
            if tc.tool_name == "get_timeline_state":
                mock_results.append(ToolResult(
                    tool_name=tc.tool_name, success=True,
                    result={"currentTime": 0, "trackCount": 6, "tracks": [], "clipCount": len(add_clip_calls), "clips": []},
                ))
            elif tc.tool_name == "get_project_assets":
                mock_results.append(ToolResult(
                    tool_name=tc.tool_name, success=True,
                    result={"assetCount": 1, "assets": [{
                        "id": meta.asset_id, "type": "video", "duration": meta.duration,
                        "resolution": list(meta.resolution), "path": str(TEST_VIDEO),
                        "parentAssetId": None, "sourceIn": None, "sourceOut": None, "topics": [],
                    }]},
                ))
            else:
                mock_results.append(ToolResult(
                    tool_name=tc.tool_name, success=True,
                    result={"status": "ok"},
                ))
        response = gemini_agent.continue_with_results(session_id, mock_results, api_key, http_client)
        record(response)

    logger.info("Agent done: %d total tools, %d add_clip calls", len(all_tool_calls), len(add_clip_calls))
    return add_clip_calls


# ---------------------------------------------------------------------------
# Stage 2: Export via ffmpeg
# ---------------------------------------------------------------------------

def export_edit(
    clips: list[dict], source_video: Path, output_path: Path,
) -> Path:
    """Extract segments and concatenate into a single video."""
    ffmpeg = get_ffmpeg()
    segments: list[dict] = []

    for clip in clips:
        args = clip["args"]
        src_in = args.get("source_in")
        src_out = args.get("source_out")
        if src_in is not None and src_out is not None and src_out > src_in:
            segments.append({"source_in": float(src_in), "source_out": float(src_out)})

    if not segments:
        raise RuntimeError("No segments with source_in/source_out found in clip calls")

    # Deduplicate segments with same source_in/source_out
    seen = set()
    unique_segments = []
    for seg in segments:
        key = (round(seg["source_in"], 1), round(seg["source_out"], 1))
        if key not in seen:
            seen.add(key)
            unique_segments.append(seg)
    segments = unique_segments

    segments.sort(key=lambda s: s["source_in"])
    logger.info("Exporting %d segments:", len(segments))
    for i, seg in enumerate(segments):
        logger.info("  Segment %d: %.1fs - %.1fs (%.1fs)", i + 1, seg["source_in"], seg["source_out"], seg["source_out"] - seg["source_in"])

    with tempfile.TemporaryDirectory() as tmpdir:
        segment_files: list[str] = []
        for i, seg in enumerate(segments):
            seg_file = os.path.join(tmpdir, f"seg_{i:03d}.mp4")
            cmd = [
                ffmpeg, "-y",
                "-ss", str(seg["source_in"]),
                "-to", str(seg["source_out"]),
                "-i", str(source_video),
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-avoid_negative_ts", "make_zero",
                seg_file,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                logger.error("FFmpeg segment %d failed: %s", i, result.stderr[:500])
                continue
            segment_files.append(seg_file)

        if not segment_files:
            raise RuntimeError("All ffmpeg segment extractions failed")

        concat_file = os.path.join(tmpdir, "concat.txt")
        with open(concat_file, "w") as f:
            for sf in segment_files:
                f.write(f"file '{sf}'\n")

        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0",
            "-i", concat_file,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            str(output_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg concat failed: {result.stderr[:500]}")

    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    logger.info("Exported edit: %s (%.1f MB)", output_path.name, file_size_mb)
    return output_path


# ---------------------------------------------------------------------------
# Stage 3: Gemini video review
# ---------------------------------------------------------------------------

def review_edit(
    video_path: Path, api_key: str, http_client: HTTPClientImpl,
    topic: str,
) -> dict:
    """Upload the exported edit to Gemini and get a structured quality review."""
    logger.info("Uploading edit for Gemini review...")
    file_uri = _upload_file_to_gemini(str(video_path), api_key, http_client)
    mime_type = mimetypes.guess_type(str(video_path))[0] or "video/mp4"

    review_prompt = (
        "You are a professional video editor reviewing a short-form social media edit. "
        f"The intended topic is: '{topic}'. "
        "Watch the entire video carefully and return a JSON object with these fields:\n\n"
        '- "hook_quality": integer 1-10. Does the video grab attention in the first 3 seconds? '
        "10 = instantly compelling opening quote/moment. 1 = starts with silence/pause/irrelevant content.\n"
        '- "pacing_quality": integer 1-10. Is the pacing tight and energetic? '
        "10 = no dead air, punchy cuts, good rhythm. 1 = long pauses, slow, boring.\n"
        '- "content_relevance": integer 1-10. Does the content match the topic? '
        "10 = every second is about the topic. 1 = completely off-topic.\n"
        '- "closure_quality": integer 1-10. Does the video end well? '
        "10 = strong conclusive statement. 1 = cuts off mid-sentence or fades to nothing.\n"
        '- "silent_gaps": array of {"start": float, "end": float} for any silence > 1 second.\n'
        '- "irrelevant_sections": array of {"start": float, "end": float, "reason": string} '
        "for parts not about the topic.\n"
        '- "overall_score": integer 1-10. Overall edit quality for social media.\n'
        '- "duration_seconds": float. Estimated total duration.\n'
        '- "feedback": string. 2-3 sentences of specific improvement suggestions.\n\n'
        "Return ONLY valid JSON."
    )

    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-3-flash-preview:generateContent"
    )

    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"fileData": {"mimeType": mime_type, "fileUri": file_uri}},
                {"text": review_prompt},
            ],
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    response = http_client.post(
        gemini_url,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json_payload=payload,
        timeout=120,
    )

    if response.status_code != 200:
        logger.error("Gemini review failed: %d %s", response.status_code, response.text[:300])
        return {"overall_score": 0, "feedback": f"API error {response.status_code}"}

    body = response.json()
    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except Exception as exc:
        logger.error("Failed to parse review JSON: %s", exc)
        return {"overall_score": 0, "feedback": str(exc)}


# ---------------------------------------------------------------------------
# Main: iterative quality loop
# ---------------------------------------------------------------------------

def main():
    api_key = load_api_key()
    http_client = HTTPClientImpl()
    meta = load_metadata()

    prompt = (
        "Create an estimated 45 seconds edit talking about the new sound "
        "updates coming to 2.3. This is for Twitter - make it snappy with "
        "a good hook at the start and a strong closure at the end. "
        "Use multiple segments from the source video. No silent parts."
    )
    topic = "sound/audio improvements in LTX 2.3"

    max_iterations = 3
    best_score = 0
    best_output = None

    for iteration in range(1, max_iterations + 1):
        logger.info("=" * 60)
        logger.info("ITERATION %d / %d", iteration, max_iterations)
        logger.info("=" * 60)

        # Stage 1: Run agent
        logger.info("--- Stage 1: Running agent ---")
        t0 = time.monotonic()
        try:
            clips = run_agent_edit(meta, api_key, http_client, prompt)
        except Exception:
            logger.exception("Agent failed")
            continue
        logger.info("Agent completed in %.1fs, %d clips", time.monotonic() - t0, len(clips))

        if len(clips) < 2:
            logger.warning("Agent produced < 2 clips, skipping export")
            continue

        # Stage 2: Export
        logger.info("--- Stage 2: Exporting via ffmpeg ---")
        output_path = OUTPUT_DIR / f"edit_output_v{iteration}.mp4"
        try:
            export_edit(clips, TEST_VIDEO, output_path)
        except Exception:
            logger.exception("Export failed")
            continue

        # Stage 3: Review
        logger.info("--- Stage 3: Gemini review ---")
        try:
            review = review_edit(output_path, api_key, http_client, topic)
        except Exception:
            logger.exception("Review failed")
            continue

        # Log results
        logger.info("=== REVIEW RESULTS (iteration %d) ===", iteration)
        for key in ["hook_quality", "pacing_quality", "content_relevance", "closure_quality", "overall_score", "duration_seconds"]:
            logger.info("  %s: %s", key, review.get(key, "N/A"))
        if review.get("silent_gaps"):
            logger.info("  Silent gaps: %s", review["silent_gaps"])
        if review.get("irrelevant_sections"):
            logger.info("  Irrelevant: %s", review["irrelevant_sections"])
        logger.info("  Feedback: %s", review.get("feedback", "N/A"))

        score = review.get("overall_score", 0)
        if score > best_score:
            best_score = score
            best_output = output_path
            if best_score < score:
                final_path = OUTPUT_DIR / "edit_output.mp4"
                import shutil
                shutil.copy2(output_path, final_path)

        if score >= 6:
            logger.info("=== QUALITY PASSED (score=%d) ===", score)
            final_path = OUTPUT_DIR / "edit_output.mp4"
            import shutil
            shutil.copy2(output_path, final_path)
            logger.info("Final edit saved: %s", final_path)
            break
        else:
            logger.warning("Score %d < 6, will retry...", score)

    # Final summary
    logger.info("=" * 60)
    logger.info("FINAL SUMMARY")
    logger.info("  Best score: %d", best_score)
    logger.info("  Best output: %s", best_output)
    if best_score >= 6:
        logger.info("  STATUS: PASS")
    else:
        logger.warning("  STATUS: BEST EFFORT (score %d)", best_score)
        if best_output:
            final_path = OUTPUT_DIR / "edit_output.mp4"
            import shutil
            shutil.copy2(best_output, final_path)
            logger.info("  Saved best attempt: %s", final_path)

    sys.exit(0 if best_score >= 6 else 1)


if __name__ == "__main__":
    main()
