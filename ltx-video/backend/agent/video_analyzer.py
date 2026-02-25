"""Video understanding pipeline using Gemini Vision.

Provides background video analysis with an in-memory cache.  Structural
metadata (duration, resolution, fps) is extracted locally via ffprobe;
semantic metadata (scenes, dialogue, summary) comes from Gemini 2.0 Flash.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import subprocess
import threading
from pathlib import Path

from agent.types import AnalysisStatus, DialogueLine, SceneSegment, VideoMetadata
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_metadata_cache: dict[str, VideoMetadata] = {}
_cache_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_metadata(asset_id: str) -> VideoMetadata | None:
    """Return cached metadata for *asset_id*, or ``None`` if not available."""
    with _cache_lock:
        return _metadata_cache.get(asset_id)


def get_structural_metadata(file_path: str) -> dict[str, float | tuple[int, int]]:
    """Run ffprobe to extract duration, resolution and fps.

    Returns a dict with keys ``duration``, ``resolution`` (width, height),
    and ``fps``.  All values are best-effort; defaults are used when
    ffprobe output is missing or unparseable.
    """
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        probe: dict = json.loads(result.stdout) if result.stdout else {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        logger.warning("ffprobe failed for %s, returning defaults", file_path)
        return {"duration": 0.0, "resolution": (0, 0), "fps": 0.0}

    # --- duration ---
    duration = 0.0
    fmt = probe.get("format", {})
    if "duration" in fmt:
        try:
            duration = float(fmt["duration"])
        except (ValueError, TypeError):
            pass

    # --- video stream ---
    width, height, fps = 0, 0, 0.0
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width", 0))
            height = int(stream.get("height", 0))
            # r_frame_rate is usually "30/1" or "24000/1001"
            r_fps = stream.get("r_frame_rate", "0/1")
            try:
                num, den = r_fps.split("/")
                fps = float(num) / float(den) if float(den) else 0.0
            except (ValueError, ZeroDivisionError):
                fps = 0.0
            # Fallback duration from stream if format-level was missing
            if duration == 0.0 and "duration" in stream:
                try:
                    duration = float(stream["duration"])
                except (ValueError, TypeError):
                    pass
            break

    return {"duration": duration, "resolution": (width, height), "fps": fps}


def analyze_video_background(
    asset_id: str,
    file_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> None:
    """Kick off background video analysis.

    Sets status to PENDING immediately and spawns a daemon thread that
    runs ffprobe + Gemini Vision.  Results (or failure) are written back
    into ``_metadata_cache``.
    """
    with _cache_lock:
        _metadata_cache[asset_id] = VideoMetadata(
            asset_id=asset_id,
            duration=0.0,
            resolution=(0, 0),
            fps=0.0,
            analysis_status=AnalysisStatus.PENDING,
        )

    thread = threading.Thread(
        target=_run_analysis,
        args=(asset_id, file_path, gemini_api_key, http_client),
        daemon=True,
        name=f"video-analysis-{asset_id}",
    )
    thread.start()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _run_analysis(
    asset_id: str,
    file_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> None:
    """Background thread: ffprobe then Gemini Vision."""
    try:
        # Mark as ANALYZING
        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.analysis_status = AnalysisStatus.ANALYZING

        # 1. Structural metadata (local, fast)
        structural = get_structural_metadata(file_path)
        duration: float = structural["duration"]  # type: ignore[assignment]
        resolution: tuple[int, int] = structural["resolution"]  # type: ignore[assignment]
        fps: float = structural["fps"]  # type: ignore[assignment]

        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.duration = duration
                entry.resolution = resolution
                entry.fps = fps

        # 2. Semantic analysis via Gemini Vision
        gemini_result = _call_gemini_video(
            file_path=file_path,
            duration=duration,
            gemini_api_key=gemini_api_key,
            http_client=http_client,
        )

        # Parse Gemini structured output
        scenes: list[SceneSegment] = []
        for s in gemini_result.get("scenes", []):
            try:
                scenes.append(SceneSegment.model_validate(s))
            except Exception:
                logger.debug("Skipping unparseable scene segment: %s", s)

        dialogue: list[DialogueLine] = []
        for d in gemini_result.get("dialogue", []):
            try:
                dialogue.append(DialogueLine.model_validate(d))
            except Exception:
                logger.debug("Skipping unparseable dialogue line: %s", d)

        summary: str = gemini_result.get("summary", "")

        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.scenes = scenes
                entry.dialogue = dialogue
                entry.summary = summary
                entry.analysis_status = AnalysisStatus.COMPLETE

        logger.info(
            "Video analysis complete for %s: %d scenes, %d dialogue lines",
            asset_id,
            len(scenes),
            len(dialogue),
        )

    except Exception:
        logger.exception("Video analysis failed for %s", asset_id)
        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.analysis_status = AnalysisStatus.FAILED


def _call_gemini_video(
    file_path: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Upload video as base64 inline data to Gemini 2.0 Flash and return parsed JSON.

    Returns a dict with keys ``summary``, ``scenes``, and ``dialogue``.
    """
    path = Path(file_path)
    video_bytes = path.read_bytes()
    video_b64 = base64.b64encode(video_bytes).decode("ascii")

    mime_type = mimetypes.guess_type(file_path)[0] or "video/mp4"

    system_prompt = (
        "You are a professional video analyst. Analyze the provided video and "
        "return a structured JSON object with the following keys:\n\n"
        '- "summary": a concise overall description of the video (1-3 sentences).\n'
        '- "scenes": an array of scene segments. Each segment has:\n'
        '    - "start_time": float, scene start in seconds\n'
        '    - "end_time": float, scene end in seconds\n'
        '    - "description": string, what happens in this scene\n'
        '    - "actions": array of strings, key actions\n'
        '    - "shot_type": string (e.g. "wide", "close-up", "medium", "aerial")\n'
        '    - "importance": float 0-1, how important this scene is relative to the whole video\n'
        '- "dialogue": an array of dialogue/speech lines. Each line has:\n'
        '    - "start_time": float, in seconds\n'
        '    - "end_time": float, in seconds\n'
        '    - "speaker": string, speaker identifier or "" if unknown\n'
        '    - "text": string, transcribed speech\n\n'
        "If there is no dialogue, return an empty array for dialogue.\n"
        "Ensure all timestamps are within the video duration.\n"
        "Return ONLY valid JSON, no markdown fences or extra text."
    )

    user_text = (
        f"Analyze this video (duration: {duration:.1f}s). "
        "Identify all distinct scenes, any dialogue or speech, "
        "and provide a brief overall summary."
    )

    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={gemini_api_key}"
    )

    gemini_payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": mime_type, "data": video_b64}},
                    {"text": user_text},
                ],
            }
        ],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    try:
        response = http_client.post(
            gemini_url,
            headers={"Content-Type": "application/json"},
            json_payload=gemini_payload,
            timeout=120,
        )
    except HttpTimeoutError:
        logger.error("Gemini video analysis timed out for %s", file_path)
        raise
    except Exception:
        logger.error(
            "Gemini video analysis request failed for %s", file_path, exc_info=True
        )
        raise

    if response.status_code != 200:
        msg = f"Gemini API error {response.status_code}: {response.text}"
        logger.error(msg)
        raise RuntimeError(msg)

    # Gemini returns candidates[0].content.parts[0].text when responseMimeType
    # is "application/json".
    body = response.json()
    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]  # type: ignore[index]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected Gemini response structure: {body}") from exc

    try:
        parsed: dict = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Gemini returned invalid JSON: {text[:500]}") from exc

    return parsed
