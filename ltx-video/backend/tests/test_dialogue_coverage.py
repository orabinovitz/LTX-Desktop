"""Integration test: validate chunked dialogue transcription covers the full video.

Requires:
  - A Gemini API key in ~/.ltx-video-studio/settings.json
  - The test video at ltx-video/Test_Assets/Zeev-Master.mp4
  - Network access to the Gemini API

Run:
    cd ltx-video/backend
    .venv/bin/python tests/test_dialogue_coverage.py
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

# Add backend to path so we can import the agent modules
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.video_analyzer import (
    _upload_file_to_gemini,
    _multipass_dialogue_chunked,
    _create_analysis_proxy,
    _cleanup_proxy,
    get_structural_metadata,
)
from services.http_client.http_client_impl import HTTPClientImpl

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

TEST_VIDEO = Path(__file__).resolve().parent.parent.parent / "Test_Assets" / "Zeev-Master.mp4"
SETTINGS_FILE = Path.home() / ".ltx-video-studio" / "settings.json"


def load_api_key() -> str:
    data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    key = data.get("gemini_api_key", "")
    if not key:
        raise RuntimeError("No gemini_api_key in settings.json")
    return key


def main() -> None:
    if not TEST_VIDEO.exists():
        logger.error("Test video not found: %s", TEST_VIDEO)
        sys.exit(1)

    api_key = load_api_key()
    http_client = HTTPClientImpl()

    structural = get_structural_metadata(str(TEST_VIDEO))
    duration: float = structural["duration"]  # type: ignore[assignment]
    logger.info("Video duration: %.1fs (%.1f min)", duration, duration / 60)

    assert duration > 2000, f"Expected 42-min video, got {duration:.0f}s"

    # Upload (may create proxy for 1.3 GB file)
    logger.info("Uploading video to Gemini...")
    t0 = time.monotonic()
    file_uri = _upload_file_to_gemini(str(TEST_VIDEO), api_key, http_client)
    logger.info("Upload complete in %.1fs: %s", time.monotonic() - t0, file_uri)

    import mimetypes
    mime_type = mimetypes.guess_type(str(TEST_VIDEO))[0] or "video/mp4"

    # Run chunked transcription
    logger.info("Starting chunked dialogue transcription...")
    t0 = time.monotonic()
    dialogue = _multipass_dialogue_chunked(
        file_uri, mime_type, duration, api_key, http_client,
    )
    elapsed = time.monotonic() - t0
    logger.info("Chunked transcription completed in %.1fs", elapsed)

    # Assertions
    logger.info("=== RESULTS ===")
    logger.info("Total dialogue lines: %d", len(dialogue))

    if dialogue:
        first_time = min(dl.start_time for dl in dialogue)
        last_time = max(dl.end_time for dl in dialogue)
        coverage_pct = (last_time / duration) * 100
        logger.info("First dialogue at: %.1fs", first_time)
        logger.info("Last dialogue at: %.1fs", last_time)
        logger.info("Coverage: %.1f%%", coverage_pct)

        # Check for content in the audio-improvements range (480-560s)
        audio_range_lines = [
            dl for dl in dialogue
            if dl.end_time > 480 and dl.start_time < 560
        ]
        logger.info("Lines in 480-560s (audio improvements): %d", len(audio_range_lines))
        for dl in audio_range_lines[:3]:
            logger.info("  [%.0fs-%.0fs] %s: %s", dl.start_time, dl.end_time, dl.speaker, dl.text[:80])

        # Check for content in the 944-1011s range (lip sync discussion)
        lipsync_lines = [
            dl for dl in dialogue
            if dl.end_time > 944 and dl.start_time < 1011
        ]
        logger.info("Lines in 944-1011s (lip sync): %d", len(lipsync_lines))
        for dl in lipsync_lines[:3]:
            logger.info("  [%.0fs-%.0fs] %s: %s", dl.start_time, dl.end_time, dl.speaker, dl.text[:80])

    else:
        coverage_pct = 0
        logger.error("NO DIALOGUE RETURNED")

    # Hard assertions
    errors: list[str] = []

    if len(dialogue) < 100:
        errors.append(f"FAIL: Expected > 100 dialogue lines, got {len(dialogue)}")

    if coverage_pct < 80:
        errors.append(f"FAIL: Expected > 80% coverage, got {coverage_pct:.1f}%")

    audio_range_lines = [
        dl for dl in dialogue if dl.end_time > 480 and dl.start_time < 560
    ]
    if len(audio_range_lines) == 0:
        errors.append("FAIL: No dialogue in 480-560s range (audio improvements section)")

    if errors:
        logger.error("=== TEST FAILED ===")
        for err in errors:
            logger.error(err)
        sys.exit(1)
    else:
        logger.info("=== ALL TESTS PASSED ===")
        sys.exit(0)


if __name__ == "__main__":
    main()
