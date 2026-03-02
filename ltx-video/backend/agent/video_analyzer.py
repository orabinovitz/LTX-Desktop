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
import re
import subprocess
import threading
import time
from pathlib import Path

from agent.types import AnalysisStatus, DialogueLine, SceneSegment, TopicTag, VideoMetadata
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

_LONG_VIDEO_THRESHOLD_SECONDS = 300  # 5 minutes — above this, use multi-pass analysis
_GEMINI_MODEL = "gemini-3-flash-preview"
_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

_PROXY_SIZE_THRESHOLD = 500 * 1024 * 1024  # 500 MB — above this, transcode before upload
_UPLOAD_MAX_RETRIES = 2

# Callbacks invoked when an analysis completes successfully.
# Signature: callback(asset_id: str, metadata: VideoMetadata)
_on_analysis_complete_callbacks: list = []


def on_analysis_complete(callback) -> None:
    """Register a callback to be invoked when a video analysis finishes."""
    _on_analysis_complete_callbacks.append(callback)


def _notify_analysis_complete(asset_id: str, metadata: VideoMetadata) -> None:
    for cb in _on_analysis_complete_callbacks:
        try:
            cb(asset_id, metadata)
        except Exception:
            logger.warning("Analysis-complete callback failed", exc_info=True)

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


def _sanitize_filename(name: str) -> str:
    """Strip extension and replace non-alphanumeric chars for use as a folder name."""
    stem = Path(name).stem
    return re.sub(r'[^\w\-.]', '_', stem)


