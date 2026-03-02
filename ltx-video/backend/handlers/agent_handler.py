"""Handler for agent operations — video analysis and prompt execution."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from threading import RLock

from agent import gemini_agent, video_analyzer
from agent.tool_registry import tools_to_gemini_declarations
from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalysisStatus,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    LiveConfigResponse,
    LiveTokenResponse,
    VideoMetadata,
)
from handlers.base import StateHandlerBase
from services.http_client.http_client import HTTPClient, HttpTimeoutError
from state.app_state_types import AppState

logger = logging.getLogger(__name__)

_LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"


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
            logger.warning("Video analysis requested but Gemini API key not configured")
            return AnalyzeVideoResponse(status=AnalysisStatus.FAILED)

        started = video_analyzer.analyze_video_background(
            asset_id=request.asset_id,
            file_path=request.file_path,
            gemini_api_key=api_key,
            http_client=self._http,
            project_save_path=request.project_save_path,
        )
        return AnalyzeVideoResponse(
            status=AnalysisStatus.ANALYZING if started else AnalysisStatus.COMPLETE,
        )

    def get_video_metadata(self, asset_id: str) -> VideoMetadata | None:
        """Get cached video metadata."""
        return video_analyzer.get_metadata(asset_id)

    def create_live_token(self) -> LiveTokenResponse | None:
        """Mint a short-lived ephemeral token for client-side Live API access."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return None

        expire_time = datetime.now(tz=timezone.utc) + timedelta(minutes=30)
        new_session_expire_time = datetime.now(tz=timezone.utc) + timedelta(minutes=2)

        url = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
        tool_declarations = tools_to_gemini_declarations()
        for decl in tool_declarations:
            decl["behavior"] = "NON_BLOCKING"

        payload = {
            "uses": 1,
            "expireTime": expire_time.isoformat(),
            "newSessionExpireTime": new_session_expire_time.isoformat(),
            "bidiGenerateContentSetup": {
                "model": f"models/{_LIVE_API_MODEL}",
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                },
                "systemInstruction": {
                    "parts": [{"text": gemini_agent.SYSTEM_PROMPT}],
                },
                "tools": [{"functionDeclarations": tool_declarations}],
            },
        }

        try:
            response = self._http.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=15,
            )
        except HttpTimeoutError:
            logger.error("Ephemeral token request timed out")
            return None
        except Exception:
            logger.exception("Ephemeral token request failed")
            return None

        if response.status_code != 200:
            logger.error(
                "Ephemeral token error HTTP %d: %s",
                response.status_code,
                response.text[:300],
            )
            return None

        body = response.json()
        token_name = body.get("name", "") if isinstance(body, dict) else ""
        if not token_name:
            logger.error("Ephemeral token response missing 'name': %s", body)
            return None

        return LiveTokenResponse(
            token=token_name,
            expire_time=expire_time.isoformat(),
            model=_LIVE_API_MODEL,
        )

    def get_live_config(self) -> LiveConfigResponse:
        """Return Live API session configuration (system prompt + tools)."""
        return LiveConfigResponse(
            system_prompt=gemini_agent.SYSTEM_PROMPT,
            tools=tools_to_gemini_declarations(),
            model=_LIVE_API_MODEL,
        )
