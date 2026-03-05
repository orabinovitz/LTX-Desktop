"""End-to-end edit quality pipeline: Whisper STT -> LLM segment selection -> export -> review.

Gives Gemini full editorial freedom to select segments from a long-form interview
transcript, then verifies the result with video review and structural analysis.

Run:
    cd ltx-video/backend
    PYTHONPATH=. .venv/bin/python tests/test_edit_quality.py
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.types import VideoMetadata, DialogueLine
from agent.video_analyzer import _upload_file_to_gemini, whisper_transcribe
from services.http_client.http_client_impl import HTTPClientImpl

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

SETTINGS_FILE = Path.home() / ".ltx-video-studio" / "settings.json"
ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"
ANALYSIS_DIR = Path("/Users/orabinovitz/Projects/LTX-2/ltx-23/.ltx-desktop/analysis/Zeev-Master")
TEST_VIDEO = Path(__file__).resolve().parent.parent.parent / "Test_Assets" / "Zeev-Master.mp4"
OUTPUT_DIR = TEST_VIDEO.parent
WHISPER_CACHE = OUTPUT_DIR / "whisper_transcript.json"


# ---------------------------------------------------------------------------
# API key loaders
# ---------------------------------------------------------------------------

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
        r = subprocess.run(["which", "ffmpeg"], capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
        raise RuntimeError("ffmpeg not found")


def load_metadata() -> VideoMetadata:
    data = json.loads((ANALYSIS_DIR / "metadata.json").read_text(encoding="utf-8"))
    return VideoMetadata.model_validate(data)


# ---------------------------------------------------------------------------
# Whisper transcript with cache
# ---------------------------------------------------------------------------

def get_whisper_transcript(openai_key: str) -> list[DialogueLine]:
    if WHISPER_CACHE.exists():
        data = json.loads(WHISPER_CACHE.read_text(encoding="utf-8"))
        lines = [DialogueLine(**d) for d in data]
        if len(lines) >= 20:
            logger.info("Loaded cached Whisper transcript: %d lines", len(lines))
            return lines

    logger.info("Running Whisper transcription (128kbps/44.1kHz, language=en)...")
    lines = whisper_transcribe(str(TEST_VIDEO), openai_key)

    WHISPER_CACHE.write_text(
        json.dumps(
            [{"start_time": d.start_time, "end_time": d.end_time,
              "speaker": d.speaker, "text": d.text} for d in lines],
            indent=2, ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    logger.info("Whisper transcript cached: %d lines", len(lines))
    return lines


# ---------------------------------------------------------------------------
# Transcript filter
# ---------------------------------------------------------------------------

def filter_transcript(lines: list[DialogueLine]) -> list[DialogueLine]:
    """Remove non-English fragments, hallucinations, and tiny segments."""
    filtered: list[DialogueLine] = []
    prev_text = ""
    repeat_count = 0

    for dl in lines:
        text = dl.text.strip()
        if not text:
            continue

        if dl.end_time - dl.start_time < 2.0:
            continue

        ascii_chars = sum(1 for c in text if ord(c) < 128 and c.isalpha())
        total_alpha = sum(1 for c in text if c.isalpha())
        if total_alpha > 0 and ascii_chars / total_alpha < 0.5:
            continue

        if text == prev_text:
            repeat_count += 1
            if repeat_count >= 2:
                continue
        else:
            repeat_count = 0
        prev_text = text

        filtered.append(dl)

    logger.info("Transcript filter: %d -> %d lines", len(lines), len(filtered))
    return filtered


# ---------------------------------------------------------------------------
# Sentence builder
# ---------------------------------------------------------------------------

def build_sentences(lines: list[DialogueLine], max_gap: float = 2.0) -> list[dict]:
    """Merge consecutive transcript lines into sentences based on punctuation and gaps."""
    if not lines:
        return []

    sentences: list[dict] = []
    current = {"start": lines[0].start_time, "end": lines[0].end_time, "text": lines[0].text}

    for dl in lines[1:]:
        gap = dl.start_time - current["end"]
        ends_sentence = current["text"].rstrip().endswith((".", "!", "?"))

        if gap > max_gap or ends_sentence:
            if len(current["text"].split()) >= 3:
                sentences.append(current)
            current = {"start": dl.start_time, "end": dl.end_time, "text": dl.text}
        else:
            current["end"] = dl.end_time
            current["text"] += " " + dl.text

    if len(current["text"].split()) >= 3:
        sentences.append(current)

    return sentences


# ---------------------------------------------------------------------------
# LLM-driven segment selection
# ---------------------------------------------------------------------------

def llm_select_segments(
    sentences: list[dict],
    topic: str,
    target_duration: float,
    api_key: str,
    http: HTTPClientImpl,
    feedback: dict | None = None,
    struct_feedback: dict | None = None,
) -> list[dict]:
    """Ask Gemini to select segments from the transcript for a short-form edit.

    Returns a list of dicts with keys: start, end, text, reason.
    """
    transcript_lines = "\n".join(
        f"[{i+1}] [{s['start']:.1f}s - {s['end']:.1f}s] ({s['end'] - s['start']:.1f}s) "
        f"{s['text']}"
        for i, s in enumerate(sentences)
    )

    prompt = (
        "You are a world-class professional video editor. Your task: select segments from "
        "this 42-minute interview transcript to create a compelling ~"
        f"{target_duration:.0f}-second short-form edit for Twitter/X.\n\n"
        f"TOPIC: {topic}\n\n"
        "TRANSCRIPT (each line = one sentence with source timestamps):\n"
        f"{transcript_lines}\n\n"
        "YOUR EDITORIAL MANDATE:\n"
        "- Pick 3-6 segments that together tell a tight, self-contained story about the topic\n"
        "- The edit must GRAB attention in the first 2 seconds (no questions, no filler)\n"
        "- Every segment must START on the first word of a sentence (never mid-thought)\n"
        "- Every segment must END on the last word of a sentence (never mid-word)\n"
        "- Use the EXACT start/end timestamps from the transcript -- they are word-level precise\n"
        "- Remove dead air, filler words, and off-topic tangents by choosing clean segments\n"
        "- The edit should flow naturally even though segments may come from different parts\n"
        "- Total duration must be between 30s and 60s\n"
        "- Order the segments to create the best narrative arc (not necessarily chronological)\n"
        "- Prioritize: clear hook -> concrete details -> satisfying conclusion\n"
        "- DO NOT pick segments that start with 'um', 'uh', 'so', 'and', 'but', 'like'\n"
        "- DO NOT pick segments that are questions from an interviewer\n"
        "- PREFER segments that contain specific, concrete information over vague statements\n\n"
    )

    if feedback:
        score = feedback.get("overall_score", 0)
        prompt += (
            f"--- PREVIOUS ATTEMPT SCORED {score}/10 ---\n"
            f"Hook: {feedback.get('hook_quality', '?')}/10, "
            f"Pacing: {feedback.get('pacing_quality', '?')}/10, "
            f"Content: {feedback.get('content_relevance', '?')}/10, "
            f"Closure: {feedback.get('closure_quality', '?')}/10, "
            f"Sentence completeness: {feedback.get('sentence_completeness', '?')}/10, "
            f"Audio continuity: {feedback.get('audio_continuity', '?')}/10\n"
        )
        fb_text = feedback.get("feedback", "")
        if fb_text:
            prompt += f"Reviewer feedback: {fb_text}\n"
        prompt += "Fix ALL issues listed above by choosing DIFFERENT and BETTER segments.\n\n"

    if struct_feedback:
        s_score = struct_feedback.get("structure_score", 0)
        prompt += (
            f"--- STRUCTURE REVIEW SCORED {s_score}/10 ---\n"
            f"Narrative arc: {struct_feedback.get('narrative_arc', '?')}/10, "
            f"Opening: {struct_feedback.get('opening_effectiveness', '?')}/10, "
            f"Closure strength: {struct_feedback.get('closure_strength', '?')}/10, "
            f"Sentence integrity: {struct_feedback.get('sentence_integrity', '?')}/10\n"
        )
        for sfb in struct_feedback.get("structural_feedback", [])[:5]:
            prompt += f"  - {sfb}\n"
        prompt += "Address these structural issues in your new selection.\n\n"

    prompt += (
        "Return ONLY valid JSON: an array of objects, each with:\n"
        '- "start": float (source timestamp in seconds)\n'
        '- "end": float (source timestamp in seconds)\n'
        '- "text": string (the spoken text in this segment)\n'
        '- "reason": string (why you chose this segment and where it fits in the narrative)\n'
        "\nExample: [{\"start\": 120.5, \"end\": 132.0, \"text\": \"The audio...\", "
        "\"reason\": \"Strong opening statement about audio improvements\"}]\n"
    )

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }

    last_err: Exception | None = None
    for attempt in range(3):
        resp = http.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json_payload=payload,
            timeout=180,
        )
        if resp.status_code != 200:
            last_err = RuntimeError(f"Gemini API error {resp.status_code}: {resp.text[:300]}")
            logger.warning("Segment selection attempt %d failed: %s", attempt + 1, last_err)
            continue

        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = _repair_segment_json(text)
            if parsed is None:
                last_err = RuntimeError(f"Unparseable JSON from Gemini (attempt {attempt + 1})")
                logger.warning("JSON parse failed attempt %d, retrying...", attempt + 1)
                continue

        if isinstance(parsed, dict) and "segments" in parsed:
            parsed = parsed["segments"]
        if not isinstance(parsed, list):
            last_err = RuntimeError(f"Expected JSON array, got: {type(parsed)}")
            logger.warning("Wrong JSON shape attempt %d, retrying...", attempt + 1)
            continue

        segments = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            start = float(item.get("start", 0))
            end = float(item.get("end", 0))
            if end > start:
                segments.append({
                    "start": start,
                    "end": end,
                    "text": str(item.get("text", "")),
                    "reason": str(item.get("reason", "")),
                })

        if segments:
            return segments
        last_err = RuntimeError("No valid segments parsed from Gemini response")

    raise last_err or RuntimeError("All segment selection attempts failed")


def _repair_segment_json(text: str) -> list | None:
    """Attempt to extract valid segment objects from truncated JSON."""
    pattern = r'\{\s*"start"\s*:\s*([\d.]+)\s*,\s*"end"\s*:\s*([\d.]+)'
    matches = re.finditer(pattern, text)
    segments = []
    for m in matches:
        start = float(m.group(1))
        end = float(m.group(2))
        text_match = re.search(r'"text"\s*:\s*"([^"]*)"', text[m.start():m.start() + 500])
        reason_match = re.search(r'"reason"\s*:\s*"([^"]*)"', text[m.start():m.start() + 500])
        segments.append({
            "start": start,
            "end": end,
            "text": text_match.group(1) if text_match else "",
            "reason": reason_match.group(1) if reason_match else "",
        })
    return segments if segments else None


# ---------------------------------------------------------------------------
# Segment validation
# ---------------------------------------------------------------------------

def validate_segments(
    segments: list[dict],
    source_duration: float,
    min_seg_dur: float = 2.0,
    max_seg_dur: float = 25.0,
    min_total: float = 25.0,
    max_total: float = 70.0,
) -> list[dict]:
    """Validate and sanitize LLM-returned segments. Returns cleaned list or raises."""
    valid = []
    for s in segments:
        start, end = s["start"], s["end"]
        if end <= start:
            logger.warning("Skipping invalid segment: start=%.1f >= end=%.1f", start, end)
            continue
        dur = end - start
        if dur < min_seg_dur:
            logger.warning("Skipping too-short segment: %.1fs (min %.1fs)", dur, min_seg_dur)
            continue
        if dur > max_seg_dur:
            logger.warning("Skipping too-long segment: %.1fs (max %.1fs)", dur, max_seg_dur)
            continue
        if start < 0:
            s = {**s, "start": 0}
        if end > source_duration:
            s = {**s, "end": source_duration}
        valid.append(s)

    for i in range(len(valid) - 1):
        for j in range(i + 1, len(valid)):
            a, b = valid[i], valid[j]
            overlap = min(a["end"], b["end"]) - max(a["start"], b["start"])
            if overlap > 1.0:
                logger.warning(
                    "Overlapping segments: [%.1f-%.1f] and [%.1f-%.1f] (%.1fs overlap)",
                    a["start"], a["end"], b["start"], b["end"], overlap,
                )

    total = sum(s["end"] - s["start"] for s in valid)
    if total < min_total:
        logger.warning("Total duration %.1fs below minimum %.1fs", total, min_total)
    if total > max_total:
        logger.warning("Total duration %.1fs above maximum %.1fs", total, max_total)

    if not valid:
        raise RuntimeError("No valid segments after validation")

    return valid


# ---------------------------------------------------------------------------
# FFmpeg export
# ---------------------------------------------------------------------------

def export_segments(segments: list[dict], source: Path, output: Path) -> Path:
    """Export segments to a single video file via FFmpeg."""
    ffmpeg = get_ffmpeg()
    segs = [{"in": s["start"], "out": s["end"]} for s in segments if s["end"] > s["start"]]

    if not segs:
        raise RuntimeError("No segments to export")

    logger.info("Exporting %d segments:", len(segs))
    for i, s in enumerate(segs):
        logger.info("  %d: %.2fs-%.2fs (%.2fs)", i + 1, s["in"], s["out"], s["out"] - s["in"])

    with tempfile.TemporaryDirectory() as tmp:
        files: list[str] = []
        for i, s in enumerate(segs):
            sf = os.path.join(tmp, f"s{i:03d}.mp4")
            r = subprocess.run([
                ffmpeg, "-y",
                "-i", str(source),
                "-ss", str(s["in"]),
                "-to", str(s["out"]),
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-avoid_negative_ts", "make_zero",
                "-async", "1",
                sf,
            ], capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                logger.error("FFmpeg seg %d failed: %s", i, r.stderr[:500])
                continue
            files.append(sf)

        if not files:
            raise RuntimeError("All segment extractions failed")

        cl = os.path.join(tmp, "concat.txt")
        with open(cl, "w") as f:
            for sf in files:
                f.write(f"file '{sf}'\n")

        r = subprocess.run([
            ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", cl,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(output),
        ], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise RuntimeError(f"Concat failed: {r.stderr[:500]}")

    logger.info("Exported: %s (%.1f MB)", output.name, output.stat().st_size / 1e6)
    return output


# ---------------------------------------------------------------------------
# Gemini video review
# ---------------------------------------------------------------------------

def review_edit(video_path: Path, api_key: str, http: HTTPClientImpl, topic: str) -> dict:
    file_uri = _upload_file_to_gemini(str(video_path), api_key, http)
    mime = mimetypes.guess_type(str(video_path))[0] or "video/mp4"

    prompt = (
        "You are a brutally critical professional video editor reviewing a short-form "
        "social media edit for Twitter/X. You grade like a harsh film school professor. "
        "5/10 is mediocre garbage. Only 8+ means it genuinely works as social content.\n\n"
        f"Topic: '{topic}'.\n\n"
        "EVALUATION CRITERIA (apply all of these rigorously):\n\n"
        "HOOK (first 2 seconds are everything for social media):\n"
        "- Does the speaker's voice start within 0.5 seconds? If there is silence, "
        "filler, or an interviewer's question at the start, hook = 1-3.\n"
        "- Is the opening line compelling and specific to the topic? Generic = 4-5.\n"
        "- Would a viewer scrolling Twitter stop for this? Be honest.\n\n"
        "PACING (Murch's rhythm criterion):\n"
        "- Are there any gaps of silence longer than 0.3s between speech segments? "
        "Each gap drops pacing by 1 point.\n"
        "- Does the edit feel tight -- like every frame earns its place?\n"
        "- Are cuts motivated by content (new point, emphasis) or arbitrary?\n"
        "- Dead air, mumbling, filler words ('um', 'uh', 'so') at cut points = bad pacing.\n\n"
        "CONTENT RELEVANCE:\n"
        "- Is every single second about the topic? Off-topic tangents = -2 per tangent.\n"
        "- Does the speaker provide specific, concrete information?\n\n"
        "CLOSURE:\n"
        "- Does the edit end on a complete sentence with a conclusive statement?\n"
        "- Ending mid-sentence = 1-3. Trailing off = 4-5. Strong finish = 7+.\n\n"
        "SENTENCE COMPLETENESS (most critical for this review):\n"
        "- Does EVERY clip start at the beginning of a word? Starting mid-syllable = 1.\n"
        "- Does EVERY clip end at the end of a complete sentence or phrase? "
        "Cutting off mid-word or mid-sentence = 1.\n"
        "- Listen carefully to the first 0.5s and last 0.5s of each clip.\n\n"
        "AUDIO CONTINUITY:\n"
        "- Are there jarring audio changes at cut points (volume shifts, room tone changes)?\n"
        "- Does the audio flow feel natural across cuts?\n\n"
        "Return ONLY valid JSON with these fields:\n"
        '- "hook_quality": int 1-10\n'
        '- "pacing_quality": int 1-10\n'
        '- "content_relevance": int 1-10\n'
        '- "closure_quality": int 1-10\n'
        '- "sentence_completeness": int 1-10 (10=all sentences start and end cleanly, 1=words cut off)\n'
        '- "audio_continuity": int 1-10\n'
        '- "silent_gaps": [{"start": float, "end": float}] (timestamps in the exported video)\n'
        '- "irrelevant_sections": [{"start": float, "end": float, "reason": str}]\n'
        '- "overall_score": int 1-10 (weighted: hook 30%, pacing 25%, content 20%, closure 15%, audio 10%)\n'
        '- "duration_seconds": float\n'
        '- "feedback": string with 3-5 specific, actionable improvements. '
        'Name exact timestamps where problems occur.\n'
    )

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [
            {"fileData": {"mimeType": mime, "fileUri": file_uri}},
            {"text": prompt},
        ]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096,
                             "responseMimeType": "application/json"},
    }
    resp = http.post(url, headers={"Content-Type": "application/json",
                                    "x-goog-api-key": api_key},
                     json_payload=payload, timeout=180)
    if resp.status_code != 200:
        return {"overall_score": 0, "feedback": f"API error {resp.status_code}"}

    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        if isinstance(parsed, list) and parsed:
            parsed = parsed[0]
        return parsed if isinstance(parsed, dict) else {"overall_score": 0, "feedback": "bad format"}
    except Exception as e:
        return {"overall_score": 0, "feedback": str(e)}


# ---------------------------------------------------------------------------
# Edit structure verification
# ---------------------------------------------------------------------------

def transcribe_edit(video_path: Path, openai_key: str) -> tuple[str, list[dict]]:
    """Transcribe the exported edit via Whisper and return (full_text, segments)."""
    ffmpeg = get_ffmpeg()
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        audio_path = tmp.name

    try:
        r = subprocess.run([
            ffmpeg, "-y", "-i", str(video_path),
            "-vn", "-acodec", "libmp3lame", "-b:a", "128k",
            "-ar", "44100", "-ac", "1", audio_path,
        ], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"Audio extraction failed: {r.stderr[:500]}")

        import httpx
        with open(audio_path, "rb") as f:
            resp = httpx.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {openai_key}"},
                data={
                    "model": "whisper-1",
                    "language": "en",
                    "response_format": "verbose_json",
                    "timestamp_granularities[]": "segment",
                    "prompt": "Interview about audio and sound improvements for video editing software.",
                },
                files={"file": ("edit.mp3", f, "audio/mpeg")},
                timeout=120,
            )
        if resp.status_code != 200:
            raise RuntimeError(f"Whisper API error {resp.status_code}: {resp.text[:300]}")

        result = resp.json()
        full_text = result.get("text", "").strip()
        segments = [
            {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
            for s in result.get("segments", [])
            if s.get("text", "").strip()
        ]
        logger.info("Transcribed exported edit: %d chars, %d segments", len(full_text), len(segments))
        return full_text, segments
    finally:
        if os.path.exists(audio_path):
            os.unlink(audio_path)


def review_edit_structure(
    transcript: str,
    segments: list[dict],
    topic: str,
    api_key: str,
    http: HTTPClientImpl,
) -> dict:
    """Send transcript to Gemini with a generic editorial structure rubric."""
    segment_text = "\n".join(
        f"[{s['start']:.1f}s - {s['end']:.1f}s] {s['text']}" for s in segments
    )

    prompt = (
        "You are evaluating the NARRATIVE STRUCTURE of an edited video based on its "
        "transcript. This rubric applies universally -- whether the edit is a social "
        "media clip, movie trailer, documentary segment, marketing video, or film scene.\n\n"
        "Every well-structured edit must have:\n"
        "1. SETUP: The viewer immediately understands what they are about to learn/see\n"
        "2. DEVELOPMENT: New information builds on the setup, each beat adds value\n"
        "3. RESOLUTION: The edit reaches a satisfying conclusion or call-to-action\n\n"
        "Evaluate the transcript below against these universal criteria.\n"
        "Do NOT evaluate audio/visual quality -- only narrative structure and content flow.\n\n"
        f"TOPIC OF THE EDIT: {topic}\n\n"
        "FULL TRANSCRIPT:\n"
        f"{transcript}\n\n"
        "TIMESTAMPED SEGMENTS:\n"
        f"{segment_text}\n\n"
        "Score each dimension 1-10 (be harsh -- 5 is mediocre, 8+ is genuinely well-structured):\n\n"
        "Return ONLY valid JSON with these fields:\n"
        '- "narrative_arc": int 1-10 (setup -> development -> resolution structure)\n'
        '- "opening_effectiveness": int 1-10 (first sentence grabs attention, self-contained)\n'
        '- "topic_coherence": int 1-10 (every sentence serves the topic, no tangents)\n'
        '- "transition_quality": int 1-10 (logical flow between segments, motivated cuts)\n'
        '- "closure_strength": int 1-10 (final sentence feels conclusive)\n'
        '- "sentence_integrity": int 1-10 (all sentences grammatically complete, no fragments)\n'
        '- "information_density": int 1-10 (no filler, repetition, or padding)\n'
        '- "structure_score": int 1-10 (overall weighted average)\n'
        '- "story_summary": string (1-2 sentence summary of what the edit communicates)\n'
        '- "segment_analysis": [{\"segment_index\": int, \"text\": str, '
        '\"role_detected\": str, \"issues\": str}] (per-segment breakdown)\n'
        '- "structural_feedback": [str] (3-5 specific actionable improvements)\n'
    )

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }
    resp = http.post(
        url,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json_payload=payload,
        timeout=180,
    )
    if resp.status_code != 200:
        logger.error("Structure review API error %d: %s", resp.status_code, resp.text[:300])
        return {"structure_score": 0, "structural_feedback": [f"API error {resp.status_code}"]}

    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        if isinstance(parsed, list) and parsed:
            parsed = parsed[0]
        return parsed if isinstance(parsed, dict) else {"structure_score": 0}
    except Exception as e:
        logger.error("Structure review parse error: %s", e)
        return {"structure_score": 0, "structural_feedback": [str(e)]}


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def save_review_report(
    video_review: dict,
    structure_review: dict,
    segments: list[dict],
    transcript_text: str,
    transcript_segments: list[dict],
    iteration: int,
    output_dir: Path,
) -> Path:
    """Generate a markdown report combining video review and structure review."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    report_path = output_dir / f"edit_review_v{iteration}.md"

    lines: list[str] = []
    lines.append(f"# Edit Quality Report — Iteration {iteration}")
    lines.append(f"**Generated**: {ts}")
    lines.append(f"**Video**: edit_output_v{iteration}.mp4")
    lines.append("")

    lines.append("## Edit Transcript")
    lines.append("")
    if transcript_segments:
        for seg in transcript_segments:
            lines.append(f"- **[{seg['start']:.1f}s – {seg['end']:.1f}s]** {seg['text']}")
    else:
        lines.append(f"> {transcript_text}")
    lines.append("")

    lines.append("## Quality Scores")
    lines.append("")
    lines.append("| Dimension | Score |")
    lines.append("|-----------|-------|")
    video_fields = [
        ("Hook Quality", "hook_quality"),
        ("Pacing Quality", "pacing_quality"),
        ("Content Relevance", "content_relevance"),
        ("Closure Quality", "closure_quality"),
        ("Sentence Completeness", "sentence_completeness"),
        ("Audio Continuity", "audio_continuity"),
        ("Overall (video review)", "overall_score"),
    ]
    for label, key in video_fields:
        lines.append(f"| {label} | {video_review.get(key, 'N/A')} |")
    lines.append("|---|---|")
    structure_fields = [
        ("Narrative Arc", "narrative_arc"),
        ("Opening Effectiveness", "opening_effectiveness"),
        ("Topic Coherence", "topic_coherence"),
        ("Transition Quality", "transition_quality"),
        ("Closure Strength", "closure_strength"),
        ("Sentence Integrity", "sentence_integrity"),
        ("Information Density", "information_density"),
        ("Structure Score", "structure_score"),
    ]
    for label, key in structure_fields:
        lines.append(f"| {label} | {structure_review.get(key, 'N/A')} |")
    lines.append("")

    lines.append("## Story Summary")
    lines.append("")
    lines.append(f"> {structure_review.get('story_summary', 'N/A')}")
    lines.append("")

    seg_analysis = structure_review.get("segment_analysis", [])
    if seg_analysis:
        lines.append("## Segment Breakdown")
        lines.append("")
        lines.append("| # | Role | Text | Issues |")
        lines.append("|---|------|------|--------|")
        for sa in seg_analysis:
            idx = sa.get("segment_index", "?")
            role = sa.get("role_detected", "?")
            text = sa.get("text", "")[:80]
            issues = sa.get("issues", "none")
            lines.append(f"| {idx} | {role} | {text} | {issues} |")
        lines.append("")

    lines.append("## Source Segments Used")
    lines.append("")
    lines.append("| # | Start | End | Duration | Reason | Text |")
    lines.append("|---|-------|-----|----------|--------|------|")
    for i, seg in enumerate(segments):
        start = seg.get("start", 0)
        end = seg.get("end", 0)
        reason = seg.get("reason", "")[:40]
        text = seg.get("text", "")[:50]
        lines.append(f"| {i+1} | {start:.2f}s | {end:.2f}s | {end-start:.2f}s | {reason} | {text} |")
    lines.append("")

    struct_fb = structure_review.get("structural_feedback", [])
    if struct_fb:
        lines.append("## Structural Recommendations")
        lines.append("")
        for fb in struct_fb:
            lines.append(f"- {fb}")
        lines.append("")

    video_fb = video_review.get("feedback", "")
    if video_fb:
        lines.append("## Video Review Feedback")
        lines.append("")
        lines.append(video_fb)
        lines.append("")

    lines.append("## Raw Scores (JSON)")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps({
        "video_review": {k: video_review.get(k) for k in [
            "hook_quality", "pacing_quality", "content_relevance",
            "closure_quality", "sentence_completeness", "audio_continuity",
            "overall_score", "duration_seconds",
        ]},
        "structure_review": {k: structure_review.get(k) for k in [
            "narrative_arc", "opening_effectiveness", "topic_coherence",
            "transition_quality", "closure_strength", "sentence_integrity",
            "information_density", "structure_score",
        ]},
    }, indent=2))
    lines.append("```")
    lines.append("")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info("Saved review report: %s", report_path.name)
    return report_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    gemini_key = load_gemini_api_key()
    openai_key = load_openai_api_key()
    http = HTTPClientImpl()
    meta = load_metadata()
    topic = "sound/audio improvements in LTX 2.3"

    # --- Step 1: Whisper transcript ---
    raw_transcript = get_whisper_transcript(openai_key)
    logger.info("Raw Whisper: %d lines", len(raw_transcript))

    # --- Step 2: Filter transcript ---
    transcript = filter_transcript(raw_transcript)
    assert len(transcript) >= 10, f"Filtered transcript too short: {len(transcript)}"

    # --- Step 3: Build sentences ---
    sentences = build_sentences(transcript)
    logger.info("Sentences: %d", len(sentences))
    for s in sentences[:5]:
        logger.info("  [%.1fs-%.1fs] %s", s["start"], s["end"], s["text"][:80])

    # --- Step 4: Iterative LLM select -> export -> review loop ---
    max_iter = 5
    best_score = 0
    best_output = None
    last_video_review: dict | None = None
    last_struct_review: dict | None = None

    for it in range(1, max_iter + 1):
        logger.info("=" * 60)
        logger.info("ITERATION %d / %d", it, max_iter)
        logger.info("=" * 60)

        # --- LLM selects segments ---
        logger.info("--- LLM segment selection ---")
        t0 = time.monotonic()
        try:
            raw_segments = llm_select_segments(
                sentences, topic, 45.0, gemini_key, http,
                feedback=last_video_review,
                struct_feedback=last_struct_review,
            )
        except Exception:
            logger.exception("LLM segment selection failed")
            continue
        logger.info("LLM selected %d segments in %.1fs", len(raw_segments), time.monotonic() - t0)
        for i, s in enumerate(raw_segments):
            logger.info("  %d: [%.1fs-%.1fs] (%.1fs) %s",
                         i + 1, s["start"], s["end"], s["end"] - s["start"],
                         s.get("reason", "")[:60])

        # --- Validate segments ---
        try:
            current_segments = validate_segments(raw_segments, meta.duration)
        except RuntimeError:
            logger.exception("Segment validation failed")
            continue

        total_dur = sum(s["end"] - s["start"] for s in current_segments)
        logger.info("Validated: %d segments, %.1fs total", len(current_segments), total_dur)

        # --- Export ---
        logger.info("--- Export ---")
        out = OUTPUT_DIR / f"edit_output_v{it}.mp4"
        try:
            export_segments(current_segments, TEST_VIDEO, out)
        except Exception:
            logger.exception("Export failed")
            continue

        # --- Video review ---
        logger.info("--- Review (video) ---")
        try:
            review = review_edit(out, gemini_key, http, topic)
        except Exception:
            logger.exception("Review failed")
            continue

        last_video_review = review

        logger.info("=== VIDEO REVIEW (iter %d) ===", it)
        for k in ["hook_quality", "pacing_quality", "content_relevance",
                   "closure_quality", "sentence_completeness",
                   "audio_continuity", "overall_score", "duration_seconds"]:
            logger.info("  %s: %s", k, review.get(k, "N/A"))
        if review.get("silent_gaps"):
            logger.info("  Gaps: %s", review["silent_gaps"])
        if review.get("irrelevant_sections"):
            logger.info("  Irrelevant: %s", review["irrelevant_sections"])
        logger.info("  Feedback: %s", review.get("feedback", "N/A"))

        # --- Structure verification ---
        logger.info("--- Structure verification ---")
        struct_review: dict = {}
        edit_transcript = ""
        edit_segments: list[dict] = []
        try:
            edit_transcript, edit_segments = transcribe_edit(out, openai_key)
            struct_review = review_edit_structure(
                edit_transcript, edit_segments, topic, gemini_key, http,
            )
            last_struct_review = struct_review
            logger.info("=== STRUCTURE REVIEW (iter %d) ===", it)
            for k in ["narrative_arc", "opening_effectiveness", "topic_coherence",
                       "transition_quality", "closure_strength", "sentence_integrity",
                       "information_density", "structure_score"]:
                logger.info("  %s: %s", k, struct_review.get(k, "N/A"))
            logger.info("  Story: %s", struct_review.get("story_summary", "N/A"))
            for fb in struct_review.get("structural_feedback", []):
                logger.info("  -> %s", fb)
        except Exception:
            logger.exception("Structure verification failed (non-fatal)")

        # --- Save report ---
        logger.info("--- Saving report ---")
        try:
            save_review_report(
                review, struct_review, current_segments,
                edit_transcript, edit_segments, it, OUTPUT_DIR,
            )
        except Exception:
            logger.exception("Report save failed (non-fatal)")

        # --- Check pass condition ---
        score = review.get("overall_score", 0)
        if score > best_score:
            best_score = score
            best_output = out
            shutil.copy2(out, OUTPUT_DIR / "edit_output.mp4")

        completeness = review.get("sentence_completeness", 0)
        struct_score = struct_review.get("structure_score", 0)
        if score >= 8 and completeness >= 7 and struct_score >= 7:
            logger.info(
                "=== QUALITY PASSED (overall=%d, completeness=%d, structure=%d) ===",
                score, completeness, struct_score,
            )
            break

        logger.warning(
            "Score %d, completeness %d, structure %d — will retry with feedback...",
            score, completeness, struct_score,
        )

    logger.info("=" * 60)
    logger.info("FINAL: best=%d, file=%s", best_score, best_output)
    logger.info("STATUS: %s", "PASS" if best_score >= 8 else f"BEST EFFORT ({best_score})")
    sys.exit(0 if best_score >= 8 else 1)


if __name__ == "__main__":
    main()
