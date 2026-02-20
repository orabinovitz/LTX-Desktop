"""Route handlers for /health and /api/gpu-info."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from _models import HealthResponse, GpuInfoResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def route_health():
    return get_health()


@router.get("/api/gpu-info", response_model=GpuInfoResponse)
async def route_gpu_info():
    return get_gpu_info()


def get_health() -> dict[str, Any]:
    """GET /health"""
    import ltx2_server as _mod

    active_model: str | None = None
    if _mod.distilled_pipeline is not None:
        active_model = "fast"
    elif _mod.pro_pipeline is not None:
        active_model = "pro"
    elif _mod.pro_native_pipeline is not None:
        active_model = "pro-native"

    return {
        "status": "ok",
        "models_loaded": (
            _mod.distilled_pipeline is not None
            or _mod.pro_pipeline is not None
            or _mod.pro_native_pipeline is not None
        ),
        "active_model": active_model,
        "fast_loaded": _mod.distilled_pipeline is not None,
        "pro_loaded": _mod.pro_pipeline is not None,
        "pro_native_loaded": _mod.pro_native_pipeline is not None,
        "gpu_info": _mod.get_gpu_info(),
        "sage_attention": _mod.USE_SAGE_ATTENTION,
        "models_status": [
            {
                "id": "fast",
                "name": "LTX-2 Fast (Distilled)",
                "loaded": _mod.distilled_pipeline is not None,
                "downloaded": _mod.CHECKPOINT_PATH.exists(),
            },
            {
                "id": "pro",
                "name": "LTX-2 Pro (Two-Stage)",
                "loaded": _mod.pro_pipeline is not None,
                "downloaded": _mod.CHECKPOINT_PATH.exists(),
            },
            {
                "id": "pro-native",
                "name": "LTX-2 Pro Native (One-Stage)",
                "loaded": _mod.pro_native_pipeline is not None,
                "downloaded": _mod.CHECKPOINT_PATH.exists(),
            },
        ],
    }


def get_gpu_info() -> dict[str, Any]:
    """GET /api/gpu-info"""
    import os
    import ltx2_server as _mod

    import torch

    gpu_info = _mod.get_gpu_info()
    cuda_available = torch.cuda.is_available()
    mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    gpu_available = cuda_available or mps_available
    gpu_name: str | None = None
    vram_gb: int | None = None

    if cuda_available:
        try:
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory // (1024**3)
        except Exception as e:
            print(f"Error getting detailed GPU info: {e}")
    elif mps_available:
        gpu_name = "Apple Silicon (MPS)"
        try:
            vram_gb = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') // (1024**3)
        except Exception:
            pass

    return {
        "cuda_available": cuda_available,
        "mps_available": mps_available,
        "gpu_available": gpu_available,
        "gpu_name": gpu_name,
        "vram_gb": vram_gb,
        "gpu_info": gpu_info,
    }
