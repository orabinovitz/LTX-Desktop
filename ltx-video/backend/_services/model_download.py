"""Model download, status checking, and progress tracking logic."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def get_text_encoder_status_impl() -> dict[str, Any]:
    """Get the status of the text encoder model."""
    import ltx2_server as _mod

    text_encoder_path = _mod.GEMMA_PATH / "text_encoder"
    exists = text_encoder_path.exists() and any(text_encoder_path.iterdir()) if text_encoder_path.exists() else False
    size_bytes = sum(f.stat().st_size for f in text_encoder_path.rglob("*") if f.is_file()) if exists else 0
    expected_size = 8_000_000_000

    return {
        "downloaded": exists,
        "size_bytes": size_bytes if exists else expected_size,
        "size_gb": round(size_bytes / (1024**3), 1) if exists else round(expected_size / (1024**3), 1),
        "expected_size_gb": round(expected_size / (1024**3), 1),
    }


def get_models_status_impl(has_api_key: bool | None = None) -> dict[str, Any]:
    """Get detailed status of all required models."""
    import ltx2_server as _mod

    models: list[dict[str, Any]] = []
    total_size = 0
    downloaded_size = 0

    if has_api_key is None:
        has_api_key = bool(_mod.app_settings.get("ltx_api_key", ""))

    model_files = [
        ("ltx-2-19b-distilled-fp8.safetensors", _mod.CHECKPOINT_PATH, 19_000_000_000, "Main transformer model (FP8)"),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", _mod.UPSAMPLER_PATH, 1_000_000_000, "2x Upscaler"),
        ("ltx-2-19b-distilled-lora-384.safetensors", _mod.DISTILLED_LORA_PATH, 400_000_000, "LoRA for Pro model"),
    ]

    for name, path, expected_size, description in model_files:
        exists = path.exists()
        actual_size = path.stat().st_size if exists else 0
        total_size += expected_size
        if exists:
            downloaded_size += actual_size
        models.append({
            "name": name,
            "description": description,
            "downloaded": exists,
            "size": actual_size if exists else expected_size,
            "expected_size": expected_size,
            "required": True,
        })

    text_encoder_exists = _mod.GEMMA_PATH.exists() and any(_mod.GEMMA_PATH.iterdir()) if _mod.GEMMA_PATH.exists() else False
    text_encoder_size = sum(f.stat().st_size for f in _mod.GEMMA_PATH.rglob("*") if f.is_file()) if text_encoder_exists else 0
    expected_te_size = 8_000_000_000
    text_encoder_required = not has_api_key

    if text_encoder_required:
        total_size += expected_te_size
        if text_encoder_exists:
            downloaded_size += text_encoder_size

    models.append({
        "name": "text_encoder",
        "description": "Gemma text encoder" + (" (optional with API key)" if has_api_key else ""),
        "downloaded": text_encoder_exists,
        "size": text_encoder_size if text_encoder_exists else expected_te_size,
        "expected_size": expected_te_size,
        "is_folder": True,
        "required": text_encoder_required,
        "optional_reason": "Uses LTX API for text encoding" if has_api_key else None,
    })

    flux_exists = _mod.FLUX_MODELS_DIR.exists() and any(_mod.FLUX_MODELS_DIR.iterdir()) if _mod.FLUX_MODELS_DIR.exists() else False
    flux_size = sum(f.stat().st_size for f in _mod.FLUX_MODELS_DIR.rglob("*") if f.is_file()) if flux_exists else 0
    expected_flux_size = 15_000_000_000
    total_size += expected_flux_size
    if flux_exists:
        downloaded_size += flux_size

    models.append({
        "name": "FLUX.2-klein-4B",
        "description": "Flux model for text-to-image",
        "downloaded": flux_exists,
        "size": flux_size if flux_exists else expected_flux_size,
        "expected_size": expected_flux_size,
        "is_folder": True,
        "required": True,
    })

    all_downloaded = all(m["downloaded"] for m in models if m.get("required", True))

    return {
        "models": models,
        "all_downloaded": all_downloaded,
        "total_size": total_size,
        "downloaded_size": downloaded_size,
        "total_size_gb": round(total_size / (1024**3), 1),
        "downloaded_size_gb": round(downloaded_size / (1024**3), 1),
        "models_path": str(_mod.MODELS_DIR),
        "has_api_key": has_api_key,
        "text_encoder_status": get_text_encoder_status_impl(),
        "use_local_text_encoder": _mod.app_settings.get("use_local_text_encoder", False),
    }


def _rename_text_encoder_files(text_encoder_path: Path) -> None:
    """Rename text encoder files to match ltx_core expected pattern."""
    if not text_encoder_path.exists():
        return

    for f in text_encoder_path.glob("diffusion_pytorch_model*.safetensors"):
        new_name = f.name.replace("diffusion_pytorch_model", "model")
        new_path = f.parent / new_name
        if not new_path.exists():
            logger.info(f"Renaming {f.name} -> {new_name}")
            f.rename(new_path)

    index_file = text_encoder_path / "diffusion_pytorch_model.safetensors.index.json"
    new_index_file = text_encoder_path / "model.safetensors.index.json"
    if index_file.exists() and not new_index_file.exists():
        with open(index_file, "r") as f:
            index_data = json.load(f)

        if "weight_map" in index_data:
            new_weight_map = {}
            for key, value in index_data["weight_map"].items():
                new_value = value.replace("diffusion_pytorch_model", "model")
                new_weight_map[key] = new_value
            index_data["weight_map"] = new_weight_map

        with open(new_index_file, "w") as f:
            json.dump(index_data, f, indent=2)

        index_file.unlink()
        logger.info("Updated text encoder index file")


def download_models_impl() -> None:
    """Download required models from Hugging Face if not present."""
    import ltx2_server as _mod
    from huggingface_hub import hf_hub_download, snapshot_download

    repo_id = "Lightricks/LTX-2"

    models_to_download = [
        ("ltx-2-19b-distilled-fp8.safetensors", _mod.CHECKPOINT_PATH),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", _mod.UPSAMPLER_PATH),
        ("ltx-2-19b-distilled-lora-384.safetensors", _mod.DISTILLED_LORA_PATH),
    ]

    for filename, local_path in models_to_download:
        if not local_path.exists():
            logger.info(f"Downloading {filename}...")
            hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=_mod.MODELS_DIR,
                local_dir_use_symlinks=False,
            )
            logger.info(f"Downloaded {filename}")
        else:
            logger.info(f"Found {filename}")

    text_encoder_dir = _mod.GEMMA_PATH / "text_encoder"
    if not text_encoder_dir.exists() or not any(text_encoder_dir.iterdir()):
        logger.info("Downloading text_encoder...")
        snapshot_download(
            repo_id=repo_id,
            allow_patterns=["text_encoder/*"],
            local_dir=_mod.MODELS_DIR,
            local_dir_use_symlinks=False,
        )
        _rename_text_encoder_files(_mod.MODELS_DIR / "text_encoder")
        logger.info("Downloaded text_encoder")
    else:
        logger.info("Found text_encoder")


def download_models_with_progress_impl(skip_text_encoder: bool = False) -> None:
    """Download models with progress tracking. Runs in a background thread."""
    import ltx2_server as _mod
    from huggingface_hub import hf_hub_download, snapshot_download

    repo_id = "Lightricks/LTX-2"

    models_to_download = [
        ("ltx-2-19b-distilled-fp8.safetensors", _mod.CHECKPOINT_PATH, 19_000_000_000),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", _mod.UPSAMPLER_PATH, 1_000_000_000),
        ("ltx-2-19b-distilled-lora-384.safetensors", _mod.DISTILLED_LORA_PATH, 400_000_000),
    ]

    files_to_download: list[tuple[str, Path, int, bool, str]] = []
    total_bytes = 0

    for filename, local_path, expected_size in models_to_download:
        if not local_path.exists():
            files_to_download.append((filename, local_path, expected_size, False, repo_id))
            total_bytes += expected_size

    if not skip_text_encoder:
        text_encoder_dir = _mod.GEMMA_PATH / "text_encoder"
        text_encoder_needs_download = not text_encoder_dir.exists() or not any(text_encoder_dir.iterdir()) if text_encoder_dir.exists() else True
        if text_encoder_needs_download:
            files_to_download.append(("text_encoder", _mod.GEMMA_PATH, 8_000_000_000, True, "Lightricks/LTX-2"))
            total_bytes += 8_000_000_000
    else:
        logger.info("Skipping text encoder download (using LTX API for text encoding)")

    flux_needs_download = not _mod.FLUX_MODELS_DIR.exists() or not any(_mod.FLUX_MODELS_DIR.iterdir()) if _mod.FLUX_MODELS_DIR.exists() else True
    if flux_needs_download:
        files_to_download.append(("FLUX.2-klein-4B", _mod.FLUX_MODELS_DIR, 15_000_000_000, True, "black-forest-labs/FLUX.2-klein-4B"))
        total_bytes += 15_000_000_000

    if not files_to_download:
        with _mod.model_download_lock:
            _mod.model_download_state["status"] = "complete"
            _mod.model_download_state["total_progress"] = 100
        return

    with _mod.model_download_lock:
        _mod.model_download_state["status"] = "downloading"
        _mod.model_download_state["total_files"] = len(files_to_download)
        _mod.model_download_state["files_completed"] = 0
        _mod.model_download_state["total_bytes"] = total_bytes
        _mod.model_download_state["downloaded_bytes"] = 0
        _mod.model_download_state["error"] = None

    downloaded_so_far = 0

    try:
        for i, (filename, local_path, expected_size, is_folder, file_repo_id) in enumerate(files_to_download):
            with _mod.model_download_lock:
                _mod.model_download_state["current_file"] = filename
                _mod.model_download_state["current_file_progress"] = 0

            logger.info(f"Downloading {filename} ({i + 1}/{len(files_to_download)}) from {file_repo_id}...")

            if is_folder:
                if filename == "text_encoder":
                    snapshot_download(
                        repo_id=file_repo_id,
                        allow_patterns=["text_encoder/*"],
                        local_dir=_mod.MODELS_DIR,
                        local_dir_use_symlinks=False,
                    )
                    _rename_text_encoder_files(_mod.MODELS_DIR / "text_encoder")
                else:
                    snapshot_download(
                        repo_id=file_repo_id,
                        local_dir=str(local_path),
                        local_dir_use_symlinks=False,
                    )
            else:
                hf_hub_download(
                    repo_id=file_repo_id,
                    filename=filename,
                    local_dir=_mod.MODELS_DIR,
                    local_dir_use_symlinks=False,
                )

            downloaded_so_far += expected_size

            with _mod.model_download_lock:
                _mod.model_download_state["files_completed"] = i + 1
                _mod.model_download_state["downloaded_bytes"] = downloaded_so_far
                _mod.model_download_state["current_file_progress"] = 100
                _mod.model_download_state["total_progress"] = int((downloaded_so_far / total_bytes) * 100)

            logger.info(f"Downloaded {filename}")

        with _mod.model_download_lock:
            _mod.model_download_state["status"] = "complete"
            _mod.model_download_state["total_progress"] = 100

        logger.info("All models downloaded successfully!")

    except Exception as e:
        logger.error(f"Model download failed: {e}")
        with _mod.model_download_lock:
            _mod.model_download_state["status"] = "error"
            _mod.model_download_state["error"] = str(e)


def start_model_download_impl(skip_text_encoder: bool = False) -> bool:
    """Start model download in a background thread."""
    import threading

    import ltx2_server as _mod

    if _mod.model_download_state["status"] == "downloading":
        return False

    thread = threading.Thread(
        target=download_models_with_progress_impl,
        args=(skip_text_encoder,),
        daemon=True,
    )
    thread.start()
    return True
