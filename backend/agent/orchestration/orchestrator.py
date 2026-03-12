"""Orchestrator: the brain of the multi-agent system.

Decomposes complex requests into a DAG of tasks, dispatches them
to specialized sub-agents (or the general brain), reviews results,
and loops until all tasks are complete.

Session state is held in memory with TTL-based eviction, mirroring
the existing ``gemini_agent.py`` session pattern.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from agent.orchestration.complexity_router import (
    RequestComplexity,
    classify_complexity,
)
from agent.orchestration.skill_router import SkillRouter
from agent.orchestration.sub_agent_pool import SubAgentPool
from agent.orchestration.task_planner import TaskPlanner
from agent.skills.skill_registry import SkillRegistry, get_skill_registry
from agent.types import (
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
    ToolCall,
    ToolResult,
)
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_MAX_SESSIONS = 20
_SESSION_TTL_SECONDS = 1800  # 30 min
_MAX_RETRIES_PER_TASK = 1
_MAX_DAG_TASKS = 10


# ---------------------------------------------------------------------------
# Session storage
# ---------------------------------------------------------------------------

@dataclass
class OrchestratorSession:
    id: str
    dag: TaskDAG
    status: OrchestratorStatus
    pending_tool_calls: list[ToolCall] = field(default_factory=list)
    pending_task_id: str | None = None
    timeline_context: str | None = None
    assets_context: str | None = None
    project_id: str | None = None
    view_context: str = "editor"
    last_access: float = field(default_factory=time.monotonic)


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


# ---------------------------------------------------------------------------
# Response builders
# ---------------------------------------------------------------------------

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
) -> OrchestrateResponse:
    return OrchestrateResponse(
        session_id=session.id,
        status=session.status.value,
        tasks=[_task_to_info(t, registry) for t in session.dag.tasks],
        current_task_id=session.pending_task_id,
        tool_calls=tool_calls or [],
        message=message,
        done=done,
    )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

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
        """Decide if a request should use orchestration or the simple agent."""
        return classify_complexity(prompt)

    def start(self, request: OrchestrateRequest) -> OrchestrateResponse:
        """Decompose the request into a DAG and begin execution."""
        _evict_stale_sessions()

        session_id = uuid.uuid4().hex
        descriptors = self._registry.get_all_descriptors()

        timeline_ctx = self._format_timeline(request.timeline_state) if request.timeline_state else None
        assets_ctx = str(request.assets_context) if request.assets_context else None

        logger.info(
            "[orchestrator] session=%s | planning: %.80s",
            session_id[:8], request.prompt,
        )

        dag = self._planner.decompose(
            request.prompt,
            descriptors,
            timeline_context=timeline_ctx,
            assets_context=assets_ctx,
        )

        if len(dag.tasks) > _MAX_DAG_TASKS:
            logger.warning(
                "Planner produced %d tasks (max %d) — truncating",
                len(dag.tasks), _MAX_DAG_TASKS,
            )
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

        logger.info(
            "[orchestrator] session=%s | DAG has %d task(s): %s",
            session_id[:8],
            len(dag.tasks),
            [t.id for t in dag.tasks],
        )

        return self._execute_next(session)

    def continue_with_results(
        self,
        session_id: str,
        tool_results: list[ToolResult],
        updated_context: str | None = None,
    ) -> OrchestrateResponse:
        """Process frontend tool results and continue execution."""
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

        task_id = session.pending_task_id
        if task_id:
            task = session.dag.get_task(task_id)
            if task:
                all_succeeded = all(r.success for r in tool_results)
                if all_succeeded:
                    task.status = TaskStatus.COMPLETED
                    task.result_summary = self._summarize_results(tool_results)
                    logger.info("[orchestrator] session=%s | task %s completed", session_id[:8], task_id)
                else:
                    failed = [r for r in tool_results if not r.success]
                    error_msg = "; ".join(r.error or "unknown" for r in failed)
                    if task.retry_count < _MAX_RETRIES_PER_TASK:
                        task.retry_count += 1
                        task.status = TaskStatus.PENDING
                        task.error = f"Retrying ({task.retry_count}): {error_msg}"
                        logger.info(
                            "[orchestrator] session=%s | task %s failed, retrying (%d/%d)",
                            session_id[:8], task_id, task.retry_count, _MAX_RETRIES_PER_TASK,
                        )
                    else:
                        task.status = TaskStatus.FAILED
                        task.error = error_msg
                        self._cancel_dependents(session.dag, task_id)
                        logger.warning(
                            "[orchestrator] session=%s | task %s failed permanently: %s",
                            session_id[:8], task_id, error_msg,
                        )

        session.pending_task_id = None
        session.pending_tool_calls = []

        return self._execute_next(session)

    def _execute_next(self, session: OrchestratorSession) -> OrchestrateResponse:
        """Find ready tasks and dispatch the next batch."""
        if session.dag.is_complete():
            session.status = OrchestratorStatus.DONE
            summary = self._build_final_summary(session)
            logger.info("[orchestrator] session=%s | all tasks done", session.id[:8])
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
            return _build_response(
                session, self._registry,
                message="No tasks can proceed. Some tasks may have failed.",
                done=True,
            )

        has_mutation = self._any_task_mutates(ready_tasks)
        if has_mutation and len(ready_tasks) > 1:
            ready_tasks = [ready_tasks[0]]

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
            )
            tasks_to_dispatch.append((task, skill_content, ctx))

        logger.info(
            "[orchestrator] session=%s | dispatching %d task(s): %s",
            session.id[:8],
            len(tasks_to_dispatch),
            [t[0].id for t in tasks_to_dispatch],
        )

        results = self._pool.execute_parallel(tasks_to_dispatch)

        all_frontend_calls: list[ToolCall] = []
        first_pending_task_id: str | None = None

        for result in results:
            task = session.dag.get_task(result.task_id)
            if not task:
                continue

            if not result.success:
                if task.retry_count < _MAX_RETRIES_PER_TASK:
                    task.retry_count += 1
                    task.status = TaskStatus.PENDING
                    task.error = f"Sub-agent error (retry {task.retry_count}): {result.error}"
                else:
                    task.status = TaskStatus.FAILED
                    task.error = result.error
                    self._cancel_dependents(session.dag, task.id)
                continue

            if result.tool_calls:
                all_frontend_calls.extend(result.tool_calls)
                if first_pending_task_id is None:
                    first_pending_task_id = result.task_id
                task.status = TaskStatus.RUNNING
            else:
                task.status = TaskStatus.COMPLETED
                task.result_summary = result.message

        if all_frontend_calls:
            session.status = OrchestratorStatus.AWAITING_TOOL_RESULTS
            session.pending_tool_calls = all_frontend_calls
            session.pending_task_id = first_pending_task_id
            return _build_response(
                session, self._registry,
                tool_calls=all_frontend_calls,
            )

        return self._execute_next(session)

    def _cancel_dependents(self, dag: TaskDAG, failed_task_id: str) -> None:
        """Cancel all tasks that transitively depend on a failed task."""
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
    def _any_task_mutates(tasks: list[TaskNode]) -> bool:
        """Check if any task's categories include mutation-prone tools."""
        mutation_categories = {"clip_editing", "timeline_mgmt", "track_mgmt", "editing_ops", "subtitles"}
        for task in tasks:
            if any(cat in mutation_categories for cat in task.tool_categories):
                return True
        return False

    @staticmethod
    def _summarize_results(tool_results: list[ToolResult]) -> str:
        """Create a brief summary of tool results for dependent tasks."""
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
        """Format a TimelineState into context text."""
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
