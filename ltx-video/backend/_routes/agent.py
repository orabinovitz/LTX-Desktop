"""Route handlers for /api/agent/* endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    LiveConfigResponse,
    LiveTokenResponse,
)
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
) -> dict:
    metadata = handler.agent.get_video_metadata(asset_id)
    if metadata is None:
        return {"status": "not_found"}
    return metadata.model_dump(mode="json")


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
