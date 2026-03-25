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
_MAX_RETRIES_PER_TASK = 2
_MAX_DAG_TASKS = 75
_MAX_REVIEW_ITERATIONS = 2
_MAX_SHOTS_PER_EXPANSION = 40


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
        diagnostics=diagnostics,
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
                if task.retry_count < _MAX_RETRIES_PER_TASK:
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
                if task.retry_count < _MAX_RETRIES_PER_TASK:
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
                if task.retry_count < _MAX_RETRIES_PER_TASK:
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
        import json as _json

        character_refs: dict[str, str] = {}
        location_refs: dict[str, str] = {}

        for task in dag.tasks:
            if task.status != TaskStatus.COMPLETED or not task.result_summary:
                continue

            summary = task.result_summary
            for marker, target in [
                ("CHARACTER_REFS:", character_refs),
                ("LOCATION_REFS:", location_refs),
            ]:
                idx = summary.find(marker)
                if idx == -1:
                    continue
                json_start = summary.find("{", idx)
                if json_start == -1:
                    continue
                json_end = summary.find("}", json_start)
                if json_end == -1:
                    continue
                try:
                    parsed = _json.loads(summary[json_start:json_end + 1])
                    if isinstance(parsed, dict):
                        target.update(cast(dict[str, str], parsed))
                except (ValueError, TypeError) as exc:
                    logger.warning(
                        "[orchestrator] failed to parse %s from task %s: %s",
                        marker.strip(":"), task.id, exc,
                    )

        return character_refs, location_refs

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

        desc_lower = shot_desc.lower()
        matched_loc_refs: list[str] = []

        for label, asset_id in location_refs.items():
            keywords = label.replace("_", " ").split()
            if any(kw in desc_lower for kw in keywords if len(kw) > 2):
                matched_loc_refs.append(asset_id)

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
            "Rewrite and expand the existing shot plan so it satisfies the "
            f"coverage contract ({issue_names}). Keep the strongest core idea, "
            f"but deliver enough visual beats for a {getattr(contract, 'target_duration_seconds', 0):.0f}-second "
            f"{getattr(getattr(contract, 'profile', None), 'value', 'creative')} piece. "
            f"Minimum shot count: {getattr(contract, 'min_shot_count', 'unknown')}. "
            f"Maximum dialogue share: {getattr(contract, 'max_dialogue_share', 0):.0%}. "
            f"{raw_coverage_note}"
            "Add silent visual beats, editorially useful inserts, and clearer pacing contrast. "
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

            source_task: TaskNode | None = None
            for dep_id in task.depends_on:
                dep_task = session.dag.get_task(dep_id)
                if (
                    dep_task
                    and dep_task.status == TaskStatus.COMPLETED
                    and dep_task.task_type == TaskType.CREATIVE
                    and dep_task.result_summary
                ):
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
            if repair_count >= _MAX_RETRIES_PER_TASK:
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
            changed = True

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

            if len(shot_list) > _MAX_SHOTS_PER_EXPANSION:
                logger.warning(
                    "[orchestrator] session=%s | shot list has %d entries, "
                    "capping at %d",
                    session.id[:8], len(shot_list), _MAX_SHOTS_PER_EXPANSION,
                )
                shot_list = shot_list[:_MAX_SHOTS_PER_EXPANSION]

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

                style_instruction = ""
                if visual_style_block:
                    style_instruction = (
                        f"VISUAL STYLE — apply these directives to the "
                        f"generate_image prompt:\n{visual_style_block}\n"
                        f"Write the prompt as a cinematic screen grab from a "
                        f"film using the camera, film stock, lens, and style "
                        f"references above. Describe blocking, atmosphere, "
                        f"and spatial relationships in detail. "
                    )

                duration_instruction = (
                    f"IMPORTANT: Pass duration={api_duration} to "
                    f"generate_video. "
                )

                dialogue_instruction = ""
                dialogue = self._extract_dialogue(shot_desc)
                if dialogue:
                    dialogue_instruction = (
                        f"DIALOGUE IN THIS SHOT: \"{dialogue}\". "
                        f"Show the character actively speaking — mouth "
                        f"open, gestures matching the tone. The "
                        f"character's expression and body language should "
                        f"convey the emotional content of the line. "
                    )

                if has_refs:
                    ref_ids = self._select_refs_for_shot(
                        shot_desc, character_refs, location_refs,
                    )
                    refs_str = ", ".join(ref_ids)
                    description = (
                        f"Generate Shot {shot_num}: {style_instruction}"
                        f"First call generate_image "
                        f"with this visual description: \"{short_desc}\". "
                        f"{dialogue_instruction}"
                        f"IMPORTANT: Pass aspect_ratio='16:9' for standard "
                        f"landscape video framing. "
                        f"IMPORTANT: Pass ALL these reference asset IDs as "
                        f"image_urls — they include diverse location angles "
                        f"that give the model creative freedom while "
                        f"maintaining consistency: [{refs_str}]. "
                        f"Then call generate_video with mode=image_to_video "
                        f"using the generated image asset_id. "
                        f"{duration_instruction}"
                        f"Report the final video asset_id."
                    )
                else:
                    description = (
                        f"Generate Shot {shot_num}: {style_instruction}"
                        f"First call generate_image "
                        f"with this visual description: \"{short_desc}\". "
                        f"{dialogue_instruction}"
                        f"IMPORTANT: Pass aspect_ratio='16:9' for standard "
                        f"landscape video framing. "
                        f"Then call generate_video with mode=image_to_video "
                        f"using the generated image asset_id. "
                        f"{duration_instruction}"
                        f"Report the final video asset_id."
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
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            parsed = json.loads(text[start:end + 1])
            return parsed if isinstance(parsed, dict) else None
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
                for action in raw_actions:
                    if not isinstance(action, dict):
                        continue
                    kind = str(action.get("kind", "")).strip().lower()
                    if not kind:
                        continue
                    normalized: dict[str, Any] = {
                        "kind": kind,
                        "reason": str(action.get("reason", summary)).strip(),
                    }
                    shot_number = action.get("shot_number")
                    if isinstance(shot_number, int):
                        normalized["shot_number"] = shot_number
                    actions.append(normalized)
            if verdict == "fail" and not actions:
                actions.append({"kind": "recut_timeline", "reason": summary})
            return verdict, actions, summary

        failure_keywords = ("regenerate", "replace", "redo", "fix", "improve", "fail", "needs")
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
        if any(keyword in message_lower for keyword in failure_keywords):
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
        seen_keys: set[str] = set()

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
                continue

            if kind == "rewrite_script":
                dedupe_key = "rewrite_script"
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                correction_task = TaskNode(
                    id=f"correction-{review_key}-script-{iteration + 1}",
                    description=f"Rewrite the script based on review feedback: {reason}",
                    skill_id="advertising-screenwriter",
                    depends_on=[review_task.id],
                    status=TaskStatus.PENDING,
                    task_type=TaskType.CREATIVE,
                    tool_categories=[],
                    context_requirements=["prior_results"],
                )
                created_tasks.append(correction_task)
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

        for correction_task in created_tasks:
            session.dag.tasks.append(correction_task)

        for pending_task in downstream_pending:
            for correction_task in created_tasks:
                if correction_task.id not in pending_task.depends_on:
                    pending_task.depends_on.append(correction_task.id)

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
