"""Tests for agent.orchestration.orchestrator — static methods + DAG execution."""

from __future__ import annotations

import json
import time

import pytest

from agent.orchestration.orchestrator import (
    Orchestrator,
    OrchestratorSession,
    _build_response,
    _evict_stale_sessions,
    _get_session,
    _sessions,
)
from agent.types import (
    OrchestrateRequest,
    OrchestratorStatus,
    SkillContent,
    SkillDescriptor,
    SubAgentResult,
    TaskDAG,
    TaskNode,
    TaskStatus,
    TaskType,
    ToolCall,
    ToolResult,
)
from agent.skills.skill_registry import SkillRegistry
from tests.fakes.services import FakeHTTPClient, FakeResponse


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Ensure orchestrator session state is clean between tests."""
    _sessions.clear()
    yield
    _sessions.clear()


def _task(
    id: str,
    depends_on: list[str] | None = None,
    status: TaskStatus = TaskStatus.PENDING,
    task_type: TaskType = TaskType.EXECUTION,
    tool_categories: list[str] | None = None,
    result_summary: str = "",
    skill_id: str | None = None,
) -> TaskNode:
    return TaskNode(
        id=id,
        description=f"Task {id}",
        skill_id=skill_id,
        depends_on=depends_on or [],
        status=status,
        task_type=task_type,
        tool_categories=tool_categories or ["core"],
        result_summary=result_summary,
    )


def _dag(tasks: list[TaskNode], prompt: str = "test") -> TaskDAG:
    return TaskDAG(tasks=tasks, original_prompt=prompt)


def _session(
    dag: TaskDAG,
    session_id: str = "sess-1",
    status: OrchestratorStatus = OrchestratorStatus.EXECUTING,
) -> OrchestratorSession:
    return OrchestratorSession(id=session_id, dag=dag, status=status)


def _gemini_response(text: str = "", function_calls: list[dict] | None = None) -> FakeResponse:
    """Build a fake Gemini generateContent response."""
    parts = []
    if text:
        parts.append({"text": text})
    for fc in (function_calls or []):
        parts.append({"functionCall": fc})
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{"content": {"parts": parts}}],
        },
    )


def _planner_response(tasks_json: list[dict], duration: float | None = None) -> FakeResponse:
    """Build a fake Gemini response for the task planner."""
    payload: dict = {"tasks": tasks_json}
    if duration is not None:
        payload["target_duration_seconds"] = duration
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}],
        },
    )


# ====================================================================
# Static method tests (pure, no fakes needed)
# ====================================================================


class TestParseShotList:
    def test_standard_shots(self):
        text = "Shot 1: A wide establishing shot. Shot 2: Close-up of face. Shot 3: Medium tracking."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 3
        assert result[0] == (1, "A wide establishing shot.")
        assert result[1] == (2, "Close-up of face.")

    def test_dash_separator(self):
        text = "Shot 1 - Wide angle of cityscape at sunset. Shot 2 - Interior, character enters."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 2

    def test_empty_text(self):
        assert Orchestrator._parse_shot_list("") == []

    def test_no_shots(self):
        assert Orchestrator._parse_shot_list("Just some regular text.") == []

    def test_short_descriptions_filtered(self):
        text = "Shot 1: OK. Shot 2: A very long descriptive text about the scene."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 1
        assert result[0][0] == 2


class TestParseReferenceAssets:
    def test_character_refs_parsed(self):
        dag = _dag([_task(
            "t1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            result_summary='CHARACTER_REFS: {"alice": "asset-1", "bob": "asset-2"}',
        )])
        chars, locs = Orchestrator._parse_reference_assets(dag)
        assert chars == {"alice": "asset-1", "bob": "asset-2"}
        assert locs == {}

    def test_location_refs_parsed(self):
        dag = _dag([_task(
            "t1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            result_summary='LOCATION_REFS: {"diner": "asset-3"}',
        )])
        chars, locs = Orchestrator._parse_reference_assets(dag)
        assert chars == {}
        assert locs == {"diner": "asset-3"}

    def test_both_refs_in_same_task(self):
        dag = _dag([_task(
            "t1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            result_summary='CHARACTER_REFS: {"alice": "a1"} LOCATION_REFS: {"park": "a2"}',
        )])
        chars, locs = Orchestrator._parse_reference_assets(dag)
        assert chars == {"alice": "a1"}
        assert locs == {"park": "a2"}

    def test_invalid_json_skipped(self):
        dag = _dag([_task(
            "t1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            result_summary='CHARACTER_REFS: {not valid json}',
        )])
        chars, locs = Orchestrator._parse_reference_assets(dag)
        assert chars == {}

    def test_non_completed_tasks_ignored(self):
        dag = _dag([_task(
            "t1",
            status=TaskStatus.PENDING,
            task_type=TaskType.EXECUTION,
            result_summary='CHARACTER_REFS: {"alice": "a1"}',
        )])
        chars, locs = Orchestrator._parse_reference_assets(dag)
        assert chars == {}


class TestSelectRefsForShot:
    def test_all_character_refs_included(self):
        chars = {"alice": "a1", "bob": "a2"}
        locs = {}
        result = Orchestrator._select_refs_for_shot("A scene", chars, locs)
        assert "a1" in result
        assert "a2" in result

    def test_matching_location_included(self):
        chars = {}
        locs = {"diner_interior": "loc1", "park_exterior": "loc2"}
        result = Orchestrator._select_refs_for_shot("Interior of the diner", chars, locs)
        assert "loc1" in result

    def test_fallback_to_first_location(self):
        chars = {}
        locs = {"diner": "loc1", "park": "loc2"}
        result = Orchestrator._select_refs_for_shot("An unrelated scene description", chars, locs)
        assert "loc1" in result

    def test_capped_at_five(self):
        chars = {f"c{i}": f"a{i}" for i in range(6)}
        locs = {"place": "loc1"}
        result = Orchestrator._select_refs_for_shot("place scene", chars, locs)
        assert len(result) <= 5

    def test_deduplication(self):
        chars = {"alice": "shared-id"}
        locs = {"place": "shared-id"}
        result = Orchestrator._select_refs_for_shot("place scene", chars, locs)
        assert result.count("shared-id") == 1


class TestCancelDependents:
    def _orch(self) -> Orchestrator:
        return Orchestrator.__new__(Orchestrator)

    def test_direct_dependents_cancelled(self):
        t1 = _task("t1", status=TaskStatus.FAILED)
        t2 = _task("t2", depends_on=["t1"])
        dag = _dag([t1, t2])
        self._orch()._cancel_dependents(dag, "t1")
        assert t2.status == TaskStatus.CANCELLED

    def test_cascading_cancellation(self):
        t1 = _task("t1", status=TaskStatus.FAILED)
        t2 = _task("t2", depends_on=["t1"])
        t3 = _task("t3", depends_on=["t2"])
        dag = _dag([t1, t2, t3])
        self._orch()._cancel_dependents(dag, "t1")
        assert t2.status == TaskStatus.CANCELLED
        assert t3.status == TaskStatus.CANCELLED

    def test_unrelated_tasks_unaffected(self):
        t1 = _task("t1", status=TaskStatus.FAILED)
        t2 = _task("t2", depends_on=["t1"])
        t3 = _task("t3")
        dag = _dag([t1, t2, t3])
        self._orch()._cancel_dependents(dag, "t1")
        assert t3.status == TaskStatus.PENDING


class TestAnyTaskMutates:
    def test_mutation_category_detected(self):
        tasks = [_task("t1", tool_categories=["clip_editing"])]
        assert Orchestrator._any_task_mutates(tasks) is True

    def test_non_mutation_safe(self):
        tasks = [_task("t1", tool_categories=["generation"])]
        assert Orchestrator._any_task_mutates(tasks) is False

    def test_mixed_returns_true(self):
        tasks = [
            _task("t1", tool_categories=["generation"]),
            _task("t2", tool_categories=["timeline_mgmt"]),
        ]
        assert Orchestrator._any_task_mutates(tasks) is True


class TestSummarizeResults:
    def test_success(self):
        results = [ToolResult(tool_name="trim_clip", success=True, result={"clip_id": "c1"})]
        summary = Orchestrator._summarize_results(results)
        assert "trim_clip" in summary
        assert "c1" in summary

    def test_failure(self):
        results = [ToolResult(tool_name="trim_clip", success=False, error="Clip not found")]
        summary = Orchestrator._summarize_results(results)
        assert "FAILED" in summary
        assert "Clip not found" in summary

    def test_mixed(self):
        results = [
            ToolResult(tool_name="a", success=True, result="ok"),
            ToolResult(tool_name="b", success=False, error="fail"),
        ]
        summary = Orchestrator._summarize_results(results)
        assert "a: ok" in summary
        assert "b: FAILED" in summary


class TestBuildFinalSummary:
    def test_all_completed(self):
        session = _session(_dag([
            _task("t1", status=TaskStatus.COMPLETED),
            _task("t2", status=TaskStatus.COMPLETED),
        ]))
        summary = Orchestrator._build_final_summary(session)
        assert "Completed 2" in summary

    def test_mixed_status(self):
        session = _session(_dag([
            _task("t1", status=TaskStatus.COMPLETED),
            _task("t2", status=TaskStatus.FAILED),
            _task("t3", status=TaskStatus.CANCELLED),
        ]))
        summary = Orchestrator._build_final_summary(session)
        assert "Completed 1" in summary
        assert "1 task(s) failed" in summary
        assert "1 task(s) cancelled" in summary

    def test_empty_dag(self):
        session = _session(_dag([]))
        summary = Orchestrator._build_final_summary(session)
        assert summary == "All tasks completed."


# ====================================================================
# Session management tests
# ====================================================================


class TestSessionManagement:
    def test_evict_stale_sessions(self):
        s = _session(_dag([]), session_id="old")
        s.last_access = time.monotonic() - 3600
        _sessions["old"] = s
        _evict_stale_sessions()
        assert "old" not in _sessions

    def test_evict_respects_max(self):
        for i in range(25):
            sid = f"sess-{i}"
            s = _session(_dag([]), session_id=sid)
            _sessions[sid] = s
        _evict_stale_sessions()
        assert len(_sessions) <= 20

    def test_get_session_found(self):
        s = _session(_dag([]), session_id="x")
        _sessions["x"] = s
        result = _get_session("x")
        assert result is not None
        assert result.id == "x"

    def test_get_session_not_found(self):
        assert _get_session("nonexistent") is None

    def test_get_session_updates_access_time(self):
        s = _session(_dag([]), session_id="y")
        old_access = s.last_access
        _sessions["y"] = s
        time.sleep(0.01)
        _get_session("y")
        assert s.last_access > old_access


# ====================================================================
# Orchestrator.continue_with_results tests
# ====================================================================


class TestContinueWithResults:
    def _make_orchestrator(self, http: FakeHTTPClient) -> Orchestrator:
        return Orchestrator(
            api_key="fake-key",
            http_client=http,
            skill_registry=SkillRegistry(),
        )

    def test_expired_session_returns_error(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)
        resp = orch.continue_with_results("no-such-session", [])
        assert resp.done is True
        assert "expired" in resp.message.lower() or "not found" in resp.message.lower()

    def test_all_tools_succeed_completes_tasks(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", status=TaskStatus.RUNNING)
        dag = _dag([t1])
        session = _session(dag, session_id="s1")
        session.pending_task_ids = ["t1"]
        _sessions["s1"] = session

        results = [ToolResult(tool_name="trim_clip", success=True, result="ok")]
        resp = orch.continue_with_results("s1", results)
        assert t1.status == TaskStatus.COMPLETED
        assert resp.done is True

    def test_tool_failure_retries(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", status=TaskStatus.RUNNING)
        t1.retry_count = 0
        dag = _dag([t1])
        session = _session(dag, session_id="s2")
        session.pending_task_ids = ["t1"]
        _sessions["s2"] = session

        # Queue a Gemini response for the retry execution
        http.queue("post", _gemini_response("Done retrying"))

        results = [ToolResult(tool_name="trim_clip", success=False, error="oops")]
        resp = orch.continue_with_results("s2", results)
        assert t1.retry_count == 1
        assert t1.status != TaskStatus.FAILED

    def test_max_retries_fails_and_cancels_dependents(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", status=TaskStatus.RUNNING)
        t1.retry_count = 2  # already at max
        t2 = _task("t2", depends_on=["t1"])
        dag = _dag([t1, t2])
        session = _session(dag, session_id="s3")
        session.pending_task_ids = ["t1"]
        _sessions["s3"] = session

        results = [ToolResult(tool_name="trim_clip", success=False, error="oops")]
        resp = orch.continue_with_results("s3", results)
        assert t1.status == TaskStatus.FAILED
        assert t2.status == TaskStatus.CANCELLED

    def test_empty_results_advances_dag(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", status=TaskStatus.COMPLETED)
        t2 = _task("t2", depends_on=["t1"])
        dag = _dag([t1, t2])
        session = _session(dag, session_id="s4")
        session.pending_task_ids = ["t1"]
        _sessions["s4"] = session

        # Queue Gemini response for executing t2
        http.queue("post", _gemini_response("Task 2 done"))

        resp = orch.continue_with_results("s4", [])
        assert t2.status in (TaskStatus.COMPLETED, TaskStatus.RUNNING)


# ====================================================================
# Orchestrator._execute_next tests
# ====================================================================


class TestExecuteNext:
    def _make_orchestrator(self, http: FakeHTTPClient) -> Orchestrator:
        return Orchestrator(
            api_key="fake-key",
            http_client=http,
            skill_registry=SkillRegistry(),
        )

    def test_dag_complete_returns_done(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        dag = _dag([
            _task("t1", status=TaskStatus.COMPLETED),
            _task("t2", status=TaskStatus.COMPLETED),
        ])
        session = _session(dag)
        _sessions[session.id] = session

        resp = orch._execute_next(session)
        assert resp.done is True
        assert session.status == OrchestratorStatus.DONE

    def test_no_ready_tasks_no_running_returns_error(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        dag = _dag([
            _task("t1", status=TaskStatus.FAILED),
            _task("t2", depends_on=["t1"]),
        ])
        # t2 depends on t1 which failed, but t2 is PENDING not CANCELLED
        # get_ready_tasks returns t2 because t1 is in terminal state (FAILED)
        # Actually let's make a scenario with no ready tasks
        t1 = _task("t1", status=TaskStatus.FAILED)
        t2 = _task("t2", depends_on=["t1"], status=TaskStatus.CANCELLED)
        dag = _dag([t1, t2])
        session = _session(dag)
        _sessions[session.id] = session

        resp = orch._execute_next(session)
        # All terminal → done
        assert resp.done is True

    def test_ready_task_dispatched(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", status=TaskStatus.COMPLETED, result_summary="Did thing 1")
        t2 = _task("t2", depends_on=["t1"], tool_categories=["generation"])
        dag = _dag([t1, t2])
        session = _session(dag)
        _sessions[session.id] = session

        # Sub-agent returns a text-only response (no tool calls → completed)
        http.queue("post", _gemini_response("Generated the video successfully"))

        resp = orch._execute_next(session)
        assert t2.status == TaskStatus.COMPLETED

    def test_sub_agent_returns_frontend_tool_calls(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)

        t1 = _task("t1", tool_categories=["generation"])
        dag = _dag([t1])
        session = _session(dag)
        _sessions[session.id] = session

        # Sub-agent returns a function call targeting frontend
        http.queue("post", _gemini_response(function_calls=[{
            "name": "generate_video",
            "args": {"prompt": "a cat"},
        }]))

        resp = orch._execute_next(session)
        assert session.status == OrchestratorStatus.AWAITING_TOOL_RESULTS
        assert len(resp.tool_calls) >= 1


# ====================================================================
# Orchestrator._handle_review_result tests
# ====================================================================


class TestHandleReviewResult:
    def test_approval_no_correction_added(self):
        session = _session(_dag([]))
        review_task = _task("review-1", task_type=TaskType.REVIEW, status=TaskStatus.COMPLETED)
        Orchestrator._handle_review_result(
            Orchestrator.__new__(Orchestrator),
            session, review_task, "Everything looks great. LGTM.",
        )
        assert len(session.dag.tasks) == 0

    def test_correction_needed_adds_task(self):
        session = _session(_dag([]))
        review_task = _task("review-1", task_type=TaskType.REVIEW, status=TaskStatus.COMPLETED)
        session.dag.tasks.append(review_task)

        Orchestrator._handle_review_result(
            Orchestrator.__new__(Orchestrator),
            session, review_task, "Shot 3 needs regeneration. Fix the lighting.",
        )
        correction_tasks = [t for t in session.dag.tasks if t.id.startswith("correction-")]
        assert len(correction_tasks) == 1
        assert correction_tasks[0].depends_on == ["review-1"]

    def test_max_review_iterations_stops(self):
        session = _session(_dag([]))
        review_task = _task("review-1", task_type=TaskType.REVIEW, status=TaskStatus.COMPLETED)
        session.dag.tasks.append(review_task)
        session.review_iteration_count["review-1"] = 2  # already at max

        initial_count = len(session.dag.tasks)
        Orchestrator._handle_review_result(
            Orchestrator.__new__(Orchestrator),
            session, review_task, "Still needs improvement. Fix it.",
        )
        assert len(session.dag.tasks) == initial_count


# ====================================================================
# Orchestrator.start tests
# ====================================================================


class TestOrchestratorStart:
    def test_start_creates_session(self):
        http = FakeHTTPClient()
        http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
            {"id": "task-2", "description": "Generate", "task_type": "execution",
             "depends_on": ["task-1"], "tool_categories": ["generation"],
             "context_requirements": ["prior_results"]},
        ], duration=60))

        orch = Orchestrator(api_key="fake-key", http_client=http, skill_registry=SkillRegistry())
        request = OrchestrateRequest(prompt="Make a short video")
        resp = orch.start(request)

        assert resp.session_id
        assert len(resp.tasks) == 2
        assert resp.status == OrchestratorStatus.EXECUTING.value

    def test_start_caps_tasks_at_max(self):
        http = FakeHTTPClient()
        many_tasks = [
            {"id": f"task-{i}", "description": f"Task {i}", "task_type": "execution",
             "depends_on": [], "tool_categories": ["core"], "context_requirements": []}
            for i in range(100)
        ]
        http.queue("post", _planner_response(many_tasks))

        orch = Orchestrator(api_key="fake-key", http_client=http, skill_registry=SkillRegistry())
        request = OrchestrateRequest(prompt="Do many things")
        resp = orch.start(request)

        assert len(resp.tasks) <= 75
