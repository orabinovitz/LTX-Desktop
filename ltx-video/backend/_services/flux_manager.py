"""Flux model download, loading, and GPU management."""

from __future__ import annotations

import gc
import logging
import time
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from diffusers import Flux2KleinPipeline

logger = logging.getLogger(__name__)


def download_flux_model_impl() -> bool:
    """Download FLUX.2 Klein 4B model if not present."""
    import ltx2_server as _mod

    if _mod.FLUX_MODELS_DIR.exists() and any(_mod.FLUX_MODELS_DIR.iterdir()):
        logger.info("Found FLUX.2 Klein 4B model")
        return True

    logger.info("Downloading FLUX.2 Klein 4B model...")
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(
            repo_id="black-forest-labs/FLUX.2-klein-4B",
            local_dir=str(_mod.FLUX_MODELS_DIR),
        )
        logger.info("FLUX.2 Klein 4B downloaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to download FLUX.2 Klein 4B: {e}")
        return False


def load_flux_pipeline_impl(to_gpu: bool = True) -> Flux2KleinPipeline | None:
    """Load the Flux Klein 4B pipeline for image generation."""
    import torch

    import ltx2_server as _mod

    if _mod.flux_pipeline is not None:
        return _mod.flux_pipeline

    try:
        from diffusers import Flux2KleinPipeline

        target = "GPU" if to_gpu else "CPU (preloading)"
        logger.info(f"Loading FLUX.2 Klein 4B Pipeline to {target}...")
        start = time.time()

        if to_gpu:
            _mod.empty_device_cache()
            gc.collect()

        if _mod.FLUX_MODELS_DIR.exists() and any(_mod.FLUX_MODELS_DIR.iterdir()):
            model_path = str(_mod.FLUX_MODELS_DIR)
            logger.info(f"Loading from project folder: {model_path}")
        else:
            logger.info("FLUX.2 Klein 4B not found locally, downloading...")
            if not _mod.download_flux_model():
                raise RuntimeError("Failed to download FLUX.2 Klein 4B model")
            model_path = str(_mod.FLUX_MODELS_DIR)

        _mod.flux_pipeline = Flux2KleinPipeline.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
        )

        if to_gpu:
            _mod.flux_pipeline.to(_mod.DEVICE)
            logger.info(f"FLUX.2 Klein 4B Pipeline loaded to GPU in {time.time() - start:.1f}s")
        else:
            logger.info(f"FLUX.2 Klein 4B Pipeline preloaded to CPU RAM in {time.time() - start:.1f}s")

        return _mod.flux_pipeline

    except Exception as e:
        logger.error(f"Failed to load Flux pipeline: {e}")
        import traceback
        traceback.print_exc()
        return None


def get_flux_pipeline_impl() -> Flux2KleinPipeline | None:
    """Get or load the Flux pipeline, ensuring it's on GPU."""
    import ltx2_server as _mod

    if _mod.flux_pipeline is None:
        if _mod.distilled_pipeline is not None:
            _mod.unload_pipeline("fast")
        if _mod.distilled_native_pipeline is not None:
            _mod.unload_pipeline("fast-native")
        if _mod.pro_pipeline is not None:
            _mod.unload_pipeline("pro")
        if _mod.pro_native_pipeline is not None:
            _mod.unload_pipeline("pro-native")
        _mod.empty_device_cache()
        gc.collect()
        _mod.load_flux_pipeline(to_gpu=True)
        _mod.flux_on_gpu = True
    elif not _mod.flux_on_gpu:
        logger.info("Moving preloaded Flux pipeline from CPU to GPU...")
        start = time.time()
        if _mod.distilled_pipeline is not None:
            _mod.unload_pipeline("fast")
        if _mod.distilled_native_pipeline is not None:
            _mod.unload_pipeline("fast-native")
        if _mod.pro_pipeline is not None:
            _mod.unload_pipeline("pro")
        if _mod.pro_native_pipeline is not None:
            _mod.unload_pipeline("pro-native")
        _mod.empty_device_cache()
        gc.collect()
        _mod.flux_pipeline.to(_mod.DEVICE)
        _mod.flux_on_gpu = True
        logger.info(f"Flux pipeline moved to GPU in {time.time() - start:.1f}s")

    return _mod.flux_pipeline
