"""Route handlers for generation APIs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from api_types import (
    CancelResponse,
    GenerateVideoRequest,
    GenerateVideoBatchRequest,
    GenerateVideoResponse,
    GenerationBatchResponse,
    GenerationBatchStatusResponse,
    GenerationJobResponse,
    GenerationJobStatusResponse,
    GenerationProgressResponse,
)
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api", tags=["generation"])


@router.post("/generate", response_model=GenerateVideoResponse)
def route_generate(
    req: GenerateVideoRequest,
    handler: AppHandler = Depends(get_state_service),
) -> GenerateVideoResponse:
    """POST /api/generate — video generation from JSON body."""
    return handler.video_generation.generate(req)


@router.post("/generations", response_model=GenerationJobResponse)
def route_generate_async(
    req: GenerateVideoRequest,
    handler: AppHandler = Depends(get_state_service),
) -> GenerationJobResponse:
    """POST /api/generations — enqueue an async API video generation."""
    return handler.video_generation.submit_async_generation(req)


@router.post("/generations/batches", response_model=GenerationBatchResponse)
def route_generate_batch(
    req: GenerateVideoBatchRequest,
    handler: AppHandler = Depends(get_state_service),
) -> GenerationBatchResponse:
    """POST /api/generations/batches — enqueue an async API generation batch."""
    return handler.video_generation.submit_generation_batch(req.requests)


@router.get("/generations/batches/{batch_id}", response_model=GenerationBatchStatusResponse)
def route_generate_batch_status(
    batch_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> GenerationBatchStatusResponse:
    """GET /api/generations/batches/{batch_id}."""
    return handler.video_generation.get_generation_batch_status(batch_id)


@router.post("/generations/batches/{batch_id}/cancel", response_model=CancelResponse)
def route_generate_batch_cancel(
    batch_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> CancelResponse:
    """POST /api/generations/batches/{batch_id}/cancel."""
    return handler.generation.cancel_generation(batch_id=batch_id)


@router.get("/generations/{generation_id}", response_model=GenerationJobStatusResponse)
def route_generate_status(
    generation_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> GenerationJobStatusResponse:
    """GET /api/generations/{generation_id}."""
    return handler.video_generation.get_async_generation_status(generation_id)


@router.post("/generations/{generation_id}/cancel", response_model=CancelResponse)
def route_generate_cancel_by_id(
    generation_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> CancelResponse:
    """POST /api/generations/{generation_id}/cancel."""
    return handler.generation.cancel_generation(generation_id=generation_id)


@router.post("/generate/cancel", response_model=CancelResponse)
def route_generate_cancel(
    generation_id: str | None = Query(default=None),
    batch_id: str | None = Query(default=None),
    handler: AppHandler = Depends(get_state_service),
) -> CancelResponse:
    """POST /api/generate/cancel."""
    return handler.generation.cancel_generation(generation_id=generation_id, batch_id=batch_id)


@router.get("/generation/progress", response_model=GenerationProgressResponse)
def route_generation_progress(
    generation_id: str | None = Query(default=None),
    handler: AppHandler = Depends(get_state_service),
) -> GenerationProgressResponse:
    """GET /api/generation/progress."""
    return handler.generation.get_generation_progress(generation_id=generation_id)
