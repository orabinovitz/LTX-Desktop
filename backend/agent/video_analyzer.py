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
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from agent.types import AnalysisStatus, DialogueLine, SceneSegment, TopicTag, VideoMetadata
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_MAX_METADATA_CACHE_SIZE = 200
_metadata_cache: OrderedDict[str, VideoMetadata] = OrderedDict()
_cache_lock = threading.Lock()


def _cache_put(asset_id: str, meta: VideoMetadata) -> None:
    """Insert/update an entry in the metadata cache, evicting LRU if full. Caller must hold _cache_lock."""
    _metadata_cache[asset_id] = meta
    _metadata_cache.move_to_end(asset_id)
    while len(_metadata_cache) > _MAX_METADATA_CACHE_SIZE:
        evicted_id, _ = _metadata_cache.popitem(last=False)
        logger.debug("Evicted metadata cache entry: %s", evicted_id)

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

_ANALYSIS_VERSION = 2
"""Bump when the analysis pipeline changes in a way that invalidates cached results."""

_DIALOGUE_CHUNK_SECONDS = 120  # 2 minutes per transcription chunk (keeps output small)
_DIALOGUE_CHUNK_OVERLAP = 10   # seconds of overlap to catch boundary speech
_DIALOGUE_PARALLEL_WORKERS = 5  # concurrent Gemini API calls for dialogue chunks

# Callbacks invoked when an analysis finishes (success or failure).
# Signature: callback(asset_id: str, metadata: VideoMetadata | None)
# metadata is None when analysis failed.
_on_analysis_complete_callbacks: list = []


def on_analysis_complete(callback) -> None:
    """Register a callback to be invoked when a video analysis finishes."""
    _on_analysis_complete_callbacks.append(callback)


def _notify_analysis_complete(asset_id: str, metadata: VideoMetadata | None) -> None:
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
    """Load previously completed metadata from disk, or None.

    Returns None (triggering re-analysis) if the cached version is older
    than ``_ANALYSIS_VERSION``.
    """
    cache_file = _disk_cache_path(file_path)
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        meta = VideoMetadata.model_validate(data)
        if meta.analysis_status != AnalysisStatus.COMPLETE:
            return None
        if meta.analysis_version < _ANALYSIS_VERSION:
            logger.info(
                "Discarding stale cache for %s (version %d < %d)",
                file_path, meta.analysis_version, _ANALYSIS_VERSION,
            )
            cache_file.unlink(missing_ok=True)
            return None
        return meta
    except Exception:
        logger.warning("Failed to read analysis cache for %s", file_path, exc_info=True)
    return None


def _recover_from_project_files(
    meta: VideoMetadata,
    file_path: str,
    project_save_path: str,
) -> None:
    """Try to recover missing topics/summary from project-level analysis files.

    The disk cache may have been saved before topics were generated, but the
    project folder may contain a valid topics.json from a later save.
    """
    try:
        video_name = _sanitize_filename(Path(file_path).name)
        analysis_dir = Path(project_save_path) / ".ltx-desktop" / "analysis" / video_name

        if not meta.topics:
            topics_file = analysis_dir / "topics.json"
            if topics_file.exists():
                raw = json.loads(topics_file.read_text(encoding="utf-8"))
                recovered_topics = _parse_topics(raw)
                if recovered_topics:
                    meta.topics = recovered_topics
                    logger.info(
                        "Recovered %d topics from project folder for %s",
                        len(recovered_topics), meta.asset_id,
                    )
                    _save_to_disk(file_path, meta)

        if not meta.summary:
            metadata_file = analysis_dir / "metadata.json"
            if metadata_file.exists():
                raw_meta = json.loads(metadata_file.read_text(encoding="utf-8"))
                if raw_meta.get("summary"):
                    meta.summary = raw_meta["summary"]
                    logger.info("Recovered summary from project folder for %s", meta.asset_id)
                    _save_to_disk(file_path, meta)
    except Exception:
        logger.warning("Could not recover from project files for %s", file_path, exc_info=True)


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


def get_all_complete_metadata() -> list[VideoMetadata]:
    """Return all metadata entries with a complete analysis status."""
    with _cache_lock:
        return [m for m in _metadata_cache.values() if m.analysis_status == AnalysisStatus.COMPLETE]


