"""Route handlers for /api/models, /api/models/status, /api/models/download/*."""

from __future__ import annotations

import logging
import threading
from typing import Any

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)


def get_models() -> list[dict[str, Any]]:
    """GET /api/models"""
    import ltx2_server as _mod

    with _mod.settings_lock:
        fast_steps = _mod.app_settings.get("fast_model", {}).get("steps", 8)
        pro_steps = _mod.app_settings.get("pro_model", {}).get("steps", 20)
        pro_upscaler = _mod.app_settings.get("pro_model", {}).get("use_upscaler", True)

    return [
        {
            "id": "fast",
            "name": "Fast (Distilled)",
            "description": f"{fast_steps} steps + 2x upscaler",
        },
        {
            "id": "pro",
            "name": "Pro (Full)",
            "description": f"{pro_steps} steps"
            + (" + 2x upscaler" if pro_upscaler else " (native resolution)"),
        },
    ]


def get_models_status() -> dict[str, Any]:
    """GET /api/models/status"""
    import ltx2_server as _mod

    return _mod.get_models_status()


def get_download_progress() -> dict[str, Any]:
    """GET /api/models/download/progress"""
    import ltx2_server as _mod

    with _mod.model_download_lock:
        return {
            "status": _mod.model_download_state["status"],
            "currentFile": _mod.model_download_state["current_file"],
            "currentFileProgress": _mod.model_download_state["current_file_progress"],
            "totalProgress": _mod.model_download_state["total_progress"],
            "downloadedBytes": _mod.model_download_state["downloaded_bytes"],
            "totalBytes": _mod.model_download_state["total_bytes"],
            "filesCompleted": _mod.model_download_state["files_completed"],
            "totalFiles": _mod.model_download_state["total_files"],
            "error": _mod.model_download_state["error"],
            "speedMbps": _mod.model_download_state["speed_mbps"],
        }


def post_model_download(data: dict[str, Any]) -> dict[str, Any]:
    """POST /api/models/download"""
    import ltx2_server as _mod

    if _mod.model_download_state["status"] == "downloading":
        raise HTTPError(409, "Download already in progress")

    skip_text_encoder = data.get("skipTextEncoder", False) if data else False
    if _mod.app_settings.get("ltx_api_key"):
        skip_text_encoder = True

    if skip_text_encoder:
        logger.info("LTX API key configured - text encoder download will be skipped")

    started = _mod.start_model_download(skip_text_encoder=skip_text_encoder)
    if started:
        return {
            "status": "started",
            "message": "Model download started",
            "skippingTextEncoder": skip_text_encoder,
        }
    else:
        raise HTTPError(400, "Failed to start download")


def post_text_encoder_download() -> dict[str, Any]:
    """POST /api/text-encoder/download"""
    import ltx2_server as _mod

    if _mod.model_download_state["status"] == "downloading":
        raise HTTPError(409, "Download already in progress")

    text_encoder_path = _mod.GEMMA_PATH / "text_encoder"
    if text_encoder_path.exists() and any(text_encoder_path.iterdir()):
        return {"status": "already_downloaded", "message": "Text encoder already downloaded"}

    def download_text_encoder() -> None:
        try:
            with _mod.model_download_lock:
                _mod.model_download_state["status"] = "downloading"
                _mod.model_download_state["current_file"] = "text_encoder"
                _mod.model_download_state["total_files"] = 1
                _mod.model_download_state["files_completed"] = 0
                _mod.model_download_state["total_bytes"] = 8_000_000_000
                _mod.model_download_state["downloaded_bytes"] = 0

            logger.info("Downloading text encoder (~8 GB)...")
            from huggingface_hub import snapshot_download

            snapshot_download(
                repo_id="Lightricks/LTX-2",
                allow_patterns=["text_encoder/*"],
                local_dir=_mod.MODELS_DIR,
                local_dir_use_symlinks=False,
            )
            _mod._rename_text_encoder_files(_mod.MODELS_DIR / "text_encoder")

            with _mod.model_download_lock:
                _mod.model_download_state["status"] = "complete"
                _mod.model_download_state["total_progress"] = 100
                _mod.model_download_state["files_completed"] = 1
            logger.info("Text encoder download complete!")
        except Exception as e:
            logger.error(f"Text encoder download failed: {e}")
            with _mod.model_download_lock:
                _mod.model_download_state["status"] = "error"
                _mod.model_download_state["error"] = str(e)

    thread = threading.Thread(target=download_text_encoder, daemon=True)
    thread.start()
    return {"status": "started", "message": "Text encoder download started"}
