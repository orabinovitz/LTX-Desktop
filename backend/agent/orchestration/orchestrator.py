"""Orchestrator: the brain of the multi-agent system.

Decomposes complex requests into a DAG of tasks, dispatches them
to specialized sub-agents (or the general brain), reviews results,
and loops until all tasks are complete.

Supports multi-round sub-agent execution: when a sub-agent returns
frontend tool calls, the orchestrator preserves the sub-agent session
and resumes it after the frontend executes the tools.

Session state is held in memory with TTL-based eviction.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, cast

from agent.model_policy import AgentStage, select_model
from agent.orchestration.creative_contracts import (
    CoverageValidationIssue,
    CreativeProfile,
    validate_shot_plan,
)
from agent.orchestration.complexity_router import (
    RequestComplexity,
    classify_complexity,
)
from agent.orchestration.skill_router import SkillRouter
from agent.orchestration.sub_agent_pool import SubAgentPool
from agent.orchestration.task_planner import TaskPlanner
from agent.skills.skill_registry import SkillRegistry, get_skill_registry
from agent.types import (
    AgentDiagnostics,
    MEMORY_WRITE_TOOLS,
    OrchestrateRequest,
    OrchestrateResponse,
    OrchestrateTaskInfo,
    OrchestratorStatus,
    SkillContent,
    SubAgentContext,
    SubAgentResult,
    TaskDAG,
    TaskNode,
    TaskStatus,
    TaskType,
    ToolCall,
    ToolResult,
)
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_MAX_SESSIONS = 20
_SESSION_TTL_SECONDS = 1800
_MAX_TASK_RETRIES = 2
_MAX_COVERAGE_REPAIRS_PER_TASK = 1
_MAX_DAG_TASKS = 75
_MAX_REVIEW_ITERATIONS = 2
_MAX_SHOTS_PER_EXPANSION = 40
_MAX_PARALLEL_SHOT_TASKS = 4
_MAX_SHOT_REGENERATIONS_PER_SHOT = 1


def _results_have_memory_writes(results: list[SubAgentResult]) -> bool:
    """Check if any sub-agent result includes memory-write tool executions."""
    return any(
        any(tr.call_id.startswith(tool_name) for tool_name in MEMORY_WRITE_TOOLS)
        for r in results
        for tr in r.backend_tool_results
    )


@dataclass
class OrchestratorSession:
    id: str
    dag: TaskDAG
    status: OrchestratorStatus
    pending_tool_calls: list[ToolCall] = field(default_factory=lambda: list[ToolCall]())
    pending_task_ids: list[str] = field(default_factory=lambda: list[str]())
    active_sub_agent_results: dict[str, SubAgentResult] = field(default_factory=lambda: dict[str, SubAgentResult]())
    task_tool_call_counts: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    timeline_context: str | None = None
    assets_context: str | None = None
    project_id: str | None = None
    view_context: str = "editor"
    last_access: float = field(default_factory=time.monotonic)
    review_iteration_count: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    coverage_repair_count: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    shot_regeneration_count: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    generated_image_count: int = 0
    generated_video_count: int = 0
    reference_hit_count: int = 0
    reference_miss_count: int = 0
    retry_cause_counts: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    sub_agent_timeout_count: int = 0
    provider_error_count: int = 0
    last_diagnostics: AgentDiagnostics | None = None


_sessions: OrderedDict[str, OrchestratorSession] = OrderedDict()


def _evict_stale_sessions() -> None:
    now = time.monotonic()
    stale = [sid for sid, s in _sessions.items() if now - s.last_access > _SESSION_TTL_SECONDS]
    for sid in stale:
        del _sessions[sid]
    while len(_sessions) > _MAX_SESSIONS:
        _sessions.popitem(last=False)


def _get_session(session_id: str) -> OrchestratorSession | None:
    s = _sessions.get(session_id)
    if s:
        s.last_access = time.monotonic()
        _sessions.move_to_end(session_id)
    return s


def _task_to_info(task: TaskNode, registry: SkillRegistry) -> OrchestrateTaskInfo:
    skill_name: str | None = None
    if task.skill_id:
        content = registry.get_skill_content(task.skill_id)
        if content:
            skill_name = content.descriptor.name

    return OrchestrateTaskInfo(
        id=task.id,
        description=task.description,
        skill_id=task.skill_id,
        skill_name=skill_name,
        depends_on=task.depends_on,
        status=task.status.value,
        error=task.error,
    )


def _build_response(
    session: OrchestratorSession,
    registry: SkillRegistry,
    *,
    tool_calls: list[ToolCall] | None = None,
    message: str = "",
    done: bool = False,
    memory_updated: bool = False,
    diagnostics: AgentDiagnostics | None = None,
) -> OrchestrateResponse:
    current_task_id = session.pending_task_ids[0] if session.pending_task_ids else None
    return OrchestrateResponse(
        session_id=session.id,
        status=session.status.value,
        tasks=[_task_to_info(t, registry) for t in session.dag.tasks],
        current_task_id=current_task_id,
        tool_calls=tool_calls or [],
        message=message,
        done=done,
        memory_updated=memory_updated,
        diagnostics=diagnostics or session.last_diagnostics,
    )


class Orchestrator:
    """Central coordinator for multi-agent task execution."""

    def __init__(
        self,
        api_key: str,
        http_client: HTTPClient,
        skill_registry: SkillRegistry | None = None,
    ) -> None:
        self._api_key = api_key
        self._http_client = http_client
        self._registry = skill_registry or get_skill_registry()
        self._planner = TaskPlanner(api_key, http_client)
        self._pool = SubAgentPool(api_key, http_client)

    def classify_request(self, prompt: str) -> RequestComplexity:
        return classify_complexity(prompt)

    def start(self, request: OrchestrateRequest) -> OrchestrateResponse:
        _evict_stale_sessions()

        session_id = uuid.uuid4().hex
        t0 = time.monotonic()
        descriptors = self._registry.get_all_descriptors()

        timeline_ctx = self._format_timeline(request.timeline_state) if request.timeline_state else None
        assets_ctx = str(request.assets_context) if request.assets_context else None

        memory_ctx: str | None = None
        if request.project_id:
            from agent import project_memory
            if project_memory.has_memory(request.project_id):
                memory_ctx = project_memory.format_memory_for_agent(request.project_id)

        conversation_ctx: str | None = None
        if request.conversation_history:
            recent = request.conversation_history[-3:]
            conv_lines: list[str] = []
            for msg in recent:
                content = msg.content[:500]
                if len(msg.content) > 500:
                    content += "..."
                conv_lines.append(f"[{msg.role}]: {content}")
            conversation_ctx = "\n".join(conv_lines)

        logger.info(
            "[orchestrator] session=%s | planning: %.80s",
            session_id[:8], request.prompt,
        )
        planner_selection = select_model(AgentStage.ORCHESTRATOR_PLANNER, prompt=request.prompt)

        dag = self._planner.decompose(
            request.prompt,
            descriptors,
            timeline_context=timeline_ctx,
            assets_context=assets_ctx,
            memory_context=memory_ctx,
            conversation_context=conversation_ctx,
        )

        if len(dag.tasks) > _MAX_DAG_TASKS:
            dag.tasks = dag.tasks[:_MAX_DAG_TASKS]

        session = OrchestratorSession(
            id=session_id,
            dag=dag,
            status=OrchestratorStatus.EXECUTING,
            timeline_context=timeline_ctx,
            assets_context=assets_ctx,
            project_id=request.project_id,
            view_context=request.view_context.value if request.view_context else "editor",
        )
        _sessions[session_id] = session

        planning_elapsed = time.monotonic() - t0
        session.last_diagnostics = AgentDiagnostics(
            selected_model=planner_selection.model,
            stage_name=AgentStage.ORCHESTRATOR_PLANNER.value,
            planning_ms=int(planning_elapsed * 1000),
        )
        logger.info(
            "[orchestrator] session=%s | DAG has %d task(s) (planned in %.1fs): %s",
            session_id[:8],
            len(dag.tasks),
            planning_elapsed,
            [(t.id, t.task_type.value) for t in dag.tasks],
        )

        return _build_response(
            session, self._registry,
            message="Plan ready. Starting execution.",
            diagnostics=session.last_diagnostics,
        )

    def skip_task(self, session_id: str, task_id: str) -> OrchestrateResponse:
        """Mark a pending task as cancelled (skipped by user).

        Does NOT cascade to dependents — downstream tasks can still proceed
        since CANCELLED is a terminal state in ``get_ready_tasks()``.
        """
        session = _get_session(session_id)
        if session is None:
            return OrchestrateResponse(
                session_id=session_id,
                status="error",
                message="Session not found or expired.",
                done=True,
            )

        task = session.dag.get_task(task_id)
        if task is None:
            return _build_response(
                session, self._registry,
                message=f"Task '{task_id}' not found.",
            )

        if task.status != TaskStatus.PENDING:
            return _build_response(
                session, self._registry,
                message=f"Task '{task_id}' is {task.status.value}, only pending tasks can be skipped.",
            )

        task.status = TaskStatus.CANCELLED
        task.error = "Skipped by user"
        logger.info("[orchestrator] session=%s | task %s skipped by user", session_id[:8], task_id)

        return _build_response(session, self._registry)

    def continue_with_results(
        self,
        session_id: str,
        tool_results: list[ToolResult],
        updated_context: str | None = None,
    ) -> OrchestrateResponse:
        session = _get_session(session_id)
        if session is None:
            return OrchestrateResponse(
                session_id=session_id,
                status="error",
                message="Session not found or expired.",
                done=True,
            )

        if updated_context:
            session.timeline_context = updated_context

        if not tool_results:
            session.pending_task_ids = []
            session.pending_tool_calls = []
            return self._execute_next(session)

        pending_ids = list(session.pending_task_ids)
        has_active_sub_agents = bool(session.active_sub_agent_results)

        if has_active_sub_agents and pending_ids:
            return self._resume_active_sub_agents(session, tool_results)

        budget_error = self._generation_budget_error(session, tool_results)
        self._record_generation_results(session, tool_results)
        if budget_error and pending_ids:
            for task_id in pending_ids:
                task = session.dag.get_task(task_id)
                if not task or "generation" not in task.tool_categories:
                    continue
                task.status = TaskStatus.FAILED
                task.error = budget_error
                if "-shot-" not in task.id:
                    self._cancel_dependents(session.dag, task_id)
            session.pending_task_ids = []
            session.pending_tool_calls = []
            session.active_sub_agent_results = {}
            session.task_tool_call_counts = {}
            return self._execute_next(session)

        for task_id in pending_ids:
            task = session.dag.get_task(task_id)
            if not task:
                continue
            all_succeeded = all(r.success for r in tool_results)
            if all_succeeded:
                task.status = TaskStatus.COMPLETED
                task.result_summary = self._summarize_results(tool_results)
                logger.info("[orchestrator] session=%s | task %s completed", session_id[:8], task_id)
            else:
                failed = [r for r in tool_results if not r.success]
                error_msg = "; ".join(r.error or "unknown" for r in failed)
                for failed_result in failed:
                    if failed_result.error:
                        self._record_retry_cause(session, failed_result.error)
                if task.retry_count < _MAX_TASK_RETRIES:
                    task.retry_count += 1
                    task.status = TaskStatus.PENDING
                    task.error = f"Retrying ({task.retry_count}): {error_msg}"
                else:
                    task.status = TaskStatus.FAILED
                    task.error = error_msg
                    self._cancel_dependents(session.dag, task_id)

        session.pending_task_ids = []
        session.pending_tool_calls = []
        session.active_sub_agent_results = {}

        return self._execute_next(session)

    def _resume_active_sub_agents(
        self,
        session: OrchestratorSession,
        tool_results: list[ToolResult],
    ) -> OrchestrateResponse:
        """Resume sub-agent sessions with frontend tool results.

        Each sub-agent receives ONLY the tool results that correspond to
        its own tool calls, not the full list.  The mapping is based on
        ``task_tool_call_counts`` which records how many tool calls each
        task contributed to the combined ``pending_tool_calls`` list.
        """
        budget_error = self._generation_budget_error(session, tool_results)
        self._record_generation_results(session, tool_results)
        if budget_error and session.pending_task_ids:
            for task_id in session.pending_task_ids:
                task = session.dag.get_task(task_id)
                if not task or "generation" not in task.tool_categories:
                    continue
                task.status = TaskStatus.FAILED
                task.error = budget_error
                if "-shot-" not in task.id:
                    self._cancel_dependents(session.dag, task.id)
            session.pending_task_ids = []
            session.pending_tool_calls = []
            session.active_sub_agent_results = {}
            session.task_tool_call_counts = {}
            return self._execute_next(session)

        all_frontend_calls: list[ToolCall] = []
        new_pending_ids: list[str] = []
        new_active_results: dict[str, SubAgentResult] = {}
        new_task_counts: dict[str, int] = {}
        all_resumed: list[SubAgentResult] = []

        result_offset = 0

        for task_id in session.pending_task_ids:
            count = session.task_tool_call_counts.get(task_id, 1)
            task_results = tool_results[result_offset:result_offset + count]
            result_offset += count

            prev_result = session.active_sub_agent_results.get(task_id)
            if not prev_result:
                task = session.dag.get_task(task_id)
                if task:
                    task.status = TaskStatus.COMPLETED
                    task.result_summary = self._summarize_results(task_results)
                continue

            resumed = self._pool.resume_single(prev_result, task_results, project_id=session.project_id)
            all_resumed.append(resumed)

            task = session.dag.get_task(task_id)
            if not task:
                continue

            if not resumed.success:
                if resumed.error:
                    self._record_retry_cause(session, resumed.error)
                if task.retry_count < _MAX_TASK_RETRIES:
                    task.retry_count += 1
                    task.status = TaskStatus.PENDING
                    task.error = f"Resume error: {resumed.error}"
                else:
                    task.status = TaskStatus.FAILED
                    task.error = resumed.error
                    self._cancel_dependents(session.dag, task.id)
                continue

            if resumed.tool_calls:
                new_task_counts[task_id] = len(resumed.tool_calls)
                all_frontend_calls.extend(resumed.tool_calls)
                new_pending_ids.append(task_id)
                new_active_results[task_id] = resumed
                task.status = TaskStatus.RUNNING
            else:
                task.status = TaskStatus.COMPLETED
                task.result_summary = resumed.message
                logger.info(
                    "[orchestrator] session=%s | task %s completed after resume",
                    session.id[:8], task_id,
                )

        memory_updated = _results_have_memory_writes(all_resumed)

        if all_frontend_calls:
            session.status = OrchestratorStatus.AWAITING_TOOL_RESULTS
            session.pending_tool_calls = all_frontend_calls
            session.pending_task_ids = new_pending_ids
            session.active_sub_agent_results = new_active_results
            session.task_tool_call_counts = new_task_counts
            return _build_response(
                session, self._registry,
                tool_calls=all_frontend_calls,
                memory_updated=memory_updated,
            )

        session.pending_task_ids = []
        session.pending_tool_calls = []
        session.active_sub_agent_results = {}
        session.task_tool_call_counts = {}
        return self._execute_next(session)

    @staticmethod
    def _release_session_memory(session: OrchestratorSession) -> None:
        """Free heavyweight state that is no longer needed."""
        session.active_sub_agent_results.clear()
        session.task_tool_call_counts.clear()
        session.pending_tool_calls.clear()
        session.pending_task_ids.clear()

    def _execute_next(self, session: OrchestratorSession) -> OrchestrateResponse:
        session.last_diagnostics = self._execution_diagnostics(session)
        if session.dag.is_complete():
            session.status = OrchestratorStatus.DONE
            summary = self._build_final_summary(session)
            self._release_session_memory(session)
            completed = sum(1 for t in session.dag.tasks if t.status == TaskStatus.COMPLETED)
            failed = sum(1 for t in session.dag.tasks if t.status == TaskStatus.FAILED)
            cancelled = sum(1 for t in session.dag.tasks if t.status == TaskStatus.CANCELLED)
            logger.info(
                "[orchestrator] session=%s | all tasks done — %d completed, %d failed, %d cancelled",
                session.id[:8], completed, failed, cancelled,
            )
            return _build_response(
                session, self._registry,
                message=summary,
                done=True,
            )

        ready_tasks = session.dag.get_ready_tasks()
        if not ready_tasks:
            has_running = any(t.status == TaskStatus.RUNNING for t in session.dag.tasks)
            if has_running:
                session.status = OrchestratorStatus.AWAITING_TOOL_RESULTS
                return _build_response(
                    session, self._registry,
                    message="Waiting for in-progress tasks to complete.",
                )

            session.status = OrchestratorStatus.ERROR
            self._release_session_memory(session)
            return _build_response(
                session, self._registry,
                message="No tasks can proceed. Some tasks may have failed.",
                done=True,
            )

        coverage_repaired = self._apply_coverage_guard(session, ready_tasks)
        if coverage_repaired:
            ready_tasks = session.dag.get_ready_tasks()
            if not ready_tasks:
                return self._execute_next(session)

        expanded = self._try_expand_shot_tasks(session, ready_tasks)
        if expanded:
            ready_tasks = session.dag.get_ready_tasks()
            if not ready_tasks:
                return self._execute_next(session)

        has_mutation = self._any_task_mutates(ready_tasks)
        if has_mutation and len(ready_tasks) > 1:
            ready_tasks = [ready_tasks[0]]

        ready_tasks = self._limit_parallel_shot_tasks(session, ready_tasks)

        router = SkillRouter(self._registry.get_all_descriptors())
        tasks_to_dispatch: list[tuple[TaskNode, SkillContent | None, SubAgentContext]] = []

        for task in ready_tasks:
            task.status = TaskStatus.RUNNING

            resolved_skill_id = router.route(task)
            task.skill_id = resolved_skill_id
            skill_content = (
                self._registry.get_skill_content(resolved_skill_id)
                if resolved_skill_id else None
            )

            prior_results: dict[str, str] = {}
            for dep_id in task.depends_on:
                dep_task = session.dag.get_task(dep_id)
                if dep_task and dep_task.result_summary:
                    prior_results[dep_id] = dep_task.result_summary

            ctx = SubAgentContext(
                task=task,
                timeline_context=session.timeline_context,
                assets_context=session.assets_context,
                prior_task_results=prior_results,
                project_id=session.project_id,
                view_context=session.view_context,
                target_duration_seconds=session.dag.target_duration_seconds,
                creative_profile=session.dag.creative_profile,
                coverage_contract=session.dag.coverage_contract,
            )
            tasks_to_dispatch.append((task, skill_content, ctx))

        logger.info(
            "[orchestrator] session=%s | dispatching %d task(s): %s",
            session.id[:8],
            len(tasks_to_dispatch),
            [(t[0].id, t[0].skill_id or "general") for t in tasks_to_dispatch],
        )

        results = self._pool.execute_parallel(tasks_to_dispatch)
        memory_updated = _results_have_memory_writes(results)

        all_frontend_calls: list[ToolCall] = []
        pending_task_ids: list[str] = []
        active_sub_agent_results: dict[str, SubAgentResult] = {}
        task_tool_call_counts: dict[str, int] = {}

        for result in results:
            task = session.dag.get_task(result.task_id)
            if not task:
                continue

            if not result.success:
                if result.error:
                    self._record_retry_cause(session, result.error)
                if task.retry_count < _MAX_TASK_RETRIES:
                    task.retry_count += 1
                    task.status = TaskStatus.PENDING
                    task.error = f"Sub-agent error (retry {task.retry_count}): {result.error}"
                else:
                    task.status = TaskStatus.FAILED
                    task.error = result.error
                    if "-shot-" not in task.id:
                        self._cancel_dependents(session.dag, task.id)
                continue

            if result.tool_calls:
                task_tool_call_counts[result.task_id] = len(result.tool_calls)
                all_frontend_calls.extend(result.tool_calls)
                pending_task_ids.append(result.task_id)
                active_sub_agent_results[result.task_id] = result
                task.status = TaskStatus.RUNNING
            else:
                task.status = TaskStatus.COMPLETED
                task.result_summary = result.message
                if task.task_type == TaskType.REVIEW:
                    self._handle_review_result(session, task, result.message)

        if all_frontend_calls:
            session.status = OrchestratorStatus.AWAITING_TOOL_RESULTS
            session.pending_tool_calls = all_frontend_calls
            session.pending_task_ids = pending_task_ids
            session.active_sub_agent_results = active_sub_agent_results
            session.task_tool_call_counts = task_tool_call_counts
            return _build_response(
                session, self._registry,
                tool_calls=all_frontend_calls,
                memory_updated=memory_updated,
            )

        completed_count = sum(
            1 for t in session.dag.tasks if t.status == TaskStatus.COMPLETED
        )
        total_count = len(session.dag.tasks)
        return _build_response(
            session, self._registry,
            message=f"Completed {completed_count}/{total_count} tasks. Advancing...",
            memory_updated=memory_updated,
        )

    _ALLOWED_API_DURATIONS = (6, 8, 10, 12, 14, 16, 18, 20)

    @staticmethod
    def _snap_duration(raw_seconds: float) -> int:
        """Snap a raw duration to the nearest allowed API duration."""
        allowed = Orchestrator._ALLOWED_API_DURATIONS
        return min(allowed, key=lambda d: abs(d - raw_seconds))

    @staticmethod
    def _generation_budget(session: OrchestratorSession) -> dict[str, int]:
        duration = max(session.dag.target_duration_seconds or 30, 30)
        profile = session.dag.creative_profile or CreativeProfile.BRAND_CINEMATIC
        seconds_per_shot = {
            CreativeProfile.BRAND_CINEMATIC: 6,
            CreativeProfile.PERFORMANCE_SOCIAL: 4,
            CreativeProfile.UGC_NATIVE: 5,
            CreativeProfile.DIALOGUE_SCENE: 8,
            CreativeProfile.MONTAGE: 4,
        }
        base_buffer = {
            CreativeProfile.BRAND_CINEMATIC: 4,
            CreativeProfile.PERFORMANCE_SOCIAL: 6,
            CreativeProfile.UGC_NATIVE: 5,
            CreativeProfile.DIALOGUE_SCENE: 4,
            CreativeProfile.MONTAGE: 6,
        }
        minimums = {
            CreativeProfile.BRAND_CINEMATIC: 6,
            CreativeProfile.PERFORMANCE_SOCIAL: 8,
            CreativeProfile.UGC_NATIVE: 8,
            CreativeProfile.DIALOGUE_SCENE: 8,
            CreativeProfile.MONTAGE: 10,
        }
        planned_shots = max(
            minimums[profile],
            math.ceil(duration / seconds_per_shot[profile]) + base_buffer[profile],
        )
        planned_shots = min(_MAX_SHOTS_PER_EXPANSION, planned_shots)
        image_generations = planned_shots + max(6, planned_shots // 2)
        video_generations = planned_shots + max(4, planned_shots // 3)
        return {
            "planned_shots": planned_shots,
            "image_generations": image_generations,
            "video_generations": video_generations,
        }

    @staticmethod
    def _generation_budget_error(
        session: OrchestratorSession,
        tool_results: list[ToolResult],
    ) -> str | None:
        budget = Orchestrator._generation_budget(session)
        image_results = sum(
            1 for result in tool_results
            if result.success and result.tool_name == "generate_image"
        )
        video_results = sum(
            1 for result in tool_results
            if result.success and result.tool_name == "generate_video"
        )
        projected_images = session.generated_image_count + image_results
        projected_videos = session.generated_video_count + video_results
        if projected_images > budget["image_generations"]:
            return (
                "Image generation budget reached for this session "
                f"({projected_images}/{budget['image_generations']})."
            )
        if projected_videos > budget["video_generations"]:
            return (
                "Video generation budget reached for this session "
                f"({projected_videos}/{budget['video_generations']})."
            )
        return None

    @staticmethod
    def _record_generation_results(
        session: OrchestratorSession,
        tool_results: list[ToolResult],
    ) -> None:
        session.generated_image_count += sum(
            1 for result in tool_results
            if result.success and result.tool_name == "generate_image"
        )
        session.generated_video_count += sum(
            1 for result in tool_results
            if result.success and result.tool_name == "generate_video"
        )

    @staticmethod
    def _record_reference_usage(
        session: OrchestratorSession,
        *,
        matched_location_refs: list[str],
        has_location_refs: bool,
    ) -> None:
        if matched_location_refs:
            session.reference_hit_count += 1
        elif has_location_refs:
            session.reference_miss_count += 1

    @staticmethod
    def _record_retry_cause(
        session: OrchestratorSession,
        error_text: str,
    ) -> None:
        lower = error_text.lower()
        match = re.search(r"category=([a-z_]+)", lower)
        category = match.group(1) if match else None
        if category:
            session.retry_cause_counts[category] = session.retry_cause_counts.get(category, 0) + 1
            if category.startswith("fal_") or category == "provider_response":
                session.provider_error_count += 1
        if "timeout" in lower:
            session.sub_agent_timeout_count += 1
            session.retry_cause_counts["timeout"] = session.retry_cause_counts.get("timeout", 0) + 1
        elif category is None and ("http 5" in lower or "provider" in lower):
            session.provider_error_count += 1

    @staticmethod
    def _execution_diagnostics(session: OrchestratorSession) -> AgentDiagnostics:
        planned_shots = sum(1 for task in session.dag.tasks if "-shot-" in task.id)
        executed_shots = sum(
            1 for task in session.dag.tasks
            if "-shot-" in task.id and task.status == TaskStatus.COMPLETED
        )
        total_reference_decisions = session.reference_hit_count + session.reference_miss_count
        hit_rate = (
            session.reference_hit_count / total_reference_decisions
            if total_reference_decisions
            else None
        )
        image_video_ratio = (
            session.generated_image_count / session.generated_video_count
            if session.generated_video_count
            else None
        )
        previous = session.last_diagnostics or AgentDiagnostics()
        return AgentDiagnostics(
            selected_model=previous.selected_model,
            stage_name="orchestrator_execution",
            llm_ms=previous.llm_ms,
            tool_ms=previous.tool_ms,
            planning_ms=previous.planning_ms,
            used_fallback_model=previous.used_fallback_model,
            planned_shots=planned_shots,
            executed_shots=executed_shots,
            generated_images=session.generated_image_count,
            generated_videos=session.generated_video_count,
            image_video_ratio=image_video_ratio,
            reference_hit_rate=hit_rate,
            coverage_repairs=sum(session.coverage_repair_count.values()),
            retry_causes=dict(session.retry_cause_counts),
            sub_agent_timeouts=session.sub_agent_timeout_count,
            provider_errors=session.provider_error_count,
        )

    @staticmethod
    def _extract_dialogue(shot_desc: str) -> str | None:
        """Extract quoted dialogue from a shot description.

        Recognises three common screenplay/LLM patterns:
        - Standard quotes: ``"Hey, what's up doc?"``
        - Character cues: ``BUGS: "line"`` or ``BUGS: 'line'``
        - Prose attribution: ``says "line"`` / ``asks "line"``

        Returns combined dialogue text (capped at 200 chars) or None.
        """
        import re
        dialogue_pattern = re.compile(
            r"""
            (?:                          # character cue or attribution verb
                [A-Z][A-Z\s]{0,20}:\s*   # BUGS: / DAFFY DUCK:
              | \b(?:says?|asks?|replies|shouts?|whispers?|exclaims?|mutters?)\s+
            )?
            ["\u201c]                    # opening quote
            ([^"\u201d]{3,})             # dialogue content (min 3 chars)
            ["\u201d]                    # closing quote
            """,
            re.VERBOSE,
        )
        single_quote_cue = re.compile(
            r"[A-Z][A-Z\s]{0,20}:\s*'([^']{3,})'",
        )

        lines: list[str] = []
        for m in dialogue_pattern.finditer(shot_desc):
            lines.append(m.group(1).strip())
        for m in single_quote_cue.finditer(shot_desc):
            text = m.group(1).strip()
            if text not in lines:
                lines.append(text)

        if not lines:
            return None

        combined = " / ".join(lines)
        if len(combined) > 200:
            combined = combined[:197] + "..."
        return combined

    @staticmethod
    def _strip_dialogue_from_shot_desc(shot_desc: str) -> str:
        """Remove quoted dialogue and speech cues from a shot description."""
        cleaned = re.sub(
            r'(?:[A-Z][A-Z\s]{0,20}:\s*|\b(?:says?|saying|asks?|replies|shouts?|whispers?|exclaims?|mutters?)\b\s+)?["\u201c][^"\u201d]{3,}["\u201d]',
            "",
            shot_desc,
            flags=re.IGNORECASE,
        )
        cleaned = re.sub(r"[A-Z][A-Z\s]{0,20}:\s*'[^']{3,}'", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        cleaned = re.sub(r"\s+([,.;:])", r"\1", cleaned)
        return cleaned.strip(" ,.;:-")

    @staticmethod
    def _sanitize_still_frame_source(shot_desc: str) -> str:
        cleaned = Orchestrator._strip_dialogue_from_shot_desc(shot_desc)
        cleaned = re.sub(r"\b\d+(?:\.\d+)?:\d+\b", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        cleaned = re.sub(r"\s+([,.;:])", r"\1", cleaned)
        return cleaned.strip(" ,.;:-")

    @staticmethod
    def _sanitize_cinematic_style_block(visual_style_block: str | None) -> str:
        if not visual_style_block:
            return ""
        still_camera_markers = (
            "sony a7",
            "canon 5d",
            "hasselblad",
            "x-t5",
            "x100v",
            "gopro",
            "disposable camera",
        )
        fragments = [
            fragment.strip()
            for fragment in re.split(r"\n+|(?<=\.)\s+", visual_style_block.strip())
            if fragment.strip()
        ]
        filtered = [
            fragment for fragment in fragments
            if not any(marker in fragment.lower() for marker in still_camera_markers)
        ]
        prefix = ""
        if len(filtered) != len(fragments):
            prefix = (
                "For cinematic image prompts, use cinema camera bodies instead of still photography cameras. "
            )
        return f"{prefix}{' '.join(filtered).strip()}".strip()

    @staticmethod
    def _build_shot_prompt_contract(
        shot_desc: str,
        *,
        dialogue: str | None,
        api_duration: int,
        reference_ids: list[str],
        visual_style_block: str | None,
    ) -> dict[str, Any]:
        """Build a structured still/motion contract for an expanded shot task."""
        static_source = Orchestrator._sanitize_still_frame_source(shot_desc) or shot_desc
        sanitized_style_block = Orchestrator._sanitize_cinematic_style_block(visual_style_block)
        style_prefix = ""
        if sanitized_style_block:
            style_prefix = (
                "Apply this visual style to the still frame and preserve it in the video: "
                f"{sanitized_style_block} "
            )

        still_frame_prompt = (
            f"{style_prefix}Choose a single decisive still frame from this shot description: "
            f"\"{static_source}\". Describe only what is visible in one frame: subject, "
            "environment, composition, lighting, blocking, and spatial relationships. Do not "
            "include quoted dialogue, spoken text, camera moves, or multi-step temporal action. "
            "Do not write aspect ratios or frame dimensions inside the prompt text. Use natural-language "
            "guardrails: no on-screen text, no letterbox, no film scratches, no stock overlays."
        )
        motion_prompt = (
            f"Animate the established still frame for this shot: \"{static_source}\". "
            "Describe only motion, camera movement, blocking changes, and environmental movement. "
            "Do not restate the full still composition or add dialogue text to the image."
        )

        dialogue_audio_prompt = dialogue or "No spoken dialogue."

        return {
            "source_shot": shot_desc,
            "still_frame_prompt": still_frame_prompt,
            "motion_prompt": motion_prompt,
            "dialogue_audio_prompt": dialogue_audio_prompt,
            "reference_ids": reference_ids,
            "duration_seconds": api_duration,
        }

    @staticmethod
    def _parse_shot_list(text: str) -> list[tuple[int, str, int]]:
        """Extract numbered shots from a result summary.

        Looks for patterns like "Shot 1: description", "Shot 2: description".
        Returns list of (shot_number, description, api_duration) tuples.

        Duration extraction uses a two-pass approach:
        1. Strict: parenthesized ``(8s)``, ``(10 seconds)``
        2. Fallback: prose formats like ``Duration: 8s``, ``~10 seconds``,
           or standalone ``8s`` at a word boundary
        """
        import re
        shots: list[tuple[int, str, int]] = []
        shot_pattern = re.compile(
            r"Shot\s+(\d+)\s*(?:\([^)]*\)\s*)?[:\-–—]\s*(.+?)"
            r"(?=Shot\s+\d+\s*(?:\([^)]*\)\s*)?[:\-–—]|\Z)",
            re.DOTALL | re.IGNORECASE,
        )
        strict_duration = re.compile(
            r"\((\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\)",
            re.IGNORECASE,
        )
        fallback_duration = re.compile(
            r"(?:duration[:\s]+)?~?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)\b",
            re.IGNORECASE,
        )
        default_duration = Orchestrator._ALLOWED_API_DURATIONS[0]
        for match in shot_pattern.finditer(text):
            num = int(match.group(1))
            desc = match.group(2).strip()
            if len(desc) <= 10:
                continue
            full_match = match.group(0)
            dur_match = strict_duration.search(full_match)
            if not dur_match:
                dur_match = fallback_duration.search(full_match)
            if dur_match:
                api_dur = Orchestrator._snap_duration(float(dur_match.group(1)))
            else:
                api_dur = default_duration
            shots.append((num, desc, api_dur))
        return shots

    @staticmethod
    def _parse_reference_assets(
        dag: TaskDAG,
    ) -> tuple[dict[str, str], dict[str, str]]:
        """Scan completed DAG tasks for CHARACTER_REFS and LOCATION_REFS blocks.

        Returns (character_refs, location_refs) where each is a dict of
        label -> asset_id parsed from pre-production task output summaries.
        """
        character_refs: dict[str, str] = {}
        location_refs: dict[str, str] = {}

        for task in dag.tasks:
            if task.status != TaskStatus.COMPLETED or not task.result_summary:
                continue

            summary = task.result_summary
            try:
                reference_payload = Orchestrator._extract_reference_json(summary, "REFERENCE_PAYLOAD:")
                if isinstance(reference_payload, dict):
                    reference_payload_dict = cast(dict[str, Any], reference_payload)
                    character_refs.update(
                        Orchestrator._flatten_reference_mapping(reference_payload_dict.get("characters")),
                    )
                    location_refs.update(
                        Orchestrator._flatten_reference_mapping(reference_payload_dict.get("locations")),
                    )
            except (ValueError, TypeError) as exc:
                logger.warning(
                    "[orchestrator] failed to parse REFERENCE_PAYLOAD from task %s: %s",
                    task.id, exc,
                )

            for marker, target in [
                ("CHARACTER_REFS:", character_refs),
                ("LOCATION_REFS:", location_refs),
            ]:
                try:
                    parsed = Orchestrator._extract_reference_json(summary, marker)
                    target.update(Orchestrator._flatten_reference_mapping(parsed))
                except (ValueError, TypeError) as exc:
                    logger.warning(
                        "[orchestrator] failed to parse %s from task %s: %s",
                        marker.strip(":"), task.id, exc,
                    )

        return character_refs, location_refs

    @staticmethod
    def _extract_reference_json(summary: str, marker: str) -> Any:
        idx = summary.find(marker)
        if idx == -1:
            return None
        json_start = summary.find("{", idx)
        if json_start == -1:
            return None
        decoder = json.JSONDecoder()
        parsed, _end = decoder.raw_decode(summary[json_start:])
        return parsed

    @staticmethod
    def _flatten_reference_mapping(raw_mapping: Any) -> dict[str, str]:
        if not isinstance(raw_mapping, dict):
            return {}
        mapping = cast(dict[str, Any], raw_mapping)
        flattened: dict[str, str] = {}
        for label, value in mapping.items():
            if isinstance(value, str):
                flattened[str(label)] = value
                continue
            if isinstance(value, dict):
                value_dict = cast(dict[str, Any], value)
                asset_id = value_dict.get("asset_id")
                if isinstance(asset_id, str):
                    flattened[str(label)] = asset_id
        return flattened

    @staticmethod
    def _normalized_ref_tokens(text: str) -> set[str]:
        tokens = {
            token
            for token in re.findall(r"[a-z0-9]+", text.lower())
            if len(token) > 2
        }
        concepts = {
            "wreckage": {"wreckage", "debris", "fuselage", "crash", "plane"},
            "beach": {"beach", "shore", "shoreline", "surf", "coast", "sand", "island"},
            "jungle": {"jungle", "forest", "trees", "tree"},
            "interior": {"interior", "inside", "indoor", "room"},
            "exterior": {"exterior", "outside", "outdoor", "street"},
        }
        normalized = set(tokens)
        for concept, synonyms in concepts.items():
            if tokens & synonyms:
                normalized.add(concept)
        return normalized

    @staticmethod
    def _location_label_priority(label: str) -> tuple[int, str]:
        label_lower = label.lower()
        if any(token in label_lower for token in ("wide", "establishing", "exterior", "ext")):
            return (0, label_lower)
        if any(token in label_lower for token in ("close", "detail", "insert")):
            return (2, label_lower)
        return (1, label_lower)

    @staticmethod
    def _matched_location_refs_for_shot(
        shot_desc: str,
        location_refs: dict[str, str],
    ) -> list[str]:
        shot_tokens = Orchestrator._normalized_ref_tokens(shot_desc)

        scored_locations: list[tuple[int, tuple[int, str], str]] = []
        for label, asset_id in location_refs.items():
            label_tokens = Orchestrator._normalized_ref_tokens(label.replace("_", " "))
            score = len(shot_tokens & label_tokens)
            scored_locations.append((score, Orchestrator._location_label_priority(label), asset_id))

        return [
            asset_id
            for score, _priority, asset_id in sorted(
                scored_locations,
                key=lambda item: (-item[0], item[1], item[2]),
            )
            if score > 0
        ]

    @staticmethod
    def _select_refs_for_shot(
        shot_desc: str,
        character_refs: dict[str, str],
        location_refs: dict[str, str],
    ) -> list[str]:
        """Pick the most relevant reference asset IDs for a specific shot.

        All character refs are always included (scenes rarely have >5).
        Location refs are included if any keyword from the label appears in
        the shot description — up to 3 matched refs to provide diverse angles.
        Falls back to 2 arbitrary location refs when no keyword matches.
        Capped at 5 total to stay well within NB2's 14-image limit.
        """
        refs: list[str] = list(character_refs.values())
        matched_loc_refs = Orchestrator._matched_location_refs_for_shot(shot_desc, location_refs)

        if matched_loc_refs:
            refs.extend(matched_loc_refs[:3])
        else:
            fallback_refs = list(location_refs.values())[:2]
            refs.extend(fallback_refs)

        seen: set[str] = set()
        deduped: list[str] = []
        for r in refs:
            if r not in seen:
                seen.add(r)
                deduped.append(r)

        return deduped[:5]

    @staticmethod
    def _extract_visual_style_block(dag: TaskDAG) -> str | None:
        """Extract the NB2_STYLE_BLOCK from the cinematography task output.

        Scans all completed creative tasks for a structured NB2_STYLE_BLOCK.
        If found, returns the raw block text for injection into per-shot
        task descriptions. Falls back to extracting a general visual style
        summary from the longest creative task output if no structured block
        exists.
        """
        style_block: str | None = None
        longest_creative_summary = ""

        for task in dag.tasks:
            if task.status != TaskStatus.COMPLETED or not task.result_summary:
                continue
            if task.task_type != TaskType.CREATIVE:
                continue

            summary = task.result_summary

            block_start = summary.find("NB2_STYLE_BLOCK:")
            if block_start != -1:
                block_end = summary.find("\n\n", block_start)
                if block_end == -1:
                    block_end = len(summary)
                style_block = summary[block_start:block_end].strip()
                break

            if (
                task.skill_id in ("cinematography", "visual-identity")
                and len(summary) > len(longest_creative_summary)
            ):
                longest_creative_summary = summary

        if style_block:
            return style_block

        if not longest_creative_summary:
            return None

        lines: list[str] = []
        summary_lower = longest_creative_summary.lower()

        import re
        camera_match = re.search(
            r"(?:camera|shot on|filmed on)[:\s]+([^\n,.]{5,60})",
            summary_lower,
        )
        if camera_match:
            lines.append(f"camera: {camera_match.group(1).strip()}")

        stock_match = re.search(
            r"(?:film stock|stock)[:\s]+([^\n,.]{5,60})",
            summary_lower,
        )
        if stock_match:
            lines.append(f"film_stock: {stock_match.group(1).strip()}")

        lens_match = re.search(
            r"(?:lens|optics)[:\s]+([^\n,.]{5,60})",
            summary_lower,
        )
        if lens_match:
            lines.append(f"lens: {lens_match.group(1).strip()}")

        for pattern in [
            r"(?:director|directed by|style of)[:\s]+([^\n,.]{3,50})",
            r"(?:dp|cinematographer|shot by)[:\s]+([^\n,.]{3,50})",
        ]:
            ref_match = re.search(pattern, summary_lower)
            if ref_match:
                lines.append(f"style_ref: {ref_match.group(1).strip()}")

        if not lines:
            return None

        return "NB2_STYLE_BLOCK:\n" + "\n".join(lines)

    @staticmethod
    def _build_coverage_repair_description(
        source_task: TaskNode,
        issues: list[CoverageValidationIssue],
        contract: object,
    ) -> str:
        issue_names = ", ".join(issue.value for issue in issues)
        raw_coverage_note = ""
        if getattr(contract, "raw_coverage_mode", False):
            raw_coverage_note = (
                "For this profile, the shot list is raw generation coverage, not the final edit. "
                "It may run longer than the target as long as it gives the editor enough usable beats. "
            )
        return (
            "Tighten or rebalance the existing shot plan so it satisfies the "
            f"coverage contract ({issue_names}). Keep the strongest core idea, "
            f"but deliver enough visual beats for a {getattr(contract, 'target_duration_seconds', 0):.0f}-second "
            f"{getattr(getattr(contract, 'profile', None), 'value', 'creative')} piece. "
            f"Minimum shot count: {getattr(contract, 'min_shot_count', 'unknown')}. "
            f"Maximum dialogue share: {getattr(contract, 'max_dialogue_share', 0):.0%}. "
            f"{raw_coverage_note}"
            "First strengthen pacing contrast, silent visual beats, and editorially useful inserts. "
            "Only add new shots when rebalancing the existing plan is not enough. "
            f"Revise this prior shot plan rather than starting from scratch:\n\n{source_task.result_summary}"
        )

    def _apply_coverage_guard(
        self,
        session: OrchestratorSession,
        ready_tasks: list[TaskNode],
    ) -> bool:
        """Insert a repair task when a generation step would use under-covered script output."""
        contract = session.dag.coverage_contract
        if contract is None:
            return False
        if contract.profile == CreativeProfile.DIALOGUE_SCENE:
            return False

        changed = False
        for task in list(ready_tasks):
            if task.task_type != TaskType.EXECUTION or "generation" not in task.tool_categories:
                continue
            lower_description = task.description.lower()
            if task.skill_id == "scene-preproduction" or any(
                marker in lower_description
                for marker in (
                    "reference sheet",
                    "reference sheets",
                    "character reference",
                    "character turnaround",
                    "location keyframe",
                    "location keyframes",
                )
            ):
                continue

            source_task: TaskNode | None = None
            preferred_script_skills = {
                "advertising-screenwriter",
                "film-tv-screenwriting",
            }
            completed_creative_deps: list[TaskNode] = []
            for dep_id in task.depends_on:
                dep_task = session.dag.get_task(dep_id)
                if (
                    dep_task
                    and dep_task.status == TaskStatus.COMPLETED
                    and dep_task.task_type == TaskType.CREATIVE
                    and dep_task.result_summary
                ):
                    completed_creative_deps.append(dep_task)

            for dep_task in completed_creative_deps:
                if dep_task.skill_id in preferred_script_skills:
                    source_task = dep_task
                    break

            if source_task is None:
                for dep_task in completed_creative_deps:
                    if self._parse_shot_list(dep_task.result_summary):
                        source_task = dep_task
                        break

            if source_task is None:
                continue

            issues = validate_shot_plan(source_task.result_summary, contract)
            if not any(
                issue in issues
                for issue in (
                    CoverageValidationIssue.UNDER_COVERED,
                    CoverageValidationIssue.DIALOGUE_HEAVY,
                    CoverageValidationIssue.DURATION_MISMATCH,
                )
            ):
                continue

            repair_key = task.id
            repair_count = session.coverage_repair_count.get(repair_key, 0)
            if repair_count >= _MAX_COVERAGE_REPAIRS_PER_TASK:
                logger.warning(
                    "[orchestrator] session=%s | coverage repair limit reached for %s",
                    session.id[:8], repair_key,
                )
                continue

            repair_id = f"coverage-repair-{repair_key}-{repair_count + 1}"
            if session.dag.get_task(repair_id) is not None:
                continue

            repair_task = TaskNode(
                id=repair_id,
                description=self._build_coverage_repair_description(source_task, issues, contract),
                skill_id=source_task.skill_id,
                depends_on=[source_task.id],
                status=TaskStatus.PENDING,
                task_type=TaskType.CREATIVE,
                tool_categories=[],
                context_requirements=["prior_results"],
            )
            session.dag.tasks.append(repair_task)
            session.coverage_repair_count[repair_key] = repair_count + 1

            for downstream in session.dag.tasks:
                if downstream.id == repair_id:
                    continue
                if source_task.id in downstream.depends_on and downstream.status == TaskStatus.PENDING:
                    downstream.depends_on = [
                        repair_id if dep == source_task.id else dep
                        for dep in downstream.depends_on
                    ]

            logger.info(
                "[orchestrator] session=%s | inserted coverage repair task %s before %s",
                session.id[:8], repair_id, task.id,
            )
            return True

        return changed

    def _try_expand_shot_tasks(
        self,
        session: OrchestratorSession,
        ready_tasks: list[TaskNode],
    ) -> bool:
        """Check if any ready execution task should be expanded into per-shot tasks.

        When a ready execution task depends on a completed creative task
        that produced a numbered shot list, and the execution task is about
        generation, expand it into N individual per-shot tasks that run
        in parallel.

        If pre-production tasks produced CHARACTER_REFS / LOCATION_REFS,
        the relevant reference asset IDs are injected into each per-shot
        task description so the sub-agent passes them as image_urls.

        If a visual style guide produced an NB2_STYLE_BLOCK, its directives
        are injected into each per-shot task description so the sub-agent
        applies the correct camera, film stock, lens, and style references.

        Returns True if expansion happened (caller should re-fetch ready tasks).
        """
        expanded_any = False

        for task in list(ready_tasks):
            if task.task_type != TaskType.EXECUTION:
                continue
            if "generation" not in task.tool_categories:
                continue
            if task.skill_id == "scene-preproduction":
                continue

            shot_list: list[tuple[int, str, int]] = []
            script_task_id: str | None = None

            for dep_id in task.depends_on:
                dep_task = session.dag.get_task(dep_id)
                if not dep_task or dep_task.status != TaskStatus.COMPLETED:
                    continue
                if dep_task.task_type != TaskType.CREATIVE:
                    continue

                shots = self._parse_shot_list(dep_task.result_summary)
                if len(shots) >= 2:
                    shot_list = shots
                    script_task_id = dep_id
                    break

            if not shot_list or not script_task_id:
                continue

            shot_budget = self._generation_budget(session)
            shot_cap = min(_MAX_SHOTS_PER_EXPANSION, shot_budget["planned_shots"])
            if len(shot_list) > shot_cap:
                logger.warning(
                    "[orchestrator] session=%s | shot list has %d entries, "
                    "capping at %d",
                    session.id[:8], len(shot_list), shot_cap,
                )
                shot_list = shot_list[:shot_cap]

            character_refs, location_refs = self._parse_reference_assets(session.dag)
            has_refs = bool(character_refs or location_refs)

            if has_refs:
                logger.info(
                    "[orchestrator] session=%s | found pre-production refs: "
                    "%d character(s), %d location(s)",
                    session.id[:8],
                    len(character_refs),
                    len(location_refs),
                )

            visual_style_block = self._extract_visual_style_block(session.dag)
            if visual_style_block:
                logger.info(
                    "[orchestrator] session=%s | injecting visual style block "
                    "into per-shot tasks (%d chars)",
                    session.id[:8], len(visual_style_block),
                )

            logger.info(
                "[orchestrator] session=%s | expanding task %s into %d per-shot tasks",
                session.id[:8], task.id, len(shot_list),
            )

            original_task_id = task.id
            task.status = TaskStatus.CANCELLED
            task.error = f"Expanded into {len(shot_list)} per-shot tasks"

            shot_task_ids: list[str] = []
            for shot_num, shot_desc, api_duration in shot_list:
                shot_task_id = f"{original_task_id}-shot-{shot_num}"
                short_desc = shot_desc[:500].replace("\n", " ")
                dialogue = self._extract_dialogue(shot_desc)
                matched_location_refs = self._matched_location_refs_for_shot(shot_desc, location_refs) if has_refs else []
                ref_ids = self._select_refs_for_shot(
                    shot_desc, character_refs, location_refs,
                ) if has_refs else []
                self._record_reference_usage(
                    session,
                    matched_location_refs=matched_location_refs,
                    has_location_refs=bool(location_refs),
                )
                refs_str = ", ".join(ref_ids) if ref_ids else "(none)"
                prompt_contract = self._build_shot_prompt_contract(
                    short_desc,
                    dialogue=dialogue,
                    api_duration=api_duration,
                    reference_ids=ref_ids,
                    visual_style_block=visual_style_block,
                )
                video_prompt_instruction = "Use ONLY the MOTION PROMPT."
                if dialogue:
                    video_prompt_instruction = (
                        "Use the MOTION PROMPT and append the DIALOGUE AUDIO PROMPT "
                        "for spoken performance."
                    )

                description = (
                    f"Generate Shot {shot_num}.\n"
                    "SHOT CONTRACT:\n"
                    f'SOURCE SHOT: "{prompt_contract["source_shot"]}"\n'
                    f'STILL FRAME PROMPT: {prompt_contract["still_frame_prompt"]}\n'
                    f'MOTION PROMPT: {prompt_contract["motion_prompt"]}\n'
                    f'DIALOGUE AUDIO PROMPT: "{prompt_contract["dialogue_audio_prompt"]}"\n'
                    f"REFERENCE IDS: [{refs_str}]\n"
                    f'DURATION: {prompt_contract["duration_seconds"]}s\n'
                    "EXECUTION RULES:\n"
                    "- First call generate_image using ONLY the STILL FRAME PROMPT.\n"
                    "- Pass aspect_ratio='16:9' as a tool argument unless the user explicitly requested a different ratio.\n"
                    "- If REFERENCE IDS are present, pass all of them as image_urls.\n"
                    "- Then call generate_video with mode=image_to_video using the generated image asset_id.\n"
                    f"- {video_prompt_instruction}\n"
                    "- Report the final video asset_id."
                )

                shot_task = TaskNode(
                    id=shot_task_id,
                    description=description,
                    skill_id="nano-banana-prompting",
                    depends_on=list(task.depends_on),
                    status=TaskStatus.PENDING,
                    task_type=TaskType.EXECUTION,
                    tool_categories=["generation"],
                    context_requirements=["prior_results"],
                )
                session.dag.tasks.append(shot_task)
                shot_task_ids.append(shot_task_id)

            for other_task in session.dag.tasks:
                if original_task_id in other_task.depends_on:
                    other_task.depends_on = [
                        dep for dep in other_task.depends_on
                        if dep != original_task_id
                    ] + shot_task_ids

            expanded_any = True

        return expanded_any

    @staticmethod
    def _extract_review_payload(review_message: str) -> dict[str, Any] | None:
        text = review_message.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if len(lines) >= 3 and lines[-1].strip() == "```":
                text = "\n".join(lines[1:-1]).strip()

        try:
            parsed = json.loads(text)
            return cast(dict[str, Any], parsed) if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            parsed = json.loads(text[start:end + 1])
            return cast(dict[str, Any], parsed) if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _parse_review_actions(review_message: str) -> tuple[str, list[dict[str, Any]], str]:
        payload = Orchestrator._extract_review_payload(review_message)
        if payload is not None:
            verdict = str(payload.get("overall_verdict", "")).strip().lower() or "pass"
            summary = str(payload.get("summary", review_message)).strip()
            raw_actions = payload.get("actions", [])
            actions: list[dict[str, Any]] = []
            if isinstance(raw_actions, list):
                for action in cast(list[Any], raw_actions):
                    if not isinstance(action, dict):
                        continue
                    action_payload = cast(dict[str, Any], action)
                    kind = str(action_payload.get("kind", "")).strip().lower()
                    if not kind:
                        continue
                    normalized: dict[str, Any] = {
                        "kind": kind,
                        "reason": str(action_payload.get("reason", summary)).strip(),
                    }
                    shot_number = action_payload.get("shot_number")
                    if isinstance(shot_number, int):
                        normalized["shot_number"] = shot_number
                    actions.append(normalized)
            if verdict == "fail" and not actions:
                actions.append({"kind": "recut_timeline", "reason": summary})
            return verdict, actions, summary

        failure_keywords = ("regenerate", "regeneration", "replace", "redo")
        actions = []
        for line in review_message.splitlines():
            match = re.search(r"shot\s+(\d+)", line, re.IGNORECASE)
            if not match:
                continue
            lower = line.lower()
            if any(keyword in lower for keyword in failure_keywords):
                actions.append({
                    "kind": "regenerate_shot",
                    "shot_number": int(match.group(1)),
                    "reason": line.strip(),
                })

        if actions:
            return "fail", actions, review_message

        message_lower = review_message.lower()
        if "recut" in message_lower and "timeline" in message_lower:
            return "fail", [{"kind": "recut_timeline", "reason": review_message.strip()}], review_message
        if (
            "shot" in message_lower or "timeline" in message_lower
        ) and any(keyword in message_lower for keyword in ("fail", "failed", "wrong", "needs", "missing", "too ", "weak")):
            return "fail", [{"kind": "recut_timeline", "reason": review_message.strip()}], review_message

        return "pass", [], review_message

    @staticmethod
    def _pending_tasks_waiting_on(review_task_id: str, dag: TaskDAG) -> list[TaskNode]:
        return [
            task
            for task in dag.tasks
            if task.status == TaskStatus.PENDING and review_task_id in task.depends_on
        ]

    @staticmethod
    def _find_generation_shot_task(shot_number: int, dag: TaskDAG) -> TaskNode | None:
        suffix = f"-shot-{shot_number}"
        for task in dag.tasks:
            if task.id.endswith(suffix):
                return task
        return None

    @staticmethod
    def _find_generation_roots_for_review(review_task: TaskNode, dag: TaskDAG) -> list[TaskNode]:
        roots: dict[str, TaskNode] = {}
        pending = list(review_task.depends_on)
        visited: set[str] = set()

        while pending:
            task_id = pending.pop()
            if task_id in visited:
                continue
            visited.add(task_id)
            task = dag.get_task(task_id)
            if not task:
                continue

            if "-shot-" in task.id:
                root_id = task.id.split("-shot-", 1)[0]
                root_task = dag.get_task(root_id)
                if root_task and "generation" in root_task.tool_categories:
                    roots[root_task.id] = root_task
            elif "generation" in task.tool_categories and task.skill_id != "scene-preproduction":
                roots[task.id] = task

            pending.extend(task.depends_on)

        return list(roots.values())

    @staticmethod
    def _script_source_ids_for_generation_task(
        generation_task: TaskNode,
        dag: TaskDAG,
    ) -> list[str]:
        script_skill_ids = {"advertising-screenwriter", "film-tv-screenwriting"}
        source_ids: list[str] = []
        for dep_id in generation_task.depends_on:
            dep_task = dag.get_task(dep_id)
            if not dep_task or dep_task.task_type != TaskType.CREATIVE:
                continue
            if dep_task.skill_id in script_skill_ids or (
                dep_task.result_summary and Orchestrator._parse_shot_list(dep_task.result_summary)
            ):
                source_ids.append(dep_id)
        return source_ids

    @staticmethod
    def _invalidate_generation_branch(
        generation_root: TaskNode,
        dag: TaskDAG,
    ) -> None:
        shot_prefix = f"{generation_root.id}-shot-"
        for task in dag.tasks:
            if task.id.startswith(shot_prefix):
                task.status = TaskStatus.CANCELLED
                task.error = "Superseded by rewritten script"

    def _handle_review_result(
        self,
        session: OrchestratorSession,
        review_task: TaskNode,
        review_message: str,
    ) -> None:
        """Process a review task's output and potentially add corrective tasks."""
        review_key = review_task.id
        iteration = session.review_iteration_count.get(review_key, 0)

        if iteration >= _MAX_REVIEW_ITERATIONS:
            logger.info(
                "[orchestrator] session=%s | review %s hit max iterations (%d), proceeding",
                session.id[:8], review_key, _MAX_REVIEW_ITERATIONS,
            )
            return

        verdict, actions, summary = self._parse_review_actions(review_message)
        if verdict == "pass" and not actions:
            logger.info(
                "[orchestrator] session=%s | review %s approved",
                session.id[:8], review_key,
            )
            return

        session.review_iteration_count[review_key] = iteration + 1
        downstream_pending = self._pending_tasks_waiting_on(review_key, session.dag)
        created_tasks: list[TaskNode] = []
        downstream_blockers: list[TaskNode] = []
        seen_keys: set[str] = set()
        budget_limited = False

        for action in actions:
            kind = str(action.get("kind", "")).strip().lower()
            reason = str(action.get("reason", summary)).strip()

            if kind == "regenerate_shot":
                shot_number = action.get("shot_number")
                if not isinstance(shot_number, int):
                    continue
                dedupe_key = f"shot:{shot_number}"
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                source_task = self._find_generation_shot_task(shot_number, session.dag)
                if source_task is None:
                    continue
                regen_key = source_task.id
                if session.shot_regeneration_count.get(regen_key, 0) >= _MAX_SHOT_REGENERATIONS_PER_SHOT:
                    budget_limited = True
                    logger.info(
                        "[orchestrator] session=%s | shot %s hit regeneration cap (%d)",
                        session.id[:8], regen_key, _MAX_SHOT_REGENERATIONS_PER_SHOT,
                    )
                    continue
                correction_task = TaskNode(
                    id=f"correction-{review_key}-shot-{shot_number}-{iteration + 1}",
                    description=(
                        f"Regenerate Shot {shot_number}. Original task: {source_task.description}\n"
                        f"Review feedback: {reason}"
                    ),
                    skill_id=source_task.skill_id or "nano-banana-prompting",
                    depends_on=[review_task.id, source_task.id],
                    status=TaskStatus.PENDING,
                    task_type=TaskType.EXECUTION,
                    tool_categories=["generation"],
                    context_requirements=["prior_results"],
                )
                created_tasks.append(correction_task)
                downstream_blockers.append(correction_task)
                session.shot_regeneration_count[regen_key] = session.shot_regeneration_count.get(regen_key, 0) + 1
                continue

            if kind == "rewrite_script":
                dedupe_key = "rewrite_script"
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                generation_roots = self._find_generation_roots_for_review(review_task, session.dag)
                script_source_ids: list[str] = []
                script_skill_id = "advertising-screenwriter"
                for generation_root in generation_roots:
                    source_ids = self._script_source_ids_for_generation_task(generation_root, session.dag)
                    script_source_ids.extend(source_ids)
                    for source_id in source_ids:
                        source_task = session.dag.get_task(source_id)
                        if source_task and source_task.skill_id:
                            script_skill_id = source_task.skill_id
                            break
                    if script_source_ids:
                        break
                if not script_source_ids:
                    for candidate in reversed(session.dag.tasks):
                        if (
                            candidate.task_type == TaskType.CREATIVE
                            and candidate.result_summary
                            and self._parse_shot_list(candidate.result_summary)
                        ):
                            script_source_ids = [candidate.id]
                            if candidate.skill_id:
                                script_skill_id = candidate.skill_id
                            break
                rewrite_depends_on = [review_task.id, *script_source_ids]
                correction_task = TaskNode(
                    id=f"correction-{review_key}-script-{iteration + 1}",
                    description=f"Rewrite the script based on review feedback: {reason}",
                    skill_id=script_skill_id,
                    depends_on=rewrite_depends_on,
                    status=TaskStatus.PENDING,
                    task_type=TaskType.CREATIVE,
                    tool_categories=[],
                    context_requirements=["prior_results"],
                )
                created_tasks.append(correction_task)
                if not generation_roots:
                    downstream_blockers.append(correction_task)
                    continue

                for generation_root in generation_roots:
                    self._invalidate_generation_branch(generation_root, session.dag)
                    non_script_deps = [
                        dep for dep in generation_root.depends_on
                        if dep not in script_source_ids
                    ]
                    review_suffix = (
                        str(iteration + 1)
                        if len(generation_roots) == 1
                        else f"{generation_root.id}-{iteration + 1}"
                    )
                    rewrite_generation_task = TaskNode(
                        id=f"{generation_root.id}-rewrite-{iteration + 1}",
                        description=(
                            f"Regenerate the shot plan and generated assets using the rewritten script. "
                            f"Original generation task: {generation_root.description}"
                        ),
                        skill_id=generation_root.skill_id,
                        depends_on=[correction_task.id, *non_script_deps],
                        status=TaskStatus.PENDING,
                        task_type=TaskType.EXECUTION,
                        tool_categories=list(generation_root.tool_categories),
                        context_requirements=["prior_results"],
                    )
                    rewrite_review_task = TaskNode(
                        id=f"{review_key}-rewrite-{review_suffix}",
                        description=(
                            "Review the regenerated shots against the rewritten script before "
                            "any downstream editorial work proceeds."
                        ),
                        skill_id=review_task.skill_id or "marketing-editor",
                        depends_on=[rewrite_generation_task.id],
                        status=TaskStatus.PENDING,
                        task_type=TaskType.REVIEW,
                        tool_categories=["review"],
                        context_requirements=["prior_results"],
                    )
                    created_tasks.extend([rewrite_generation_task, rewrite_review_task])
                    downstream_blockers.append(rewrite_review_task)
                continue

            if kind == "recut_timeline":
                dedupe_key = "recut_timeline"
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                correction_task = TaskNode(
                    id=f"correction-{review_key}-timeline-{iteration + 1}",
                    description=f"Recut the timeline based on review feedback: {reason}",
                    skill_id=review_task.skill_id or "marketing-editor",
                    depends_on=[review_task.id],
                    status=TaskStatus.PENDING,
                    task_type=TaskType.EXECUTION,
                    tool_categories=["timeline_mgmt", "clip_editing", "transitions"],
                    context_requirements=["prior_results", "timeline_state"],
                )
                created_tasks.append(correction_task)
                downstream_blockers.append(correction_task)

        if not created_tasks and budget_limited:
            created_tasks.append(TaskNode(
                id=f"correction-{review_key}-timeline-{iteration + 1}-budget",
                description=(
                    "Generation correction budget was exhausted. Recut the timeline, or escalate "
                    f"to a script/story fix based on this review feedback: {summary[:200]}"
                ),
                skill_id=review_task.skill_id or "marketing-editor",
                depends_on=[review_task.id],
                status=TaskStatus.PENDING,
                task_type=TaskType.EXECUTION,
                tool_categories=["timeline_mgmt", "clip_editing", "transitions"],
                context_requirements=["prior_results", "timeline_state"],
            ))
            downstream_blockers = list(created_tasks)

        if not created_tasks:
            created_tasks.append(TaskNode(
                id=f"correction-{review_key}-{iteration + 1}",
                description=f"Apply corrections based on review feedback: {summary[:200]}",
                skill_id=review_task.skill_id,
                depends_on=[review_task.id],
                status=TaskStatus.PENDING,
                task_type=TaskType.EXECUTION,
                tool_categories=["core", "generation", "clip_editing", "timeline_mgmt"],
                context_requirements=["prior_results", "timeline_state"],
            ))
            downstream_blockers = list(created_tasks)

        for correction_task in created_tasks:
            session.dag.tasks.append(correction_task)

        for pending_task in downstream_pending:
            for blocker in downstream_blockers:
                if blocker.id not in pending_task.depends_on:
                    pending_task.depends_on.append(blocker.id)

        logger.info(
            "[orchestrator] session=%s | review %s requested %d correction task(s): %s",
            session.id[:8], review_key, len(created_tasks), [task.id for task in created_tasks],
        )

    def _cancel_dependents(self, dag: TaskDAG, failed_task_id: str) -> None:
        cancelled: set[str] = {failed_task_id}
        changed = True
        while changed:
            changed = False
            for task in dag.tasks:
                if task.status == TaskStatus.PENDING and task.id not in cancelled:
                    if any(dep in cancelled for dep in task.depends_on):
                        task.status = TaskStatus.CANCELLED
                        task.error = f"Cancelled: dependency {failed_task_id} failed"
                        cancelled.add(task.id)
                        changed = True

    @staticmethod
    def _is_parallel_shot_task(task: TaskNode) -> bool:
        return (
            task.task_type == TaskType.EXECUTION
            and "generation" in task.tool_categories
            and "-shot-" in task.id
        )

    def _limit_parallel_shot_tasks(
        self,
        session: OrchestratorSession,
        ready_tasks: list[TaskNode],
    ) -> list[TaskNode]:
        shot_tasks = [task for task in ready_tasks if self._is_parallel_shot_task(task)]
        if len(shot_tasks) <= _MAX_PARALLEL_SHOT_TASKS:
            return ready_tasks

        limited: list[TaskNode] = []
        remaining_shot_slots = _MAX_PARALLEL_SHOT_TASKS

        for task in ready_tasks:
            if self._is_parallel_shot_task(task):
                if remaining_shot_slots <= 0:
                    continue
                remaining_shot_slots -= 1
            limited.append(task)

        logger.info(
            "[orchestrator] session=%s | limiting ready shot tasks from %d to %d per batch",
            session.id[:8],
            len(shot_tasks),
            _MAX_PARALLEL_SHOT_TASKS,
        )
        return limited

    @staticmethod
    def _any_task_mutates(tasks: list[TaskNode]) -> bool:
        mutation_categories = {"clip_editing", "timeline_mgmt", "track_mgmt", "editing_ops", "subtitles"}
        for task in tasks:
            if any(cat in mutation_categories for cat in task.tool_categories):
                return True
        return False

    @staticmethod
    def _summarize_results(tool_results: list[ToolResult]) -> str:
        parts: list[str] = []
        for r in tool_results:
            if r.success:
                result_str = str(r.result)[:200] if r.result else "OK"
                parts.append(f"{r.tool_name}: {result_str}")
            else:
                parts.append(f"{r.tool_name}: FAILED — {r.error}")
        return "; ".join(parts)

    @staticmethod
    def _build_final_summary(session: OrchestratorSession) -> str:
        completed = [t for t in session.dag.tasks if t.status == TaskStatus.COMPLETED]
        failed = [t for t in session.dag.tasks if t.status == TaskStatus.FAILED]
        cancelled = [t for t in session.dag.tasks if t.status == TaskStatus.CANCELLED]

        lines: list[str] = []
        if completed:
            lines.append(f"Completed {len(completed)} task(s):")
            for t in completed:
                lines.append(f"  - {t.description}")
        if failed:
            lines.append(f"\n{len(failed)} task(s) failed:")
            for t in failed:
                lines.append(f"  - {t.description}: {t.error}")
        if cancelled:
            lines.append(f"\n{len(cancelled)} task(s) cancelled due to dependency failures.")
        return "\n".join(lines) if lines else "All tasks completed."

    @staticmethod
    def _format_timeline(state: Any) -> str:
        if state is None:
            return ""
        lines: list[str] = [
            f"**Timeline**: {state.track_count} tracks, "
            f"duration {state.total_duration:.2f}s, "
            f"playhead at {state.playhead_time:.2f}s",
        ]
        if not state.clips:
            lines.append("  (no clips)")
        else:
            lines.append(f"  {len(state.clips)} clip(s):")
            for clip in state.clips:
                lines.append(
                    f"  - clip_id={clip.id} asset={clip.asset_id} "
                    f"type={clip.type} track={clip.track_index} "
                    f"start={clip.start_time:.2f}s dur={clip.duration:.2f}s"
                )
        return "\n".join(lines)
