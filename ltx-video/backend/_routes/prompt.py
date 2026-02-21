"""Route handlers for /api/enhance-prompt, /api/suggest-gap-prompt."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from api_types import (
    EnhancePromptRequest,
    EnhancePromptResponse,
    SuggestGapPromptRequest,
    SuggestGapPromptResponse,
)
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api", tags=["prompt"])


@router.post("/enhance-prompt", response_model=EnhancePromptResponse)
def route_enhance_prompt(
    req: EnhancePromptRequest,
    handler: AppHandler = Depends(get_state_service),
) -> EnhancePromptResponse:
    return handler.prompt.enhance(req)


@router.post("/suggest-gap-prompt", response_model=SuggestGapPromptResponse)
def route_suggest_gap_prompt(
    req: SuggestGapPromptRequest,
    handler: AppHandler = Depends(get_state_service),
) -> SuggestGapPromptResponse:
    return handler.prompt.suggest_gap(req)
