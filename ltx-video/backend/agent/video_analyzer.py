"""Video understanding pipeline using Gemini Vision.

Provides background video analysis with in-memory + disk caching.  Structural
metadata (duration, resolution, fps) is extracted locally via ffprobe;
semantic metadata (scenes, dialogue, summary) comes from Gemini via the
File Upload API (handles large video files).

Completed analyses are persisted to ``~/.ltx-desktop/analysis-cache/`` so
they survive app restarts.
"""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import subprocess
import threading
import time
from pathlib import Path

from agent.types import AnalysisStatus, DialogueLine, SceneSegment, VideoMetadata
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_metadata_cache: dict[str, VideoMetadata] = {}
_cache_lock = threading.Lock()

# Limit concurrent analyses to avoid memory pressure from large file uploads
_analysis_semaphore = threading.Semaphore(2)

_ALLOWED_VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v",
    ".flv", ".wmv", ".mpg", ".mpeg", ".ts", ".mts",
}

# ---------------------------------------------------------------------------
# Disk cache
# ---------------------------------------------------------------------------

_DISK_CACHE_DIR = Path.home() / ".ltx-desktop" / "analysis-cache"


def _disk_cache_path(file_path: str) -> Path:
    """Return the on-disk JSON path for a given video file."""
    key = hashlib.sha256(file_path.encode()).hexdigest()[:16]
    return _DISK_CACHE_DIR / f"{key}.json"


def _save_to_disk(file_path: str, meta: VideoMetadata) -> None:
    """Persist completed metadata to disk."""
    try:
        _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        data = meta.model_dump(mode="json")
        _disk_cache_path(file_path).write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        logger.warning("Failed to write analysis cache for %s", file_path, exc_info=True)


def _load_from_disk(file_path: str) -> VideoMetadata | None:
    """Load previously completed metadata from disk, or None."""
    cache_file = _disk_cache_path(file_path)
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        meta = VideoMetadata.model_validate(data)
        if meta.analysis_status == AnalysisStatus.COMPLETE:
            return meta
    except Exception:
        logger.warning("Failed to read analysis cache for %s", file_path, exc_info=True)
    return None

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_metadata(asset_id: str) -> VideoMetadata | None:
    """Return cached metadata for *asset_id*, or ``None`` if not available."""
    with _cache_lock:
        return _metadata_cache.get(asset_id)