def _format_timestamp(seconds: float) -> str:
    """Format seconds as HH:MM:SS."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _save_to_project_folder(
    file_path: str,
    meta: VideoMetadata,
    project_save_path: str,
) -> None:
    """Write human-readable analysis artifacts to the project's .ltx-desktop/ folder.

    Creates a per-video subfolder with metadata.json, transcript.txt,
    scenes.json, and topics.json.  Failures are logged but never block
    the analysis pipeline.
    """
    try:
        video_name = _sanitize_filename(Path(file_path).name)
        analysis_dir = Path(project_save_path) / ".ltx-desktop" / "analysis" / video_name
        analysis_dir.mkdir(parents=True, exist_ok=True)

        data = meta.model_dump(mode="json")

        # Full metadata (pretty-printed)
        (analysis_dir / "metadata.json").write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8",
        )

        # Plain-text transcript
        transcript_lines: list[str] = []
        for dl in meta.dialogue:
            ts = _format_timestamp(dl.start_time)
            speaker = f"{dl.speaker}: " if dl.speaker else ""
            transcript_lines.append(f"[{ts}] {speaker}{dl.text}")
        if transcript_lines:
            (analysis_dir / "transcript.txt").write_text(
                "\n".join(transcript_lines), encoding="utf-8",
            )
        elif meta.full_transcript:
            (analysis_dir / "transcript.txt").write_text(
                meta.full_transcript, encoding="utf-8",
            )

        # Scenes (just the array)
        if meta.scenes:
            scenes_data = [s.model_dump(mode="json") for s in meta.scenes]
            (analysis_dir / "scenes.json").write_text(
                json.dumps(scenes_data, indent=2, ensure_ascii=False), encoding="utf-8",
            )

        # Topics (just the array)
        if meta.topics:
            topics_data = [t.model_dump(mode="json") for t in meta.topics]
            (analysis_dir / "topics.json").write_text(
                json.dumps(topics_data, indent=2, ensure_ascii=False), encoding="utf-8",
            )

        logger.info("Saved analysis artifacts to %s", analysis_dir)

    except Exception:
        logger.warning("Failed to save analysis to project folder for %s", file_path, exc_info=True)


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
    project_save_path: str | None = None,
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
        if project_save_path:
            _save_to_project_folder(file_path, cached, project_save_path)
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
        args=(asset_id, file_path, gemini_api_key, http_client, project_save_path),
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
    project_save_path: str | None = None,
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

        is_long = duration >= _LONG_VIDEO_THRESHOLD_SECONDS

        if is_long:
            _run_multipass_analysis(asset_id, file_path, duration, gemini_api_key, http_client, project_save_path)
        else:
            _run_singlepass_analysis(asset_id, file_path, duration, gemini_api_key, http_client, project_save_path)

    except Exception:
        logger.exception("Video analysis failed for %s", asset_id)
        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.analysis_status = AnalysisStatus.FAILED
    finally:
        _analysis_semaphore.release()


def _run_singlepass_analysis(
    asset_id: str,
    file_path: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
    project_save_path: str | None = None,
) -> None:
    """Original single-pass analysis for short videos (<5 min)."""
    gemini_result = _call_gemini_video(
        file_path=file_path,
        duration=duration,
        gemini_api_key=gemini_api_key,
        http_client=http_client,
    )

    scenes = _parse_scenes(gemini_result.get("scenes", []))
    dialogue = _parse_dialogue(gemini_result.get("dialogue", []))
    summary: str = gemini_result.get("summary", "")

    with _cache_lock:
        entry = _metadata_cache.get(asset_id)
        if entry is not None:
            entry.scenes = scenes
            entry.dialogue = dialogue
            entry.summary = summary
            entry.analysis_status = AnalysisStatus.COMPLETE
            _save_to_disk(file_path, entry)
            if project_save_path:
                _save_to_project_folder(file_path, entry, project_save_path)

    logger.info(
        "Video analysis complete for %s: %d scenes, %d dialogue lines",
        asset_id, len(scenes), len(dialogue),
    )
    with _cache_lock:
        completed = _metadata_cache.get(asset_id)
    if completed is not None:
        _notify_analysis_complete(asset_id, completed)


def _run_multipass_analysis(
    asset_id: str,
    file_path: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
    project_save_path: str | None = None,
) -> None:
    """Multi-pass analysis for long videos (>=5 min).

    Uploads the video once, then runs three focused analysis passes against
    the same uploaded file:
      Pass 1 — Summary + topic extraction
      Pass 2 — Detailed scene segmentation
      Pass 3 — Full dialogue transcription
    """
    logger.info(
        "Starting multi-pass analysis for %s (%.0fs / %.1f min)",
        asset_id, duration, duration / 60,
    )

    file_uri = _upload_file_to_gemini(file_path, gemini_api_key, http_client)
    mime_type = mimetypes.guess_type(file_path)[0] or "video/mp4"

    # Pass 1 — Summary + topics
    t0 = time.monotonic()
    summary_result = _multipass_summary(file_uri, mime_type, duration, gemini_api_key, http_client)
    logger.info("[multipass] pass 1 (summary+topics) took %.1fs for %s", time.monotonic() - t0, asset_id)

    summary: str = summary_result.get("summary", "")
    topics = _parse_topics(summary_result.get("topics", []))

    # Pass 2 — Scene segmentation
    t0 = time.monotonic()
    scene_result = _multipass_scenes(file_uri, mime_type, duration, gemini_api_key, http_client)
    logger.info("[multipass] pass 2 (scenes) took %.1fs for %s", time.monotonic() - t0, asset_id)

    scenes = _parse_scenes(scene_result.get("scenes", []))

    # Validate scene coverage
    if scenes:
        covered = sum(s.end_time - s.start_time for s in scenes)
        coverage_pct = (covered / duration) * 100 if duration > 0 else 0
        if coverage_pct < 50:
            logger.warning(
                "Scene coverage for %s is only %.0f%% of duration — analysis may be incomplete",
                asset_id, coverage_pct,
            )

    # Pass 3 — Dialogue transcription (non-fatal: pass 1+2 results are preserved on failure)
    dialogue: list[DialogueLine] = []
    full_transcript: str = ""
    t0 = time.monotonic()
    try:
        dialogue_result = _multipass_dialogue(file_uri, mime_type, duration, gemini_api_key, http_client)
        logger.info("[multipass] pass 3 (dialogue) took %.1fs for %s", time.monotonic() - t0, asset_id)
        dialogue = _parse_dialogue(dialogue_result.get("dialogue", []))
    except Exception:
        logger.error(
            "Pass 3 (dialogue) failed for %s after %.1fs — saving results from passes 1+2",
            asset_id, time.monotonic() - t0, exc_info=True,
        )

    if dialogue:
        full_transcript = " ".join(dl.text for dl in dialogue)

    with _cache_lock:
        entry = _metadata_cache.get(asset_id)
        if entry is not None:
            entry.scenes = scenes
            entry.dialogue = dialogue
            entry.summary = summary
            entry.topics = topics
            entry.full_transcript = full_transcript
            entry.analysis_status = AnalysisStatus.COMPLETE
            _save_to_disk(file_path, entry)
            if project_save_path:
                _save_to_project_folder(file_path, entry, project_save_path)

    logger.info(
        "Multi-pass analysis complete for %s: %d scenes, %d dialogue lines, %d topics",
        asset_id, len(scenes), len(dialogue), len(topics),
    )
    with _cache_lock:
        completed = _metadata_cache.get(asset_id)
    if completed is not None:
        _notify_analysis_complete(asset_id, completed)


# ---------------------------------------------------------------------------
# Result parsers
# ---------------------------------------------------------------------------


def _parse_scenes(raw: list) -> list[SceneSegment]:
    scenes: list[SceneSegment] = []
    for s in raw:
        try:
            scenes.append(SceneSegment.model_validate(s))
        except Exception:
            logger.warning("Skipping unparseable scene segment: %s", s)
    return scenes


def _parse_dialogue(raw: list) -> list[DialogueLine]:
    dialogue: list[DialogueLine] = []
    for d in raw:
        try:
            dialogue.append(DialogueLine.model_validate(d))
        except Exception:
            logger.warning("Skipping unparseable dialogue line: %s", d)
    return dialogue


def _parse_topics(raw: list) -> list[TopicTag]:
    topics: list[TopicTag] = []
    for t in raw:
        try:
            topics.append(TopicTag.model_validate(t))
        except Exception:
            logger.warning("Skipping unparseable topic tag: %s", t)
    return topics


# ---------------------------------------------------------------------------
# Multi-pass Gemini calls (reuse uploaded file_uri)
# ---------------------------------------------------------------------------


def _repair_truncated_json(text: str) -> dict:
    """Attempt to salvage valid data from truncated JSON output.

    Gemini may hit its output-token limit and return JSON that is cut off
    mid-object.  This function tries progressively less precise strategies
    to recover whatever complete entries exist.
    """
    # Already valid — nothing to do
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy: find the last complete object in an array (last "}," or "}\n")
    # and close the surrounding structures.
    last_complete = -1
    for m in re.finditer(r'\}\s*,', text):
        last_complete = m.start() + 1  # position right after the '}'

    if last_complete == -1:
        # Try a lone "}" that might be the last complete entry before truncation
        for m in re.finditer(r'\}', text):
            last_complete = m.start() + 1

    if last_complete > 0:
        truncated = text[:last_complete]
        # Count open brackets to figure out how to close
        open_brackets = truncated.count('[') - truncated.count(']')
        open_braces = truncated.count('{') - truncated.count('}')
        suffix = ']' * max(0, open_brackets) + '}' * max(0, open_braces)
        try:
            return json.loads(truncated + suffix)
        except json.JSONDecodeError:
            pass

    logger.warning("Could not repair truncated JSON (%d chars)", len(text))
    return {}


def _gemini_generate(
    file_uri: str,
    mime_type: str,
    system_prompt: str,
    user_text: str,
    gemini_api_key: str,
    http_client: HTTPClient,
    max_output_tokens: int = 8192,
    timeout: int = 180,
) -> dict:
    """Call Gemini generateContent against an already-uploaded file. Returns parsed JSON."""
    gemini_url = f"{_GEMINI_BASE_URL}/{_GEMINI_MODEL}:generateContent"

    payload = {
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
            "maxOutputTokens": max_output_tokens,
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
            json_payload=payload,
            timeout=timeout,
        )
    except HttpTimeoutError:
        logger.error("Gemini call timed out (timeout=%ds)", timeout)
        raise
    except Exception:
        logger.error("Gemini request failed", exc_info=True)
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

    # Detect output truncation via finishReason
    finish_reason = ""
    try:
        finish_reason = body["candidates"][0].get("finishReason", "")
    except (KeyError, IndexError, TypeError):
        pass

    if finish_reason == "MAX_TOKENS":
        logger.warning(
            "Gemini output truncated (MAX_TOKENS, %d chars). Attempting JSON recovery...",
            len(text),
        )
        repaired = _repair_truncated_json(text)
        if repaired:
            logger.info("Recovered %d top-level keys from truncated response", len(repaired))
            return repaired
        logger.warning("JSON recovery failed — returning empty result")
        return {}

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        # Even without MAX_TOKENS, try repair as a last resort
        repaired = _repair_truncated_json(text)
        if repaired:
            logger.warning("Repaired malformed JSON response (%d chars)", len(text))
            return repaired
        raise RuntimeError(f"Gemini returned invalid JSON: {text[:500]}") from exc


def _multipass_summary(
    file_uri: str,
    mime_type: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Pass 1: Extract a summary and thematic topics from the video."""
    system_prompt = (
        "You are a professional video analyst. Analyze the provided video and "
        "return a structured JSON object with these keys:\n\n"
        '- "summary": a concise overall description of the video (2-4 sentences). '
        "Cover the main subject, setting, and narrative arc.\n"
        '- "topics": an array of thematic topics found in the video. Each topic has:\n'
        '    - "name": string, short topic name (2-5 words)\n'
        '    - "description": string, one-sentence description of the topic\n'
        '    - "time_ranges": array of [start_time, end_time] pairs (floats, seconds) '
        "where this topic is discussed or shown\n\n"
        "Identify 3-15 distinct topics depending on video length and content diversity. "
        "Topics should be meaningful thematic groupings, not just scene descriptions. "
        "Ensure all timestamps are within the video duration.\n"
        "Return ONLY valid JSON, no markdown fences or extra text."
    )
    user_text = (
        f"Analyze this video (duration: {duration:.1f}s, {duration/60:.1f} minutes). "
        "Provide an overall summary and identify the major thematic topics covered."
    )
    return _gemini_generate(
        file_uri, mime_type, system_prompt, user_text,
        gemini_api_key, http_client, max_output_tokens=4096, timeout=180,
    )