def get_structural_metadata(file_path: str) -> dict[str, float | tuple[int, int]]:
    """Run ffprobe to extract duration, resolution and fps."""
    cmd = [
        "ffprobe",
        "-protocol_whitelist", "file,pipe,data",
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
    force: bool = False,
) -> bool:
    """Kick off background video analysis.

    Returns ``True`` if a new analysis was started, ``False`` if the result
    was loaded from the on-disk cache (no Gemini call needed).

    When *force* is True, any existing disk and in-memory caches are
    cleared so a fresh Gemini analysis is performed.
    """
    if force:
        cache_file = _disk_cache_path(file_path)
        if cache_file.exists():
            cache_file.unlink(missing_ok=True)
            logger.info("Force flag set — deleted disk cache for %s", file_path)
        with _cache_lock:
            _metadata_cache.pop(asset_id, None)

    # Check disk cache first — avoid re-analyzing on every app restart
    cached = _load_from_disk(file_path)
    if cached is not None:
        cached.asset_id = asset_id  # asset IDs may differ across sessions
        # If disk cache has empty topics/summary, try to recover from project-level files
        if project_save_path and (not cached.topics or not cached.summary):
            _recover_from_project_files(cached, file_path, project_save_path)
        with _cache_lock:
            _cache_put(asset_id, cached)
        logger.debug("Loaded analysis from disk cache for %s", asset_id)
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
        _cache_put(asset_id, VideoMetadata(
            asset_id=asset_id,
            duration=0.0,
            resolution=(0, 0),
            fps=0.0,
            analysis_status=AnalysisStatus.PENDING,
        ))

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
        logger.error("Video analysis failed for %s", asset_id, exc_info=True)
        with _cache_lock:
            entry = _metadata_cache.get(asset_id)
            if entry is not None:
                entry.analysis_status = AnalysisStatus.FAILED
        _notify_analysis_complete(asset_id, None)
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
            entry.analysis_version = _ANALYSIS_VERSION
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

    # Pass 1 (summary+topics) and Pass 2 (scenes) are independent — run in parallel
    t0_parallel = time.monotonic()
    with ThreadPoolExecutor(max_workers=2) as pool:
        summary_future = pool.submit(_multipass_summary, file_uri, mime_type, duration, gemini_api_key, http_client)
        scene_future = pool.submit(_multipass_scenes, file_uri, mime_type, duration, gemini_api_key, http_client)
        summary_result = summary_future.result()
        scene_result = scene_future.result()
    logger.info("[multipass] passes 1+2 (parallel) took %.1fs for %s", time.monotonic() - t0_parallel, asset_id)

    summary: str = summary_result.get("summary", "")
    topics = _parse_topics(summary_result.get("topics", []))

    if not summary or not topics:
        logger.warning(
            "Pass 1 returned empty results for %s (summary=%d chars, topics=%d) — retrying with higher budget",
            asset_id, len(summary), len(topics),
        )
        t0 = time.monotonic()
        summary_result = _multipass_summary(
            file_uri, mime_type, duration, gemini_api_key, http_client,
            max_output_tokens=16384,
        )
        logger.info("[multipass] pass 1 retry took %.1fs for %s", time.monotonic() - t0, asset_id)
        if not summary:
            summary = summary_result.get("summary", "")
        retry_topics = _parse_topics(summary_result.get("topics", []))
        if retry_topics:
            topics = retry_topics

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

    # Pass 3 — Chunked dialogue transcription (non-fatal: pass 1+2 results are preserved)
    dialogue: list[DialogueLine] = []
    full_transcript: str = ""
    t0 = time.monotonic()
    try:
        dialogue = _multipass_dialogue_chunked(
            file_uri, mime_type, duration, gemini_api_key, http_client,
        )
        logger.info("[multipass] pass 3 (chunked dialogue) took %.1fs for %s", time.monotonic() - t0, asset_id)
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
            entry.analysis_version = _ANALYSIS_VERSION
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
            logger.warning("Skipping unparseable scene segment: %s", s, exc_info=True)
    return scenes


def _parse_dialogue(raw: list) -> list[DialogueLine]:
    dialogue: list[DialogueLine] = []
    for d in raw:
        try:
            dialogue.append(DialogueLine.model_validate(d))
        except Exception:
            logger.warning("Skipping unparseable dialogue line: %s", d, exc_info=True)
    return dialogue


