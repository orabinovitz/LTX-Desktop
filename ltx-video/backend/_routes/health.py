"""Route handlers for /health and /api/gpu-info."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from api_types import GpuInfoResponse, HealthResponse
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def route_health(handler: AppHandler = Depends(get_state_service)) -> HealthResponse:
    return handler.health.get_health()


@router.get("/api/gpu-info", response_model=GpuInfoResponse)
def route_gpu_info(handler: AppHandler = Depends(get_state_service)) -> GpuInfoResponse:
    return handler.health.get_gpu_info()
