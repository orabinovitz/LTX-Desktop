"""End-to-end edit quality pipeline: Whisper STT -> segment selection -> agent -> export -> review.

Uses OpenAI Whisper for speech transcription (English, high-quality audio),
three-part segment selection (hook/body/closure) for editorial structure,
and Gemini for iterative review with segment refinement.

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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import gemini_agent, video_analyzer, brain as brain_module
from agent.types import (
    AgentExecuteRequest, TimelineState, ToolResult, VideoMetadata, DialogueLine,
)
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

AUDIO_KEYWORDS = [
    "audio", "sound", "lip sync", "lip-sync", "vocoder", "vae",
    "voice", "music video", "synchroniz", "dynamic range",
    "quality of the audio", "treatment of audio", "improve",
]

_FILLER_STARTS = frozenset(("um", "uh", "so", "like", "and", "but", "or", "well", "yeah", "i mean"))


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
# FIX-1: Three-part segment selection (hook / body / closure)
# ---------------------------------------------------------------------------

def _base_score(s: dict, keywords: list[str]) -> float:
    """Keyword relevance + boundary quality score for a sentence."""
    text_lower = s["text"].lower()
    kw = sum(2.0 for k in keywords if k in text_lower)
    if kw == 0:
        return 0.0

    dur = s["end"] - s["start"]
    d = 1.0 if 4 <= dur <= 15 else (0.6 if dur < 4 else 0.4)

    word_count = len(s["text"].split())
    richness = min(word_count / 10, 1.5)

    return kw * d * richness


def _is_question(s: dict) -> bool:
    return s["text"].rstrip().endswith("?") and len(s["text"].split()) < 15


def _has_clean_start(s: dict) -> bool:
    if not s["text"] or not s["text"][0].isupper():
        return False
    first_word = s["text"].split()[0].lower()
    return first_word not in _FILLER_STARTS


def _has_clean_end(s: dict) -> bool:
    return s["text"].rstrip()[-1:] in ".!?"


def select_hook(sentences: list[dict], keywords: list[str],
                exclude_ids: set[int] | None = None) -> dict | None:
    """Pick the single most compelling opening sentence from the entire transcript.

    Hook criteria (per video-editing-techniques / Murch priority 1-2):
    - Must be the speaker answering, never the interviewer asking.
    - Must start with a strong declarative (capital letter, no filler word).
    - Prefer short, punchy sentences (5-10s) -- attention grab in first 2s.
    - Highest keyword density wins.
    """
    if exclude_ids is None:
        exclude_ids = set()

    best: dict | None = None
    best_score = 0.0

    for i, s in enumerate(sentences):
        if i in exclude_ids:
            continue
        if _is_question(s):
            continue

        base = _base_score(s, keywords)
        if base <= 0:
            continue

        hook_mult = 1.0

        if _has_clean_start(s):
            hook_mult *= 2.5
        else:
            hook_mult *= 0.2

        dur = s["end"] - s["start"]
        if 5 <= dur <= 12:
            hook_mult *= 1.5
        elif dur < 5:
            hook_mult *= 0.8
        else:
            hook_mult *= 0.5

        if _has_clean_end(s):
            hook_mult *= 1.3

        total = base * hook_mult
        if total > best_score:
            best_score = total
            best = {**s, "score": total, "role": "hook", "_idx": i}

    return best


def select_body_segments(
    sentences: list[dict],
    keywords: list[str],
    hook: dict | None,
    closure: dict | None,
    target_body_duration: float = 30.0,
    min_spacing: float = 25.0,
) -> list[dict]:
    """Select 2-4 on-topic body sentences, avoiding hook/closure and enforcing spacing."""
    exclude_ids: set[int] = set()
    if hook and "_idx" in hook:
        exclude_ids.add(hook["_idx"])
    if closure and "_idx" in closure:
        exclude_ids.add(closure["_idx"])

    scored: list[tuple[float, int, dict]] = []
    for i, s in enumerate(sentences):
        if i in exclude_ids or _is_question(s):
            continue
        base = _base_score(s, keywords)
        if base <= 0:
            continue

        body_mult = 1.0
        if _has_clean_start(s):
            body_mult *= 1.3
        if _has_clean_end(s):
            body_mult *= 1.3

        scored.append((base * body_mult, i, s))

    scored.sort(key=lambda x: -x[0])

    selected: list[dict] = []
    used_times: list[float] = []
    total = 0.0

    for sc, idx, s in scored:
        dur = s["end"] - s["start"]
        if total + dur > target_body_duration * 1.2:
            continue

        too_close = any(abs(s["start"] - t) < min_spacing for t in used_times)
        if too_close:
            continue

        selected.append({**s, "score": sc, "role": "body", "_idx": idx})
        used_times.append(s["start"])
        total += dur
        if len(selected) >= 4 or total >= target_body_duration:
            break

    selected.sort(key=lambda x: x["start"])
    return selected


def select_closure(
    sentences: list[dict],
    keywords: list[str],
    exclude_ids: set[int] | None = None,
) -> dict | None:
    """Pick the strongest closing sentence: must end with . or !, on-topic, conclusive."""
    if exclude_ids is None:
        exclude_ids = set()

    best: dict | None = None
    best_score = 0.0

    conclusive_words = ["overall", "finally", "so that", "and that", "which means",
                        "the result", "we've", "we have", "it's going to", "this is"]

    for i, s in enumerate(sentences):
        if i in exclude_ids or _is_question(s):
            continue
        if not _has_clean_end(s):
            continue

        base = _base_score(s, keywords)
        if base <= 0:
            continue

        closure_mult = 1.0
        text_lower = s["text"].lower()
        if any(cw in text_lower for cw in conclusive_words):
            closure_mult *= 1.8

        if _has_clean_start(s):
            closure_mult *= 1.3

        dur = s["end"] - s["start"]
        if 5 <= dur <= 15:
            closure_mult *= 1.2

        total = base * closure_mult
        if total > best_score:
            best_score = total
            best = {**s, "score": total, "role": "closure", "_idx": i}

    return best


def compose_edit(
    hook: dict | None,
    body: list[dict],
    closure: dict | None,
    target_duration: float = 45.0,
) -> list[dict]:
    """Assemble hook + body + closure into a time-ordered segment list.

    Validates duration is 25-60s and deduplicates overlaps.
    """
    parts: list[dict] = []
    used_indices: set[int] = set()

    for seg in ([hook] if hook else []) + body + ([closure] if closure else []):
        if seg is None:
            continue
        idx = seg.get("_idx", -1)
        if idx in used_indices:
            continue
        used_indices.add(idx)
        parts.append(seg)

    parts.sort(key=lambda s: s["start"])

    total = sum(s["end"] - s["start"] for s in parts)
    if total < 25:
        logger.warning("Edit too short: %.1fs -- may need more body segments", total)
    elif total > 60:
        logger.warning("Edit too long: %.1fs -- trimming weakest body segments", total)
        while total > 60 and len(parts) > 2:
            body_parts = [p for p in parts if p.get("role") == "body"]
            if not body_parts:
                break
            weakest = min(body_parts, key=lambda p: p.get("score", 0))
            parts.remove(weakest)
            total = sum(s["end"] - s["start"] for s in parts)

    logger.info("Composed edit: %d segments, %.1fs total", len(parts), total)
    for p in parts:
        logger.info("  [%s] %.1fs-%.1fs (%.1fs): %s",
                     p.get("role", "?"), p["start"], p["end"],
                     p["end"] - p["start"], p["text"][:80])

    return parts


# ---------------------------------------------------------------------------
# FIX-4: Segment refinement based on review feedback
# ---------------------------------------------------------------------------

def refine_segments(
    segments: list[dict],
    review: dict,
    sentences: list[dict],
    keywords: list[str],
    attempt: int,
) -> list[dict]:
    """Refine segments based on Gemini review scores.

    On each iteration, make targeted replacements for the weakest dimension.
    Returns a new segment list (may be identical if no improvement found).
    """
    hook_score = review.get("hook_quality", 10)
    pacing_score = review.get("pacing_quality", 10)
    closure_score = review.get("closure_quality", 10)
    silent_gaps = review.get("silent_gaps", [])

    used_ids = {s.get("_idx", -1) for s in segments}
    refined = list(segments)

    if hook_score < 6 and refined:
        logger.info("Refine: hook scored %d, replacing...", hook_score)
        new_hook = select_hook(sentences, keywords, exclude_ids=used_ids)
        if new_hook:
            old_hook_indices = [i for i, s in enumerate(refined) if s.get("role") == "hook"]
            if old_hook_indices:
                old = refined[old_hook_indices[0]]
                used_ids.discard(old.get("_idx", -1))
                refined[old_hook_indices[0]] = new_hook
                used_ids.add(new_hook["_idx"])
                logger.info("  Replaced hook: %.1fs -> %.1fs", old["start"], new_hook["start"])
            else:
                refined.insert(0, new_hook)
                used_ids.add(new_hook["_idx"])

    if closure_score < 6 and refined:
        logger.info("Refine: closure scored %d, replacing...", closure_score)
        new_closure = select_closure(sentences, keywords, exclude_ids=used_ids)
        if new_closure:
            old_closure_indices = [i for i, s in enumerate(refined) if s.get("role") == "closure"]
            if old_closure_indices:
                old = refined[old_closure_indices[0]]
                used_ids.discard(old.get("_idx", -1))
                refined[old_closure_indices[0]] = new_closure
                used_ids.add(new_closure["_idx"])
                logger.info("  Replaced closure: %.1fs -> %.1fs", old["start"], new_closure["start"])

    if pacing_score < 6 and silent_gaps:
        logger.info("Refine: pacing scored %d with %d gaps, tightening...", pacing_score, len(silent_gaps))
        for gap in silent_gaps:
            gap_start = gap.get("start", 0)
            gap_end = gap.get("end", 0)
            if gap_end - gap_start < 0.2:
                continue
            for i, seg in enumerate(refined):
                seg_dur_in_edit = seg["end"] - seg["start"]
                relative_start = gap_start
                if relative_start < 1.0 and seg_dur_in_edit > 3:
                    refined[i] = {**seg, "start": seg["start"] + min(gap_end, 1.0)}
                    logger.info("  Trimmed start of seg %d by %.1fs", i, min(gap_end, 1.0))
                    break

    refined.sort(key=lambda s: s["start"])

    total = sum(s["end"] - s["start"] for s in refined)
    while total > 55 and len(refined) > 2:
        body_parts = [p for p in refined if p.get("role") == "body"]
        if not body_parts:
            break
        weakest = min(body_parts, key=lambda p: p.get("score", 0))
        refined.remove(weakest)
        total = sum(s["end"] - s["start"] for s in refined)

    return refined


# ---------------------------------------------------------------------------
# Agent runner
# ---------------------------------------------------------------------------

def run_agent_edit(
    meta: VideoMetadata, api_key: str, http_client: HTTPClientImpl, prompt: str,
) -> list[dict]:
    video_analyzer._metadata_cache[meta.asset_id] = meta
    brain = brain_module.build_brain("edit-test", [meta], api_key, http_client)
    logger.info("Brain: %d clips, %d topics", len(brain.clips), len(brain.topics))

    request = AgentExecuteRequest(
        prompt=prompt,
        timeline_state=TimelineState(clips=[], track_count=6, total_duration=0, playhead_time=0),
        project_id="edit-test",
    )

    session_id, response = gemini_agent.execute_prompt(request, api_key, http_client)
    all_tools: list[dict] = []
    add_clips: list[dict] = []

    def record(resp):
        for tc in resp.tool_calls:
            call = {"tool": tc.tool_name, "args": tc.arguments}
            all_tools.append(call)
            if tc.tool_name == "add_clip_to_timeline":
                add_clips.append(call)

    record(response)

    for _ in range(15):
        if response.done:
            break
        mocks = []
        for tc in response.tool_calls:
            if tc.tool_name == "get_timeline_state":
                mocks.append(ToolResult(tool_name=tc.tool_name, success=True,
                    result={"currentTime": 0, "trackCount": 6, "tracks": [],
                            "clipCount": len(add_clips), "clips": []}))
            elif tc.tool_name == "get_project_assets":
                mocks.append(ToolResult(tool_name=tc.tool_name, success=True,
                    result={"assetCount": 1, "assets": [{
                        "id": meta.asset_id, "type": "video", "duration": meta.duration,
                        "resolution": list(meta.resolution), "path": str(TEST_VIDEO),
                        "parentAssetId": None, "sourceIn": None, "sourceOut": None, "topics": [],
                    }]}))
            else:
                mocks.append(ToolResult(tool_name=tc.tool_name, success=True,
                    result={"status": "ok"}))
        response = gemini_agent.continue_with_results(session_id, mocks, api_key, http_client)
        record(response)

    logger.info("Agent: %d tools, %d add_clip calls", len(all_tools), len(add_clips))
    return add_clips


# ---------------------------------------------------------------------------
# FIX-3: FFmpeg export with output-seeking for frame accuracy
# ---------------------------------------------------------------------------

def export_edit(clips: list[dict], source: Path, output: Path) -> Path:
    ffmpeg = get_ffmpeg()
    segs: list[dict] = []
    for c in clips:
        a = c["args"]
        si, so = a.get("source_in"), a.get("source_out")
        if si is not None and so is not None and so > si:
            segs.append({"in": float(si), "out": float(so)})

    if not segs:
        raise RuntimeError("No segments with source_in/source_out")

    seen: set[tuple[float, float]] = set()
    unique: list[dict] = []
    for s in segs:
        key = (round(s["in"], 1), round(s["out"], 1))
        if key not in seen:
            seen.add(key)
            unique.append(s)
    segs = unique

    logger.info("Exporting %d segments (output-seeking for frame accuracy):", len(segs))
    for i, s in enumerate(segs):
        logger.info("  %d: %.1fs-%.1fs (%.1fs)", i + 1, s["in"], s["out"], s["out"] - s["in"])

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
# FIX-5: Gemini review with video-editing-techniques criteria
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
        "AUDIO CONTINUITY:\n"
        "- Are there jarring audio changes at cut points (volume shifts, room tone changes)?\n"
        "- Does the audio flow feel natural across cuts?\n\n"
        "Return ONLY valid JSON with these fields:\n"
        '- "hook_quality": int 1-10\n'
        '- "pacing_quality": int 1-10\n'
        '- "content_relevance": int 1-10\n'
        '- "closure_quality": int 1-10\n'
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
# FIX-4: Actionable feedback builder
# ---------------------------------------------------------------------------

def build_feedback(review: dict) -> str:
    parts = [
        f"\n\n--- PREVIOUS ATTEMPT SCORED {review.get('overall_score', 0)}/10 ---",
        f"Hook: {review.get('hook_quality', '?')}/10",
        f"Pacing: {review.get('pacing_quality', '?')}/10",
        f"Content: {review.get('content_relevance', '?')}/10",
        f"Closure: {review.get('closure_quality', '?')}/10",
        f"Audio: {review.get('audio_continuity', '?')}/10",
    ]

    if review.get("feedback"):
        parts.append(f"Reviewer feedback: {review['feedback']}")

    gaps = review.get("silent_gaps", [])
    if gaps:
        gap_str = ", ".join(f"{g.get('start', 0):.1f}s-{g.get('end', 0):.1f}s" for g in gaps[:5])
        parts.append(f"Silent gaps detected at: {gap_str}")
        parts.append("ACTION: Tighten source_in on segments that start with silence.")

    irr = review.get("irrelevant_sections", [])
    if irr:
        for sec in irr[:3]:
            parts.append(f"Off-topic at {sec.get('start', 0):.1f}s-{sec.get('end', 0):.1f}s: {sec.get('reason', '?')}")

    hook_q = review.get("hook_quality", 10)
    if hook_q < 6:
        parts.append(f"CRITICAL: Hook scored {hook_q}/10. The first segment was REPLACED with a stronger opening.")

    parts.append("Apply these fixes. The segments below have been updated based on this feedback.")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# FIX-2: Agent prompt with editorial judgment
# ---------------------------------------------------------------------------

def build_agent_prompt(topic: str, segments: list[dict]) -> str:
    ts_info = "\n".join(
        f"  {i+1}. [{s.get('role', 'body').upper()}] {s['start']:.1f}s to {s['end']:.1f}s: "
        f"\"{s['text'][:120]}\""
        for i, s in enumerate(segments)
    )

    return (
        f"Create a ~45 second edit for Twitter/X about {topic}.\n\n"
        "I have pre-selected the best segments with verified Whisper timestamps.\n"
        "Each segment is labeled with its editorial role: HOOK, BODY, or CLOSURE.\n\n"
        f"SEGMENTS:\n{ts_info}\n\n"
        "INSTRUCTIONS:\n"
        "1. Call add_clip_to_timeline for EACH segment above, in order.\n"
        "2. The FIRST segment is the HOOK. It MUST start at the exact moment the "
        "speaker's voice begins. If there is any silence or interviewer audio at the "
        "start, tighten source_in forward by up to 1.0s.\n"
        "3. The LAST segment is the CLOSURE. It should end cleanly -- tighten "
        "source_out backward by up to 0.5s if there is trailing silence.\n"
        "4. For all segments: you MAY adjust source_in forward or source_out backward "
        "by up to 1.0s to remove filler, silence, or mumbling at boundaries. "
        "Do NOT skip any segment.\n"
        "5. The asset_id is available in the brain context.\n"
        "6. After adding all clips, you are DONE. Summarize briefly and stop."
    )


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
    meta.dialogue = transcript

    # --- Step 3: Build sentences ---
    sentences = build_sentences(transcript)
    logger.info("Sentences: %d", len(sentences))
    for s in sentences[:5]:
        logger.info("  [%.1fs-%.1fs] %s", s["start"], s["end"], s["text"][:80])

    # --- Step 4: Three-part segment selection ---
    hook = select_hook(sentences, AUDIO_KEYWORDS)
    if hook:
        logger.info("HOOK: [%.1fs-%.1fs] score=%.1f: %s",
                     hook["start"], hook["end"], hook["score"], hook["text"][:80])
    else:
        logger.warning("No hook found!")

    hook_ids = {hook["_idx"]} if hook else set()

    closure = select_closure(sentences, AUDIO_KEYWORDS, exclude_ids=hook_ids)
    if closure:
        logger.info("CLOSURE: [%.1fs-%.1fs] score=%.1f: %s",
                     closure["start"], closure["end"], closure["score"], closure["text"][:80])
    else:
        logger.warning("No closure found!")

    hook_dur = (hook["end"] - hook["start"]) if hook else 0
    closure_dur = (closure["end"] - closure["start"]) if closure else 0
    body_target = max(45.0 - hook_dur - closure_dur, 15.0)

    body = select_body_segments(sentences, AUDIO_KEYWORDS, hook, closure,
                                target_body_duration=body_target)
    logger.info("BODY: %d segments, %.1fs",
                len(body), sum(s["end"] - s["start"] for s in body))

    topic_segments = compose_edit(hook, body, closure)

    if not topic_segments:
        logger.error("No topic segments found!")
        sys.exit(1)

    # --- Step 5: Iterative edit-export-review loop ---
    original_model = gemini_agent._GEMINI_MODEL
    gemini_agent._GEMINI_MODEL = "gemini-3-flash-preview"
    logger.info("Agent model: gemini-3-flash-preview")

    max_iter = 7
    best_score = 0
    best_output = None
    last_review: dict | None = None
    current_segments = topic_segments

    try:
        for it in range(1, max_iter + 1):
            logger.info("=" * 60)
            logger.info("ITERATION %d / %d", it, max_iter)
            logger.info("=" * 60)

            base_prompt = build_agent_prompt(topic, current_segments)
            prompt = base_prompt
            if last_review and last_review.get("overall_score", 0) < 8:
                prompt += build_feedback(last_review)

            logger.info("--- Agent ---")
            t0 = time.monotonic()
            try:
                clips = run_agent_edit(meta, gemini_key, http, prompt)
            except Exception:
                logger.exception("Agent failed")
                continue
            logger.info("Agent: %.1fs, %d clips", time.monotonic() - t0, len(clips))

            if len(clips) < 2:
                logger.warning("< 2 clips, skip")
                continue

            logger.info("--- Export ---")
            out = OUTPUT_DIR / f"edit_output_v{it}.mp4"
            try:
                export_edit(clips, TEST_VIDEO, out)
            except Exception:
                logger.exception("Export failed")
                continue

            logger.info("--- Review ---")
            try:
                review = review_edit(out, gemini_key, http, topic)
            except Exception:
                logger.exception("Review failed")
                continue

            last_review = review

            logger.info("=== REVIEW (iter %d) ===", it)
            for k in ["hook_quality", "pacing_quality", "content_relevance",
                       "closure_quality", "audio_continuity", "overall_score",
                       "duration_seconds"]:
                logger.info("  %s: %s", k, review.get(k, "N/A"))
            if review.get("silent_gaps"):
                logger.info("  Gaps: %s", review["silent_gaps"])
            if review.get("irrelevant_sections"):
                logger.info("  Irrelevant: %s", review["irrelevant_sections"])
            logger.info("  Feedback: %s", review.get("feedback", "N/A"))

            score = review.get("overall_score", 0)
            if score > best_score:
                best_score = score
                best_output = out
                shutil.copy2(out, OUTPUT_DIR / "edit_output.mp4")

            if score >= 8:
                logger.info("=== QUALITY PASSED (%d/10) ===", score)
                break

            logger.warning("Score %d < 8, refining segments...", score)
            current_segments = refine_segments(
                current_segments, review, sentences, AUDIO_KEYWORDS, it
            )
    finally:
        gemini_agent._GEMINI_MODEL = original_model

    logger.info("=" * 60)
    logger.info("FINAL: best=%d, file=%s", best_score, best_output)
    logger.info("STATUS: %s", "PASS" if best_score >= 8 else f"BEST EFFORT ({best_score})")
    sys.exit(0 if best_score >= 8 else 1)


if __name__ == "__main__":
    main()