def _multipass_scenes(
    file_uri: str,
    mime_type: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Pass 2: Detailed scene segmentation with higher token budget."""
    system_prompt = (
        "You are a professional video analyst specializing in scene segmentation. "
        "Analyze the provided video and return a JSON object with one key:\n\n"
        '- "scenes": an array of scene segments covering the ENTIRE video from start to end. '
        "Each segment has:\n"
        '    - "start_time": float, scene start in seconds\n'
        '    - "end_time": float, scene end in seconds\n'
        '    - "description": string, what happens in this scene (1-2 sentences)\n'
        '    - "actions": array of strings, key actions or events\n'
        '    - "shot_type": string (e.g. "wide", "close-up", "medium", "aerial", '
        '"interview", "b-roll", "screen-share")\n'
        '    - "importance": float 0-1, how important this scene is relative to the whole video\n\n'
        "CRITICAL: Scenes must cover the entire video duration with no gaps. "
        f"The first scene should start near 0.0 and the last should end near {duration:.1f}. "
        "For a long video, identify fine-grained scene boundaries — aim for scenes of "
        "15-90 seconds each. A 40-minute video should have 30-80 scenes, not 5-10.\n"
        "Ensure all timestamps are within the video duration.\n"
        "Return ONLY valid JSON, no markdown fences or extra text."
    )
    user_text = (
        f"Segment this video (duration: {duration:.1f}s, {duration/60:.1f} minutes) "
        "into detailed scenes. Identify every distinct scene, shot change, or "
        "topic transition."
    )
    return _gemini_generate(
        file_uri, mime_type, system_prompt, user_text,
        gemini_api_key, http_client, max_output_tokens=16384, timeout=240,
    )


def _multipass_dialogue(
    file_uri: str,
    mime_type: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Pass 3: Full dialogue transcription.

    Token budget and timeout scale with video duration so long interviews
    don't get truncated.  ``full_transcript`` is NOT requested from Gemini
    (it doubles token usage for the same content); the caller builds it
    from the dialogue entries instead.
    """
    system_prompt = (
        "You are a professional transcriptionist. Analyze the audio of the provided "
        "video and return a JSON object with one key:\n\n"
        '- "dialogue": an array of speech segments. Each has:\n'
        '    - "start_time": float, in seconds\n'
        '    - "end_time": float, in seconds\n'
        '    - "speaker": string, speaker identifier (e.g. "Speaker 1", "Interviewer", '
        '"Host") or "" if only one speaker\n'
        '    - "text": string, the transcribed speech for this segment\n\n'
        "Transcribe ALL speech in the video. For long videos, break dialogue into "
        "natural sentence or paragraph boundaries (segments of 5-30 seconds each). "
        "If there is no speech, return an empty array.\n"
        "Ensure all timestamps are within the video duration.\n"
        "Return ONLY valid JSON, no markdown fences or extra text."
    )
    user_text = (
        f"Transcribe all dialogue and speech in this video "
        f"(duration: {duration:.1f}s, {duration/60:.1f} minutes)."
    )

    duration_minutes = duration / 60
    token_budget = min(65536, max(16384, int(duration_minutes * 800)))
    call_timeout = max(240, int(duration_minutes * 6))

    return _gemini_generate(
        file_uri, mime_type, system_prompt, user_text,
        gemini_api_key, http_client,
        max_output_tokens=token_budget,
        timeout=call_timeout,
    )


def _get_ffmpeg_path() -> str | None:
    """Get the path to the ffmpeg binary via imageio_ffmpeg, or None."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        logger.warning("imageio_ffmpeg not available, cannot create proxy", exc_info=True)
        return None


def _create_analysis_proxy(file_path: str) -> str | None:
    """Create a compressed 720p proxy for Gemini upload if the file is large.

    Returns the proxy file path, or None if the file is small enough to
    upload directly or if proxy creation fails.
    """
    original_size = Path(file_path).stat().st_size
    if original_size <= _PROXY_SIZE_THRESHOLD:
        return None

    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        logger.warning(
            "File is %.0f MB but ffmpeg unavailable — attempting direct upload",
            original_size / (1024 * 1024),
        )
        return None

    proxy_dir = Path.home() / ".ltx-desktop" / "analysis-proxies"
    proxy_dir.mkdir(parents=True, exist_ok=True)
    proxy_name = hashlib.sha256(file_path.encode()).hexdigest()[:16] + ".mp4"
    proxy_path = proxy_dir / proxy_name

    logger.info(
        "Creating analysis proxy for %.0f MB file: %s -> %s",
        original_size / (1024 * 1024), file_path, proxy_path,
    )

    cmd = [
        ffmpeg, "-y", "-i", file_path,
        "-vf", "scale=-2:720",
        "-c:v", "libx264", "-crf", "28",
        "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart",
        str(proxy_path),
    ]

    try:
        t0 = time.monotonic()
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        elapsed = time.monotonic() - t0

        if result.returncode != 0:
            logger.error("FFmpeg proxy creation failed (exit %d): %s", result.returncode, result.stderr[:500])
            _cleanup_proxy(str(proxy_path))
            return None

        proxy_size = proxy_path.stat().st_size
        logger.info(
            "Proxy created in %.0fs: %.0f MB -> %.0f MB (%.0f%% reduction)",
            elapsed,
            original_size / (1024 * 1024),
            proxy_size / (1024 * 1024),
            (1 - proxy_size / original_size) * 100,
        )
        return str(proxy_path)

    except subprocess.TimeoutExpired:
        logger.error("FFmpeg proxy creation timed out after 1200s")
        _cleanup_proxy(str(proxy_path))
        return None
    except Exception:
        logger.error("FFmpeg proxy creation failed", exc_info=True)
        _cleanup_proxy(str(proxy_path))
        return None


def _cleanup_proxy(proxy_path: str) -> None:
    """Safely delete a proxy file."""
    try:
        p = Path(proxy_path)
        if p.exists():
            p.unlink()
    except Exception:
        logger.warning("Failed to clean up proxy %s", proxy_path, exc_info=True)


def _upload_file_to_gemini(
    file_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> str:
    """Upload a video file via Gemini File Upload API. Returns the file URI.

    For large files (>500 MB), creates a compressed 720p proxy first.
    Streams the upload instead of reading the entire file into memory.
    Retries on transient connection failures.
    """
    proxy_path = _create_analysis_proxy(file_path)
    upload_path = proxy_path or file_path

    try:
        return _do_upload(upload_path, file_path, gemini_api_key, http_client)
    finally:
        if proxy_path:
            _cleanup_proxy(proxy_path)


def _do_upload(
    upload_path: str,
    original_path: str,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> str:
    """Execute the actual Gemini File Upload with streaming, retry, and scaled timeout."""
    file_size = Path(upload_path).stat().st_size
    mime_type = mimetypes.guess_type(upload_path)[0] or "video/mp4"
    display_name = Path(original_path).name
    file_size_mb = file_size / (1024 * 1024)

    logger.info(
        "Uploading %s to Gemini (%.0f MB, proxy=%s)",
        display_name, file_size_mb, upload_path != original_path,
    )

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

    upload_url = start_response.headers.get("X-Goog-Upload-URL") or start_response.headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError(
            f"No upload URL in response headers. Status: {start_response.status_code}, "
            f"Body: {start_response.text[:500]}"
        )

    # Step 2: Upload file bytes with streaming and retry
    upload_timeout = max(300, int(file_size_mb * 3))
    last_error: Exception | None = None

    for attempt in range(_UPLOAD_MAX_RETRIES + 1):
        try:
            with open(upload_path, "rb") as fh:
                upload_response = http_client.post(
                    upload_url,
                    headers={
                        "Content-Length": str(file_size),
                        "X-Goog-Upload-Offset": "0",
                        "X-Goog-Upload-Command": "upload, finalize",
                    },
                    data=fh,
                    timeout=upload_timeout,
                )

            if upload_response.status_code not in (200, 201):
                raise RuntimeError(
                    f"File upload failed: {upload_response.status_code} {upload_response.text[:500]}"
                )
            break  # success

        except (ConnectionError, OSError) as exc:
            last_error = exc
            if attempt < _UPLOAD_MAX_RETRIES:
                wait = 5 * (attempt + 1)
                logger.warning(
                    "Upload attempt %d failed (%s), retrying in %ds...",
                    attempt + 1, type(exc).__name__, wait,
                )
                time.sleep(wait)
            else:
                raise RuntimeError(
                    f"File upload failed after {_UPLOAD_MAX_RETRIES + 1} attempts "
                    f"(file: {display_name}, {file_size_mb:.0f} MB). "
                    f"Last error: {last_error}"
                ) from last_error

    file_info = upload_response.json().get("file", {})
    file_uri = file_info.get("uri", "")
    file_name = file_info.get("name", "")

    if not file_uri:
        raise RuntimeError(f"No file URI in upload response: {upload_response.json()}")

    logger.info("File uploaded successfully: %s (%.0f MB)", file_name, file_size_mb)

    # Step 3: Poll until video processing is complete
    check_url = f"https://generativelanguage.googleapis.com/v1beta/{file_name}"
    for _ in range(120):  # up to 10 minutes for large files
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
    """Upload video via File API then call generateContent (single-pass for short videos)."""
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
    return _gemini_generate(
        file_uri, mime_type, system_prompt, user_text,
        gemini_api_key, http_client, max_output_tokens=4096, timeout=120,
    )
