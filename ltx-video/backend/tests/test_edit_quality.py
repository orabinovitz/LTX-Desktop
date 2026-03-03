"""End-to-end edit quality pipeline: agent -> export -> Gemini review.

Uses OpenAI Whisper for accurate speech transcription timestamps, and
Gemini for visual review. Runs iteratively until quality threshold is met.

Run:
    cd ltx-video/backend
    PYTHONPATH=. .venv/bin/python tests/test_edit_quality.py
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import gemini_agent, video_analyzer, brain as brain_module
from agent.types import AgentExecuteRequest, TimelineState, ToolResult, VideoMetadata, DialogueLine
from agent.video_analyzer import _upload_file_to_gemini, whisper_transcribe
from services.http_client.http_client_impl import HTTPClientImpl

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

SETTINGS_FILE = Path.home() / ".ltx-video-studio" / "settings.json"
ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"
ANALYSIS_DIR = Path("/Users/orabinovitz/Projects/LTX-2/ltx-23/.ltx-desktop/analysis/Zeev-Master")
TEST_VIDEO = Path(__file__).resolve().parent.parent.parent / "Test_Assets" / "Zeev-Master.mp4"
OUTPUT_DIR = TEST_VIDEO.parent


def load_gemini_api_key() -> str:
    data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    key = data.get("gemini_api_key", "")
    if not key:
        raise RuntimeError("No gemini_api_key in settings.json")
    return key


def load_openai_api_key() -> str:
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith("OPENAI_API_KEY="):
                val = line.split("=", 1)[1].strip()
                return val.strip('"').strip("'")
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("No OPENAI_API_KEY in .env or environment")
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
# Whisper-based transcript
# ---------------------------------------------------------------------------

_whisper_cache_path = OUTPUT_DIR / "whisper_transcript.json"


def get_whisper_transcript(openai_key: str) -> list[DialogueLine]:
    """Get Whisper transcript, using a disk cache to avoid re-transcribing."""
    if _whisper_cache_path.exists():
        data = json.loads(_whisper_cache_path.read_text(encoding="utf-8"))
        lines = [DialogueLine(**d) for d in data]
        if len(lines) >= 20:
            logger.info("Loaded cached Whisper transcript: %d lines", len(lines))
            return lines

    logger.info("Running Whisper transcription on %s...", TEST_VIDEO.name)
    lines = whisper_transcribe(str(TEST_VIDEO), openai_key)

    cache_data = [
        {"start_time": dl.start_time, "end_time": dl.end_time,
         "speaker": dl.speaker, "text": dl.text}
        for dl in lines
    ]
    _whisper_cache_path.write_text(
        json.dumps(cache_data, indent=2, ensure_ascii=False), encoding="utf-8",
    )
    logger.info("Whisper transcript cached: %d lines", len(lines))
    return lines


# ---------------------------------------------------------------------------
# Keyword-based segment finder
# ---------------------------------------------------------------------------

def find_segments_by_keywords(
    dialogue: list[DialogueLine],
    keywords: list[str],
    min_duration: float = 3.0,
    merge_gap: float = 2.0,
) -> list[dict]:
    """Find transcript segments that mention any of the given keywords.

    Returns a list of {start, end, text} dicts with accurate Whisper timestamps.
    Adjacent matching lines within `merge_gap` seconds are merged into longer segments.
    """
    keywords_lower = [k.lower() for k in keywords]
    matching: list[DialogueLine] = []
    for dl in dialogue:
        text_lower = dl.text.lower()
        if any(kw in text_lower for kw in keywords_lower):
            matching.append(dl)

    if not matching:
        return []

    merged: list[dict] = []
    current = {"start": matching[0].start_time, "end": matching[0].end_time, "text": matching[0].text}

    for dl in matching[1:]:
        if dl.start_time <= current["end"] + merge_gap:
            current["end"] = max(current["end"], dl.end_time)
            current["text"] += " " + dl.text
        else:
            if current["end"] - current["start"] >= min_duration:
                merged.append(current)
            current = {"start": dl.start_time, "end": dl.end_time, "text": dl.text}

    if current["end"] - current["start"] >= min_duration:
        merged.append(current)

    return merged


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
                    result={"currentTime": 0, "trackCount": 6, "tracks": [],
                            "clipCount": len(add_clip_calls), "clips": []},
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
                    tool_name=tc.tool_name, success=True, result={"status": "ok"},
                ))
        response = gemini_agent.continue_with_results(session_id, mock_results, api_key, http_client)
        record(response)

    logger.info("Agent done: %d total tools, %d add_clip calls", len(all_tool_calls), len(add_clip_calls))
    return add_clip_calls


# ---------------------------------------------------------------------------
# Stage 2: Export via ffmpeg
# ---------------------------------------------------------------------------

def export_edit(clips: list[dict], source_video: Path, output_path: Path) -> Path:
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
        raise RuntimeError("No segments with source_in/source_out found")

    seen = set()
    unique = []
    for seg in segments:
        key = (round(seg["source_in"], 1), round(seg["source_out"], 1))
        if key not in seen:
            seen.add(key)
            unique.append(seg)
    segments = unique

    logger.info("Exporting %d segments:", len(segments))
    for i, seg in enumerate(segments):
        logger.info("  Seg %d: %.1fs-%.1fs (%.1fs)",
                     i + 1, seg["source_in"], seg["source_out"],
                     seg["source_out"] - seg["source_in"])

    with tempfile.TemporaryDirectory() as tmpdir:
        seg_files: list[str] = []
        for i, seg in enumerate(segments):
            sf = os.path.join(tmpdir, f"seg_{i:03d}.mp4")
            cmd = [
                ffmpeg, "-y",
                "-ss", str(seg["source_in"]),
                "-to", str(seg["source_out"]),
                "-i", str(source_video),
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-avoid_negative_ts", "make_zero",
                sf,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                logger.error("FFmpeg seg %d failed: %s", i, r.stderr[:400])
                continue
            seg_files.append(sf)

        if not seg_files:
            raise RuntimeError("All ffmpeg segment extractions failed")

        concat_file = os.path.join(tmpdir, "concat.txt")
        with open(concat_file, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")

        cmd = [
            ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concat_file,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", str(output_path),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"FFmpeg concat failed: {r.stderr[:400]}")

    mb = output_path.stat().st_size / (1024 * 1024)
    logger.info("Exported: %s (%.1f MB)", output_path.name, mb)
    return output_path


# ---------------------------------------------------------------------------
# Stage 3: Gemini video review
# ---------------------------------------------------------------------------

def review_edit(
    video_path: Path, api_key: str, http_client: HTTPClientImpl, topic: str,
) -> dict:
    file_uri = _upload_file_to_gemini(str(video_path), api_key, http_client)
    mime = mimetypes.guess_type(str(video_path))[0] or "video/mp4"

    review_prompt = (
        "You are an extremely critical professional video editor reviewing a short-form "
        "social media edit intended for Twitter/X. Be harsh -- 5/10 is mediocre and unusable. "
        "Only give 8+ if the edit genuinely feels professional and ready to post.\n\n"
        f"The intended topic is: '{topic}'.\n\n"
        "Watch the entire video carefully and return a JSON object with:\n"
        '- "hook_quality": int 1-10. First 2s grab attention? '
        "10=compelling speaker quote. 1=silence/interviewer/mumbling.\n"
        '- "pacing_quality": int 1-10. Tight social media pacing? '
        "10=no dead air, punchy cuts. 1=long pauses, filler words.\n"
        '- "content_relevance": int 1-10. Every second on topic? '
        "10=all on topic. 1=off topic.\n"
        '- "closure_quality": int 1-10. Strong ending? '
        "10=conclusive statement. 1=mid-sentence cutoff.\n"
        '- "silent_gaps": array of {"start": float, "end": float}\n'
        '- "irrelevant_sections": array of {"start": float, "end": float, "reason": str}\n'
        '- "overall_score": int 1-10\n'
        '- "duration_seconds": float\n'
        '- "feedback": string, 2-3 sentences of specific improvements.\n'
        "Return ONLY valid JSON."
    )

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [
            {"fileData": {"mimeType": mime, "fileUri": file_uri}},
            {"text": review_prompt},
        ]}],
        "generationConfig": {
            "temperature": 0.3, "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }
    resp = http_client.post(
        url,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json_payload=payload, timeout=120,
    )
    if resp.status_code != 200:
        logger.error("Review failed: %d %s", resp.status_code, resp.text[:300])
        return {"overall_score": 0, "feedback": f"API error {resp.status_code}"}

    body = resp.json()
    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        if isinstance(parsed, list) and parsed:
            parsed = parsed[0]
        if isinstance(parsed, dict):
            return parsed
    except Exception as exc:
        logger.error("Review parse failed: %s", exc)
    return {"overall_score": 0, "feedback": "parse error"}


# ---------------------------------------------------------------------------
# Feedback builder
# ---------------------------------------------------------------------------

def _build_feedback_addendum(review: dict) -> str:
    parts = [
        f"\n\n--- FEEDBACK FROM PREVIOUS ATTEMPT (scored {review.get('overall_score', 0)}/10) ---",
        f"Hook: {review.get('hook_quality', '?')}/10",
        f"Pacing: {review.get('pacing_quality', '?')}/10",
        f"Content: {review.get('content_relevance', '?')}/10",
        f"Closure: {review.get('closure_quality', '?')}/10",
    ]
    if review.get("silent_gaps"):
        parts.append(f"Silent gaps: {review['silent_gaps']}")
    if review.get("irrelevant_sections"):
        for s in review["irrelevant_sections"]:
            parts.append(f"  Off-topic: {s.get('start', '?')}s-{s.get('end', '?')}s -- {s.get('reason', '')}")
    if review.get("feedback"):
        parts.append(f"Reviewer: {review['feedback']}")
    parts.append("FIX ALL of these issues. Do NOT repeat the same mistakes.")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    gemini_key = load_gemini_api_key()
    openai_key = load_openai_api_key()
    http_client = HTTPClientImpl()
    meta = load_metadata()
    topic = "sound/audio improvements in LTX 2.3"

    # --- Step 1: Whisper transcript (accurate timestamps) ---
    transcript = get_whisper_transcript(openai_key)
    assert len(transcript) >= 20, f"Whisper transcript too short: {len(transcript)} lines"
    logger.info("Whisper transcript: %d lines, %.0fs-%.0fs",
                len(transcript), transcript[0].start_time, transcript[-1].end_time)

    # Update metadata with Whisper dialogue
    meta.dialogue = transcript

    # --- Step 2: Find audio-topic segments ---
    # Use brain topic time ranges (from Gemini's English scene descriptions)
    # combined with Whisper's accurate timestamps
    brain_module = __import__("agent.brain", fromlist=["build_brain", "query_brain"])
    brain = brain_module.build_brain("test", [meta], gemini_key, http_client)
    results = brain_module.query_brain("test", "audio sound improvements LTX 2.3")

    topic_segments: list[dict] = []
    if results:
        for entry in results:
            if hasattr(entry, "source_in") and entry.source_in is not None:
                topic_segments.append({
                    "start": entry.source_in,
                    "end": entry.source_out or entry.source_in + 60,
                    "text": entry.description[:200] if entry.description else entry.title,
                })

    # Also add keyword matches from Whisper transcript
    audio_keywords = [
        "audio", "sound", "lip sync", "vocoder", "vae", "voice",
        "music video", "synchroniz", "dynamic range", "2.3",
        "improve", "quality", "metallic", "noise",
    ]
    keyword_segs = find_segments_by_keywords(transcript, audio_keywords)
    for seg in keyword_segs:
        topic_segments.append(seg)

    # Deduplicate overlapping segments
    topic_segments.sort(key=lambda s: s["start"])
    logger.info("Found %d audio-topic segments:", len(topic_segments))
    for seg in topic_segments:
        logger.info("  %.1fs-%.1fs (%.1fs): %s",
                     seg["start"], seg["end"], seg["end"] - seg["start"],
                     seg["text"][:100])

    if not topic_segments:
        logger.error("No audio-topic segments found")
        sys.exit(1)

    timestamp_info = "\n".join(
        f"  - {seg['start']:.1f}s to {seg['end']:.1f}s: \"{seg['text'][:120]}\""
        for seg in topic_segments
    )

    # --- Step 3: Agent iterations ---
    original_model = gemini_agent._GEMINI_MODEL
    gemini_agent._GEMINI_MODEL = "gemini-3-flash-preview"
    logger.info("Agent model: gemini-3-flash-preview (fast iteration)")

    base_prompt = (
        f"Create an estimated 45 seconds edit for Twitter/X about {topic}.\n\n"
        "I have accurate transcript timestamps from Whisper. DO NOT use "
        "query_project_brain or get_transcript_segment -- just add clips directly.\n\n"
        "VERIFIED TIMESTAMPS (accurate to 0.1s):\n"
        f"{timestamp_info}\n\n"
        "INSTRUCTIONS:\n"
        "1. Call add_clip_to_timeline for each segment. Use source_in/source_out "
        "from the timestamps above. Pick 3-5 segments totaling ~45 seconds.\n"
        "2. HOOK: Start with a complete sentence, the speaker's boldest claim.\n"
        "3. CLOSURE: End with a complete, conclusive sentence.\n"
        "4. NEVER start or end mid-sentence.\n"
        "5. NEVER include interviewer speaking (Hebrew interjections).\n"
        "6. Trim source_in/source_out to exclude pauses at start/end of segments.\n\n"
        "The asset_id for the video is in the timeline state."
    )

    max_iterations = 7
    best_score = 0
    best_output = None
    last_review: dict | None = None

    try:
        for iteration in range(1, max_iterations + 1):
            logger.info("=" * 60)
            logger.info("ITERATION %d / %d", iteration, max_iterations)
            logger.info("=" * 60)

            prompt = base_prompt
            if last_review and last_review.get("overall_score", 0) < 8:
                prompt += _build_feedback_addendum(last_review)

            logger.info("--- Stage 1: Agent ---")
            t0 = time.monotonic()
            try:
                clips = run_agent_edit(meta, gemini_key, http_client, prompt)
            except Exception:
                logger.exception("Agent failed")
                continue
            logger.info("Agent: %.1fs, %d clips", time.monotonic() - t0, len(clips))

            if len(clips) < 2:
                logger.warning("< 2 clips, skipping")
                continue

            logger.info("--- Stage 2: Export ---")
            output_path = OUTPUT_DIR / f"edit_output_v{iteration}.mp4"
            try:
                export_edit(clips, TEST_VIDEO, output_path)
            except Exception:
                logger.exception("Export failed")
                continue

            logger.info("--- Stage 3: Review ---")
            try:
                review = review_edit(output_path, gemini_key, http_client, topic)
            except Exception:
                logger.exception("Review failed")
                continue

            last_review = review

            logger.info("=== REVIEW (iter %d) ===", iteration)
            for k in ["hook_quality", "pacing_quality", "content_relevance",
                       "closure_quality", "overall_score", "duration_seconds"]:
                logger.info("  %s: %s", k, review.get(k, "N/A"))
            if review.get("silent_gaps"):
                logger.info("  Silent gaps: %s", review["silent_gaps"])
            if review.get("irrelevant_sections"):
                logger.info("  Irrelevant: %s", review["irrelevant_sections"])
            logger.info("  Feedback: %s", review.get("feedback", "N/A"))

            score = review.get("overall_score", 0)
            if score > best_score:
                best_score = score
                best_output = output_path
                shutil.copy2(output_path, OUTPUT_DIR / "edit_output.mp4")

            if score >= 8:
                logger.info("=== QUALITY PASSED (score=%d) ===", score)
                break
            else:
                logger.warning("Score %d < 8, retrying with feedback...", score)
    finally:
        gemini_agent._GEMINI_MODEL = original_model

    logger.info("=" * 60)
    logger.info("FINAL: best=%d, output=%s", best_score, best_output)
    if best_score >= 8:
        logger.info("STATUS: PASS")
    else:
        logger.warning("STATUS: BEST EFFORT (%d)", best_score)
    sys.exit(0 if best_score >= 8 else 1)


if __name__ == "__main__":
    main()