def _parse_topics(raw: list) -> list[TopicTag]:
    topics: list[TopicTag] = []
    for t in raw:
        try:
            topics.append(TopicTag.model_validate(t))
        except Exception:
            logger.warning("Skipping unparseable topic tag: %s", t, exc_info=True)
    return topics


# ---------------------------------------------------------------------------
# Multi-pass Gemini calls (reuse uploaded file_uri)
# ---------------------------------------------------------------------------


from agent.json_repair import repair_truncated_json as _repair_truncated_json


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
    max_output_tokens: int = 8192,
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
        gemini_api_key, http_client, max_output_tokens=max_output_tokens, timeout=180,
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


def _multipass_dialogue_chunked(
    file_uri: str,
    mime_type: str,
    duration: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> list[DialogueLine]:
    """Pass 3: Full dialogue transcription via time-windowed chunks.

    Splits the video into overlapping 5-minute windows and transcribes each
    separately so no single Gemini call needs to produce more than ~3,500
    tokens of output.  Results are merged, deduplicated, and validated.
    """
    chunk_size = _DIALOGUE_CHUNK_SECONDS
    overlap = _DIALOGUE_CHUNK_OVERLAP

    chunks: list[tuple[float, float]] = []
    start = 0.0
    while start < duration:
        end = min(start + chunk_size + overlap, duration)
        chunks.append((start, end))
        start += chunk_size

    logger.info(
        "Dialogue chunked transcription: %d chunks of %ds (+%ds overlap) for %.0fs video",
        len(chunks), chunk_size, overlap, duration,
    )

    all_dialogue: list[DialogueLine] = []

    def _process_single_chunk(
        chunk_idx: int, chunk_start: float, chunk_end: float,
    ) -> tuple[int, list[DialogueLine]]:
        logger.info(
            "[dialogue-chunk %d/%d] transcribing %.0fs–%.0fs",
            chunk_idx + 1, len(chunks), chunk_start, chunk_end,
        )
        result = _transcribe_chunk(
            file_uri, mime_type, duration, chunk_start, chunk_end,
            gemini_api_key, http_client,
        )
        # Gemini may return the dialogue array directly or wrapped in {"dialogue": [...]}
        if isinstance(result, list):
            raw_dialogue = result
        elif isinstance(result, dict):
            raw_dialogue = result.get("dialogue", [])
        else:
            raw_dialogue = []
        chunk_lines = _parse_dialogue(raw_dialogue)
        chunk_lines = [
            dl for dl in chunk_lines
            if dl.start_time >= max(0, chunk_start - 5) and dl.end_time <= chunk_end + 5
        ]
        logger.info(
            "[dialogue-chunk %d/%d] got %d lines",
            chunk_idx + 1, len(chunks), len(chunk_lines),
        )
        return chunk_idx, chunk_lines

    with ThreadPoolExecutor(max_workers=_DIALOGUE_PARALLEL_WORKERS) as pool:
        futures = {
            pool.submit(_process_single_chunk, i, cs, ce): i
            for i, (cs, ce) in enumerate(chunks)
        }
        for future in as_completed(futures):
            chunk_idx = futures[future]
            try:
                _, chunk_lines = future.result()
                all_dialogue.extend(chunk_lines)
            except Exception:
                cs, ce = chunks[chunk_idx]
                logger.error(
                    "[dialogue-chunk %d/%d] failed for %.0fs–%.0fs",
                    chunk_idx + 1, len(chunks), cs, ce,
                    exc_info=True,
                )

    merged = _deduplicate_dialogue(all_dialogue)
    merged.sort(key=lambda dl: dl.start_time)

    if merged and duration > 0:
        last_time = max(dl.end_time for dl in merged)
        coverage_pct = (last_time / duration) * 100
        logger.info(
            "Dialogue chunked transcription complete: %d lines, coverage %.0f%% (last=%.0fs / %.0fs)",
            len(merged), coverage_pct, last_time, duration,
        )
        if coverage_pct < 80:
            logger.warning(
                "Dialogue coverage is only %.0f%% — some speech may be missing", coverage_pct,
            )

    return merged


def _transcribe_chunk(
    file_uri: str,
    mime_type: str,
    duration: float,
    chunk_start: float,
    chunk_end: float,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> dict:
    """Transcribe a single time window of the video."""
    system_prompt = (
        "You are a professional transcriptionist. Transcribe ONLY the speech "
        f"between {chunk_start:.0f}s and {chunk_end:.0f}s of this video "
        f"(total duration {duration:.0f}s).\n\n"
        "Return a JSON object with one key:\n"
        '- "dialogue": an array of speech segments. Each has:\n'
        '    - "start_time": float, in seconds (absolute, not relative)\n'
        '    - "end_time": float, in seconds (absolute, not relative)\n'
        '    - "speaker": string, speaker identifier (e.g. "Speaker 1", '
        '"Interviewer", "Host") or "" if only one speaker\n'
        '    - "text": string, the transcribed speech for this segment\n\n'
        f"ONLY include speech that occurs between {chunk_start:.0f}s and "
        f"{chunk_end:.0f}s. Timestamps must be absolute (from video start). "
        "Break speech into natural sentence boundaries (5-30s segments). "
        "If there is no speech in this range, return an empty array.\n"
        "Return ONLY valid JSON."
    )
    user_text = (
        f"Transcribe speech from {chunk_start:.0f}s to {chunk_end:.0f}s "
        f"of this video (total {duration:.0f}s, {duration/60:.1f} minutes)."
    )

    return _gemini_generate(
        file_uri, mime_type, system_prompt, user_text,
        gemini_api_key, http_client,
        max_output_tokens=16384,
        timeout=120,
    )


def _deduplicate_dialogue(lines: list[DialogueLine]) -> list[DialogueLine]:
    """Remove near-duplicate dialogue lines from overlapping chunks.

    Two lines are considered duplicates if their time ranges overlap by
    more than 80% and their text is similar (one contains the other or
    they share >60% of words).
    """
    if not lines:
        return []

    sorted_lines = sorted(lines, key=lambda dl: (dl.start_time, -len(dl.text)))
    result: list[DialogueLine] = []

    for line in sorted_lines:
        is_dup = False
        for existing in result[-5:]:  # only check recent entries
            overlap_start = max(line.start_time, existing.start_time)
            overlap_end = min(line.end_time, existing.end_time)
            overlap = max(0, overlap_end - overlap_start)
            line_dur = max(0.1, line.end_time - line.start_time)
            existing_dur = max(0.1, existing.end_time - existing.start_time)

            if overlap / min(line_dur, existing_dur) > 0.5:
                line_words = set(line.text.lower().split())
                existing_words = set(existing.text.lower().split())
                if line_words and existing_words:
                    shared = len(line_words & existing_words)
                    similarity = shared / min(len(line_words), len(existing_words))
                    if similarity > 0.6:
                        is_dup = True
                        break
        if not is_dup:
            result.append(line)

    return result


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
        ffmpeg, "-y",
        "-protocol_whitelist", "file,pipe,data",
        "-i", file_path,
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


# ---------------------------------------------------------------------------
# Whisper-based transcription (OpenAI API)
# ---------------------------------------------------------------------------

_WHISPER_CHUNK_MINUTES = 15
_WHISPER_MAX_FILE_BYTES = 24 * 1024 * 1024  # 24 MB safety margin under 25 MB limit


def _extract_audio_mp3(video_path: str, output_path: str) -> str:
    """Extract the audio track from a video file as mono 16kHz MP3."""
    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        import shutil
        ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found — required for audio extraction")

    cmd = [
        ffmpeg, "-y",
        "-protocol_whitelist", "file,pipe,data",
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "1",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"Audio extraction failed: {result.stderr[:500]}")
    return output_path


def _split_audio_chunks(
    audio_path: str, chunk_minutes: int = _WHISPER_CHUNK_MINUTES,
) -> list[tuple[str, float]]:
    """Split an audio file into chunks that fit under the Whisper file size limit.

    Returns list of (chunk_path, offset_seconds) tuples.
    """
    audio_size = Path(audio_path).stat().st_size
    if audio_size <= _WHISPER_MAX_FILE_BYTES:
        return [(audio_path, 0.0)]

    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        import shutil
        ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")

    probe_cmd = [
        ffmpeg.replace("ffmpeg", "ffprobe") if "ffmpeg" in ffmpeg else "ffprobe",
        "-protocol_whitelist", "file,pipe,data",
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", audio_path,
    ]
    try:
        dur_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        total_duration = float(dur_result.stdout.strip())
    except Exception:
        total_duration = (audio_size / (64000 / 8)) * 1.1

    chunk_duration = chunk_minutes * 60
    chunks: list[tuple[str, float]] = []
    offset = 0.0
    chunk_idx = 0
    parent = Path(audio_path).parent

    while offset < total_duration:
        chunk_path = str(parent / f"chunk_{chunk_idx:03d}.mp3")
        cmd = [
            ffmpeg, "-y",
            "-protocol_whitelist", "file,pipe,data",
            "-ss", str(offset),
            "-t", str(chunk_duration),
            "-i", audio_path,
            "-acodec", "libmp3lame", "-b:a", "64k", "-ar", "16000", "-ac", "1",
            chunk_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            logger.error("Chunk %d split failed: %s", chunk_idx, result.stderr[:300])
            break
        if Path(chunk_path).stat().st_size > 0:
            chunks.append((chunk_path, offset))
        offset += chunk_duration
        chunk_idx += 1

    return chunks


def _whisper_transcribe_chunk(
    audio_path: str,
    openai_api_key: str,
    prompt: str = "",
) -> dict:
    """Call OpenAI Whisper API for a single audio chunk. Returns raw JSON response."""
    import requests as _requests

    url = "https://api.openai.com/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {openai_api_key}"}

    _DEFAULT_PROMPT = (
        "Interview about LTX video generation model, discussing technical "
        "improvements including audio quality, lip sync, VAE, vocoder, and "
        "model architecture. Speaker: Eran. Technical terms: LTX, Hugging Face, "
        "latent space, diffusion, prompt adherence, open source, community."
    )

    with open(audio_path, "rb") as f:
        files = {"file": (Path(audio_path).name, f, "audio/mpeg")}
        data: dict = {
            "model": "whisper-1",
            "response_format": "verbose_json",
            "timestamp_granularities[]": "segment",
            "language": "en",
        }
        data["prompt"] = prompt if prompt else _DEFAULT_PROMPT

        file_size_mb = Path(audio_path).stat().st_size / (1024 * 1024)
        timeout = max(600, int(file_size_mb * 30))
        logger.info(
            "Whisper API call: %s (%.1f MB, timeout=%ds)",
            Path(audio_path).name, file_size_mb, timeout,
        )
        resp = _requests.post(
            url, headers=headers, files=files, data=data, timeout=timeout,
        )

    if resp.status_code != 200:
        logger.error("Whisper API error %d: %s", resp.status_code, resp.text[:500])
        raise RuntimeError(f"Whisper API error {resp.status_code}: {resp.text[:200]}")

    return resp.json()


def whisper_transcribe(
    video_path: str,
    openai_api_key: str,
) -> list[DialogueLine]:
    """Transcribe a video using OpenAI Whisper with accurate timestamps.

    1. Extracts audio as mono MP3
    2. Chunks if > 24 MB
    3. Calls Whisper API per chunk
    4. Merges segments with offset correction
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = str(Path(tmpdir) / "audio.mp3")
        logger.info("Extracting audio from %s...", Path(video_path).name)
        _extract_audio_mp3(video_path, audio_path)
        audio_size = Path(audio_path).stat().st_size
        logger.info("Audio extracted: %.1f MB", audio_size / (1024 * 1024))

        chunks = _split_audio_chunks(audio_path)
        logger.info("Whisper transcription: %d chunk(s)", len(chunks))

        all_lines: list[DialogueLine] = []
        last_text = ""

        for chunk_path, offset in chunks:
            prompt = last_text[-200:] if last_text else ""
            try:
                result = _whisper_transcribe_chunk(chunk_path, openai_api_key, prompt)
            except Exception:
                logger.error("Whisper chunk failed (offset=%.0f)", offset, exc_info=True)
                continue

            segments = result.get("segments", [])
            logger.info(
                "  Chunk offset=%.0fs: %d segments, text=%d chars",
                offset, len(segments), len(result.get("text", "")),
            )

            for seg in segments:
                start = seg.get("start", 0.0) + offset
                end = seg.get("end", 0.0) + offset
                text = seg.get("text", "").strip()
                if not text:
                    continue
                all_lines.append(DialogueLine(
                    start_time=round(start, 2),
                    end_time=round(end, 2),
                    speaker="",
                    text=text,
                ))

            if result.get("text"):
                last_text = result["text"]

        all_lines.sort(key=lambda dl: dl.start_time)
        logger.info(
            "Whisper transcription complete: %d lines, %.0fs-%.0fs",
            len(all_lines),
            all_lines[0].start_time if all_lines else 0,
            all_lines[-1].end_time if all_lines else 0,
        )
        return all_lines
