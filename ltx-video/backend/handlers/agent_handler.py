"""Handler for agent operations — video analysis and prompt execution."""

from __future__ import annotations

import logging
from threading import RLock

from agent import gemini_agent, video_analyzer
from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalysisStatus,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    VideoMetadata,
)
from handlers.base import StateHandlerBase
from services.interfaces import HTTPClient
from state.app_state_types import AppState

logger = logging.getLogger(__name__)


class AgentHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, http: HTTPClient) -> None:
        super().__init__(state, lock)
        self._http = http

    def execute(self, request: AgentExecuteRequest) -> AgentExecuteResponse:
        """Execute an agent prompt — start a new agentic session."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AgentExecuteResponse(
                message="Gemini API key not configured. Set it in Settings.",
                done=True,
            )

        session_id, response = gemini_agent.execute_prompt(
            request=request,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        response.session_id = session_id
        return response

    def continue_session(self, request: AgentContinueRequest) -> AgentExecuteResponse:
        """Continue an agentic session with tool execution results."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AgentExecuteResponse(
                message="Gemini API key not configured.",
                done=True,
            )

        return gemini_agent.continue_with_results(
            session_id=request.session_id,
            tool_results=request.tool_results,
            gemini_api_key=api_key,
            http_client=self._http,
        )

    def analyze_video(self, request: AnalyzeVideoRequest) -> AnalyzeVideoResponse:
        """Start background video analysis."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AnalyzeVideoResponse(status=AnalysisStatus.FAILED)

        started = video_analyzer.analyze_video_background(
            asset_id=request.asset_id,
            file_path=request.file_path,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        return AnalyzeVideoResponse(
            status=AnalysisStatus.ANALYZING if started else AnalysisStatus.COMPLETE,
        )

    def get_video_metadata(self, asset_id: str) -> VideoMetadata | None:
        """Get cached video metadata."""
        return video_analyzer.get_metadata(asset_id)