def get_structural_metadata(file_path: str) -> dict[str, float | tuple[int, int]]:
    """Run ffprobe to extract duration, resolution and fps."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        file_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        probe: dict = json.loads(result.stdout) if result.stdout else {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        logger.warning("ffprobe failed for %s, returning defaults", file_path)
        return {"duration": 0.0, "resolution": (0, 0), "fps": 0.0}

    duration = 0.0
    fmt = probe.get("format", {})
    if "duration" in fmt:
        try:
            duration = float(fmt["duration"])
        except (ValueError, TypeError):
            pass

    width, height, fps = 0, 0, 0.0
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width", 0))
            height = int(stream.get("height", 0))
            r_fps = stream.get("r_frame_rate", "0/1")
            try:
                num, den = r_fps.split("/")
                fps = float(num) / float(den) if float(den) else 0.0
            except (ValueError, ZeroDivisionError):
                fps = 0.0
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
) -> bool:
    """Kick off background video analysis.

    Returns ``True`` if a new analysis was started, ``False`` if the result
    was loaded from the on-disk cache (no Gemini call needed).
    """
    # Check disk cache first — avoid re-analyzing on every app restart
    cached = _load_from_disk(file_path)
    if cached is not None:
        cached.asset_id = asset_id  # asset IDs may differ across sessions
        with _cache_lock:
            _metadata_cache[asset_id] = cached
        logger.info("Loaded analysis from disk cache for %s", asset_id)
        return False

    file_p = Path(file_path)
    if not file_p.is_file():
        logger.warning("analyze_video_background: path is not a file: %s", file_path)
        return False
    if file_p.suffix.lower() not in _ALLOWED_VIDEO_EXTENSIONS:
        logger.warning("analyze_video_background: not a video extension: %s", file_path)
        return False

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
    logger.info("Started video analysis thread for %s (%s)", asset_id, file_path)
    return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _run_analysis(
    asset_id: str,
    file_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> None:
    """Background thread: ffprobe then Gemini Vision (limited by semaphore to 2 concurrent)."""
    _analysis_semaphore.acquire()
    try:
        logger.info("Semaphore acquired for %s, starting analysis", asset_id)
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

        # 2. Semantic analysis via Gemini File Upload API
        gemini_result = _call_gemini_video(
            file_path=file_path,
            duration=duration,
            gemini_api_key=gemini_api_key,
            http_client=http_client,
        )

        scenes: list[SceneSegment] = []
        for s in gemini_result.get("scenes", []):
            try:
                scenes.append(SceneSegment.model_validate(s))
            except Exception:
                logger.warning("Skipping unparseable scene segment: %s", s)

        dialogue: list[DialogueLine] = []
        for d in gemini_result.get("dialogue", []):
            try:
                dialogue.append(DialogueLine.model_validate(d))
            except Exception:
                logger.warning("Skipping unparseable dialogue line: %s", d)

        summary: str = gemini_result.get("summary", "")

        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.scenes = scenes
                entry.dialogue = dialogue
                entry.summary = summary
                entry.analysis_status = AnalysisStatus.COMPLETE
                # Persist to disk so it survives restarts
                _save_to_disk(file_path, entry)

        logger.info(
            "Video analysis complete for %s: %d scenes, %d dialogue lines",
            asset_id, len(scenes), len(dialogue),
        )

    except Exception:
        logger.exception("Video analysis failed for %s", asset_id)
        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.analysis_status = AnalysisStatus.FAILED
    finally:
        _analysis_semaphore.release()


def _upload_file_to_gemini(
    file_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> str:
    """Upload a video file via Gemini File Upload API. Returns the file URI.

    Uses the resumable upload protocol:
    1. POST to start upload → get upload URL
    2. PUT file bytes to upload URL → get file metadata with URI
    3. Poll until file state is ACTIVE (video processing)
    """
    path = Path(file_path)
    file_bytes = path.read_bytes()
    file_size = len(file_bytes)
    mime_type = mimetypes.guess_type(file_path)[0] or "video/mp4"
    display_name = path.name

    # Step 1: Start resumable upload
    start_url = "https://generativelanguage.googleapis.com/upload/v1beta/files"

    start_response = http_client.post(
        start_url,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": gemini_api_key,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(file_size),
            "X-Goog-Upload-Header-Content-Type": mime_type,
        },
        json_payload={"file": {"display_name": display_name}},
        timeout=30,
    )

    # The upload URL is in the response headers
    upload_url = start_response.headers.get("X-Goog-Upload-URL") or start_response.headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError(
            f"No upload URL in response headers. Status: {start_response.status_code}, "
            f"Body: {start_response.text[:500]}"
        )

    # Step 2: Upload the actual file bytes
    upload_response = http_client.post(
        upload_url,
        headers={
            "Content-Length": str(file_size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        data=file_bytes,
        timeout=300,  # large files can take a while
    )

    if upload_response.status_code not in (200, 201):
        raise RuntimeError(
            f"File upload failed: {upload_response.status_code} {upload_response.text[:500]}"
        )

    file_info = upload_response.json().get("file", {})
    file_uri = file_info.get("uri", "")
    file_name = file_info.get("name", "")

    if not file_uri:
        raise RuntimeError(f"No file URI in upload response: {upload_response.json()}")

    # Step 3: Poll until video processing is complete
    check_url = (
        f"https://generativelanguage.googleapis.com/v1beta/{file_name}"
    )
    for _ in range(60):  # max 5 minutes of polling
        check_response = http_client.get(check_url, headers={"x-goog-api-key": gemini_api_key}, timeout=10)
        if check_response.status_code == 200:
            state = check_response.json().get("state", "")
            if state == "ACTIVE":
                logger.info("File %s is ACTIVE and ready", file_name)
                return file_uri
            if state == "FAILED":
                raise RuntimeError(f"File processing failed: {check_response.json()}")
        time.sleep(5)

    raise RuntimeError(f"File processing timed out for {file_name}")


def _call_gemini_video(
    file_path: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Upload video via File API then call generateContent. Returns parsed JSON."""

    # Upload video file first
    logger.info("Uploading video for analysis: %s", file_path)
    file_uri = _upload_file_to_gemini(file_path, gemini_api_key, http_client)
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
        "gemini-3-flash-preview:generateContent"
    )

    gemini_payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"fileData": {"mimeType": mime_type, "fileUri": file_uri}},
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
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_api_key,
            },
            json_payload=gemini_payload,
            timeout=120,
        )
    except HttpTimeoutError:
        logger.error("Gemini video analysis timed out for %s", file_path)
        raise
    except Exception:
        logger.error("Gemini video analysis request failed for %s", file_path, exc_info=True)
        raise

    if response.status_code != 200:
        msg = f"Gemini API error {response.status_code}: {response.text[:500]}"
        logger.error(msg)
        raise RuntimeError(msg)

    body = response.json()
    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected Gemini response structure: {body}") from exc

    try:
        parsed: dict = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Gemini returned invalid JSON: {text[:500]}") from exc

    return parsed
