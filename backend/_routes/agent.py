"""Route handlers for /api/agent/* endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    DecomposeVideoResponse,
    LiveConfigResponse,
    LiveTokenResponse,
    SubClipInfo,
)
from agent import brain as brain_module
from agent import video_analyzer
from agent.scene_decomposer import decompose_to_scenes
from app_handler import AppHandler
from state import get_state_service

router = APIRouter(prefix="/api", tags=["agent"])


@router.post("/agent/execute", response_model=AgentExecuteResponse)
def route_agent_execute(
    req: AgentExecuteRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.execute(req)


@router.post("/agent/continue", response_model=AgentExecuteResponse)
def route_agent_continue(
    req: AgentContinueRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.continue_session(req)


@router.post("/agent/analyze-video", response_model=AnalyzeVideoResponse)
def route_analyze_video(
    req: AnalyzeVideoRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AnalyzeVideoResponse:
    return handler.agent.analyze_video(req)


@router.get("/agent/video-metadata/{asset_id}")
def route_get_video_metadata(
    asset_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, object]:
    metadata = handler.agent.get_video_metadata(asset_id)
    if metadata is None:
        return {"status": "not_found"}
    result: dict[str, object] = metadata.model_dump(mode="json")
    return result


@router.get("/agent/brain/{project_id}")
def route_get_brain(
    project_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, object]:
    """Get the project brain summary."""
    b = brain_module.get_brain(project_id)
    if b is None:
        return {"status": "not_found"}
    result: dict[str, object] = b.model_dump(mode="json")
    return result


@router.post("/agent/brain/{project_id}/build")
def route_build_brain(
    project_id: str,
    project_save_path: str | None = None,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Trigger a brain build from all analyzed video metadata."""
    all_metadata = [
        m for m in video_analyzer.get_all_complete_metadata()
        if m.analysis_status.value == "complete"
    ]
    if not all_metadata:
        return {"status": "no_metadata", "message": "No completed video analyses found."}

    settings = handler.settings.get_settings_snapshot()
    api_key = settings.gemini_api_key or ""
    if not api_key:
        return {"status": "error", "message": "No Gemini API key configured."}

    brain_module.schedule_brain_build(
        project_id, all_metadata, api_key, handler.http, project_save_path,
    )
    return {"status": "building", "message": "Brain build started in background."}


@router.post("/agent/brain/{project_id}/notify-decomposition")
def route_notify_decomposition(
    project_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Notify the brain that scenes have been decomposed (marks dirty)."""
    brain_module.mark_dirty(project_id)
    return {"status": "ok"}


@router.post("/agent/decompose-video/{asset_id}", response_model=DecomposeVideoResponse)
def route_decompose_video(
    asset_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> DecomposeVideoResponse:
    """Decompose an analyzed video into scene-based sub-clips."""
    metadata = video_analyzer.get_metadata(asset_id)
    if metadata is None:
        return DecomposeVideoResponse(error=f"No analysis found for asset {asset_id}. Analyze the video first.")
    if metadata.analysis_status.value != "complete":
        return DecomposeVideoResponse(error=f"Video analysis is not complete (status: {metadata.analysis_status.value}).")
    if not metadata.scenes:
        return DecomposeVideoResponse(error="Video has no detected scenes to decompose.")

    subclip_defs = decompose_to_scenes(metadata)
    subclips = [
        SubClipInfo(
            parent_asset_id=sc.parent_asset_id,
            source_in=sc.source_in,
            source_out=sc.source_out,
            title=sc.title,
            description=sc.description,
            transcript=sc.transcript,
            topics=sc.topics,
            scene_indices=sc.scene_indices,
        )
        for sc in subclip_defs
    ]
    return DecomposeVideoResponse(subclips=subclips)


@router.post("/agent/live-token", response_model=LiveTokenResponse)
def route_create_live_token(
    handler: AppHandler = Depends(get_state_service),
) -> LiveTokenResponse:
    """Mint a short-lived ephemeral token for client-side Live API access."""
    result = handler.agent.create_live_token()
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="Unable to create Live API token. Check your Gemini API key in Settings.",
        )
    return result


@router.get("/agent/live-config", response_model=LiveConfigResponse)
def route_get_live_config(
    handler: AppHandler = Depends(get_state_service),
) -> LiveConfigResponse:
    """Return system prompt and tool declarations for Live API sessions."""
    return handler.agent.get_live_config()
