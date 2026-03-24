"""Handler for agent operations — video analysis and prompt execution."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

from agent.model_policy import LIVE_AUDIO_MODEL
from agent import brain as brain_module
from agent import gemini_agent, video_analyzer
from agent.scene_decomposer import decompose_to_scenes
from agent.tool_registry import tools_to_gemini_declarations
from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalysisStatus,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    ClarifyRequest,
    ClarifyResponse,
    IntentResolveRequest,
    IntentResolveResponse,
    LiveConfigResponse,
    LiveTokenResponse,
    OrchestrateContinueRequest,
    OrchestrateRequest,
    OrchestrateResponse,
    SkipTaskRequest,
    VideoMetadata,
)
from api_types import SuggestAssetMetaRequest, SuggestAssetMetaResponse
from agent.brain import ProjectBrain
from agent.scene_decomposer import SubClipDefinition
from handlers.base import StateHandlerBase
from services.http_client.http_client import HTTPClient, HttpTimeoutError
from state.app_state_types import AppState

logger = logging.getLogger(__name__)


class AgentHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, config: RuntimeConfig, http: HTTPClient) -> None:
        super().__init__(state, lock, config)
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

        session_id = request.session_id or ""
        return gemini_agent.continue_with_results(
            session_id=session_id,
            tool_results=request.tool_results,
            gemini_api_key=api_key,
            http_client=self._http,
            updated_context=request.updated_context,
        )

    # ------------------------------------------------------------------
    # Orchestrated multi-agent execution
    # ------------------------------------------------------------------

    def orchestrate(self, request: OrchestrateRequest) -> OrchestrateResponse:
        """Decompose a complex request into tasks and begin orchestrated execution."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return OrchestrateResponse(
                message="Gemini API key not configured. Set it in Settings.",
                done=True,
                status="error",
            )

        from agent.orchestration.orchestrator import Orchestrator
        orch = Orchestrator(api_key=api_key, http_client=self._http)
        return orch.start(request)

    def orchestrate_continue(self, request: OrchestrateContinueRequest) -> OrchestrateResponse:
        """Continue an orchestrated session with tool execution results."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return OrchestrateResponse(
                message="Gemini API key not configured.",
                done=True,
                status="error",
            )

        from agent.orchestration.orchestrator import Orchestrator
        orch = Orchestrator(api_key=api_key, http_client=self._http)
        return orch.continue_with_results(
            session_id=request.session_id,
            tool_results=request.tool_results,
            updated_context=request.updated_context,
        )

    def skip_task(self, request: SkipTaskRequest) -> OrchestrateResponse:
        """Skip a pending task in an orchestration session."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return OrchestrateResponse(
                message="Gemini API key not configured.",
                done=True,
                status="error",
            )

        from agent.orchestration.orchestrator import Orchestrator
        orch = Orchestrator(api_key=api_key, http_client=self._http)
        return orch.skip_task(
            session_id=request.session_id,
            task_id=request.task_id,
        )

    def classify_request_complexity(self, prompt: str) -> str:
        """Classify whether a request needs orchestration or the simple agent."""
        from agent.orchestration.complexity_router import classify_complexity
        return classify_complexity(prompt)

    def resolve_intent(self, request: IntentResolveRequest) -> IntentResolveResponse:
        """Resolve user intent by grounding prompt against project context."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            from agent.orchestration.complexity_router import classify_complexity
            return IntentResolveResponse(
                grounded_prompt=request.prompt,
                complexity=classify_complexity(request.prompt),
            )

        from agent.intent_resolver import resolve_intent
        result = resolve_intent(
            prompt=request.prompt,
            project_id=request.project_id,
            conversation_history=request.conversation_history,
            view_context=request.view_context,
            assets_context=request.assets_context,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        return IntentResolveResponse(
            grounded_prompt=result.grounded_prompt,
            complexity=result.complexity,
            relevant_memory_ids=result.relevant_memory_ids,
            intent_summary=result.intent_summary,
            requires_generation=result.requires_generation,
            diagnostics=result.diagnostics,
        )

    def clarify(self, request: ClarifyRequest) -> ClarifyResponse:
        """Generate clarification questions for a complex request."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return ClarifyResponse(needs_clarification=False)

        from agent.clarification_generator import generate_questions
        return generate_questions(
            request=request,
            gemini_api_key=api_key,
            http_client=self._http,
        )

    def suggest_asset_meta(self, request: SuggestAssetMetaRequest) -> SuggestAssetMetaResponse:
        """Suggest a short display name and tags for a generated asset."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return SuggestAssetMetaResponse()

        from agent import asset_namer
        result = asset_namer.suggest_asset_meta(
            prompt=request.prompt,
            asset_type=request.asset_type,
            existing_tags=request.existing_tags,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        if result is None:
            return SuggestAssetMetaResponse()
        return SuggestAssetMetaResponse(name=result.name, tags=result.tags)

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
            force=request.force,
        )
        return AnalyzeVideoResponse(
            status=AnalysisStatus.ANALYZING if started else AnalysisStatus.COMPLETE,
        )

    def get_video_metadata(self, asset_id: str) -> VideoMetadata | None:
        """Get cached video metadata."""
        return video_analyzer.get_metadata(asset_id)

    def get_brain(self, project_id: str) -> ProjectBrain | None:
        """Get the project brain summary."""
        return brain_module.get_brain(project_id)

    def build_brain(self, project_id: str, project_save_path: str | None = None) -> str:
        """Trigger a brain build from all analyzed video metadata.

        Returns a status string: 'building', 'no_metadata', or 'error'.
        """
        all_metadata = video_analyzer.get_all_complete_metadata()
        if not all_metadata:
            return "no_metadata"

        api_key = self._state.app_settings.gemini_api_key or ""
        if not api_key:
            return "error"

        brain_module.schedule_brain_build(
            project_id, all_metadata, api_key, self._http, project_save_path,
        )
        return "building"

    def clear_brain(self, project_id: str) -> bool:
        """Clear the brain for a project (suppresses auto-rebuild)."""
        return brain_module.clear_brain(project_id, suppress=True)

    def get_brain_summary(self, project_id: str) -> str:
        """Return the formatted brain summary text for display."""
        brain = brain_module.get_brain(project_id)
        if brain is None:
            return ""
        return brain_module.format_brain_for_agent(brain)

    def is_brain_suppressed(self, project_id: str) -> bool:
        """Check whether brain auto-rebuild is suppressed."""
        return brain_module.is_suppressed(project_id)

    def mark_brain_dirty(self, project_id: str) -> None:
        """Notify the brain that scenes have been decomposed."""
        brain_module.mark_dirty(project_id)

    def decompose_video(self, asset_id: str) -> tuple[list[SubClipDefinition], str | None]:
        """Decompose an analyzed video into scene-based sub-clips.

        Returns (subclips, error). If error is not None, subclips is empty.
        """
        metadata = video_analyzer.get_metadata(asset_id)
        if metadata is None:
            return [], f"No analysis found for asset {asset_id}. Analyze the video first."
        if metadata.analysis_status != AnalysisStatus.COMPLETE:
            return [], f"Video analysis is not complete (status: {metadata.analysis_status.value})."
        if not metadata.scenes:
            return [], "Video has no detected scenes to decompose."
        return decompose_to_scenes(metadata), None

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

        payload: dict[str, object] = {
            "uses": 1,
            "expireTime": expire_time.isoformat(),
            "newSessionExpireTime": new_session_expire_time.isoformat(),
            "bidiGenerateContentSetup": {
                "model": f"models/{LIVE_AUDIO_MODEL}",
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
                json_payload=payload,  # type: ignore[arg-type]
                timeout=15,
            )
        except HttpTimeoutError:
            logger.error("Ephemeral token request timed out", exc_info=True)
            return None
        except Exception:
            logger.error("Ephemeral token request failed", exc_info=True)
            return None

        if response.status_code != 200:
            logger.error(
                "Ephemeral token error HTTP %d: %s",
                response.status_code,
                response.text[:300],
            )
            return None

        raw_body = response.json()
        if not isinstance(raw_body, dict):
            logger.error("Ephemeral token response is not a dict: %s", str(raw_body))
            return None
        body = cast(dict[str, Any], raw_body)
        token_name = str(body.get("name", ""))
        if not token_name:
            logger.error("Ephemeral token response missing 'name': %s", body)
            return None

        return LiveTokenResponse(
            token=token_name,
            expire_time=expire_time.isoformat(),
            model=LIVE_AUDIO_MODEL,
        )

    def get_live_config(self) -> LiveConfigResponse:
        """Return Live API session configuration (system prompt + tools)."""
        return LiveConfigResponse(
            system_prompt=gemini_agent.SYSTEM_PROMPT,
            tools=tools_to_gemini_declarations(),
            model=LIVE_AUDIO_MODEL,
        )
