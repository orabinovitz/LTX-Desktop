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
from agent.orchestration.creative_contracts import (
    CreativeProfile,
    build_coverage_contract,
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
        assert result[0] == (1, "A wide establishing shot.", 6)
        assert result[1] == (2, "Close-up of face.", 6)

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

    def test_duration_extracted_and_snapped(self):
        text = "Shot 1 (5s): A wide establishing shot of the beach. Shot 2 (10s): Close-up of the face."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 2
        assert result[0][0] == 1
        assert result[0][2] == 6  # 5 snaps to 6
        assert result[1][0] == 2
        assert result[1][2] == 10

    def test_duration_snaps_to_nearest(self):
        text = "Shot 1 (3s): Quick cut detail shot of scene. Shot 2 (21s): Long continuous tracking shot of the scene."
        result = Orchestrator._parse_shot_list(text)
        assert result[0][2] == 6  # 3 snaps to 6 (nearest)
        assert result[1][2] == 20  # 21 snaps to 20 (nearest)

    def test_no_duration_defaults_to_minimum(self):
        text = "Shot 1: A wide establishing shot with no duration."
        result = Orchestrator._parse_shot_list(text)
        assert result[0][2] == 6

    def test_prose_duration_fallback(self):
        """Prose format 'Duration: 8 seconds' is extracted when (Ns) is absent."""
        text = "Shot 1: A wide establishing shot. Duration: 8 seconds. Shot 2: Close-up. Duration: 12 seconds."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 2
        assert result[0][2] == 8
        assert result[1][2] == 12

    def test_standalone_seconds_fallback(self):
        """Standalone '10s' or '10 seconds' in description is extracted."""
        text = "Shot 1: A slow dolly-in on the character, 10 seconds. Shot 2: Quick detail insert, 6s."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 2
        assert result[0][2] == 10
        assert result[1][2] == 6

    def test_tilde_duration_fallback(self):
        """Approximate duration '~10s' is extracted."""
        text = "Shot 1: Establishing shot of the city at night, ~10sec."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 1
        assert result[0][2] == 10

    def test_strict_pattern_takes_precedence(self):
        """When both (Ns) and prose duration exist, (Ns) wins."""
        text = "Shot 1 (12s): A wide shot of the room. Duration: 8 seconds."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 1
        assert result[0][2] == 12

    def test_aspect_ratio_not_matched_as_duration(self):
        """'16:9' aspect ratio should not be parsed as a duration."""
        text = "Shot 1: A wide 16:9 shot of the landscape with no duration."
        result = Orchestrator._parse_shot_list(text)
        assert len(result) == 1
        assert result[0][2] == 6  # default, not 16


class TestExtractDialogue:
    def test_double_quoted_dialogue(self):
        text = 'Bugs turns to camera. BUGS: "Hey, what\'s up doc?" Camera pulls back.'
        result = Orchestrator._extract_dialogue(text)
        assert result is not None
        assert "what's up doc" in result

    def test_single_quoted_character_cue(self):
        text = "BUGS: 'Eh, these oil prices are killing me, doc!'"
        result = Orchestrator._extract_dialogue(text)
        assert result is not None
        assert "oil prices" in result

    def test_prose_attribution(self):
        text = 'Bugs says "This is outrageous!" and storms off.'
        result = Orchestrator._extract_dialogue(text)
        assert result is not None
        assert "outrageous" in result

    def test_multiple_dialogue_lines(self):
        text = 'BUGS: "What\'s up doc?" DAFFY: "You\'re despicable!"'
        result = Orchestrator._extract_dialogue(text)
        assert result is not None
        assert "What's up doc" in result
        assert "despicable" in result
        assert " / " in result

    def test_no_dialogue_returns_none(self):
        text = "A wide establishing shot of the city skyline at sunset."
        result = Orchestrator._extract_dialogue(text)
        assert result is None

    def test_short_quoted_text_ignored(self):
        """Quoted text under 3 chars should not be treated as dialogue."""
        text = 'The sign reads "OK" on the wall.'
        result = Orchestrator._extract_dialogue(text)
        assert result is None

    def test_long_dialogue_truncated(self):
        long_line = "A" * 250
        text = f'BUGS: "{long_line}"'
        result = Orchestrator._extract_dialogue(text)
        assert result is not None
        assert len(result) <= 200
        assert result.endswith("...")


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

    def test_up_to_three_matched_locations(self):
        chars = {}
        locs = {
            "diner_ext_wide": "loc1",
            "diner_int_entrance": "loc2",
            "diner_int_booth": "loc3",
            "diner_ext_alley": "loc4",
        }
        result = Orchestrator._select_refs_for_shot("Inside the diner", chars, locs)
        matched = [r for r in result if r.startswith("loc")]
        assert len(matched) == 3

    def test_fallback_to_two_locations(self):
        chars = {}
        locs = {"diner": "loc1", "park": "loc2", "office": "loc3"}
        result = Orchestrator._select_refs_for_shot("An unrelated scene description", chars, locs)
        assert "loc1" in result
        assert "loc2" in result
        assert "loc3" not in result

    def test_fallback_single_location(self):
        chars = {}
        locs = {"diner": "loc1"}
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

    def test_expanded_shot_tasks_dispatch_in_bounded_batches(self):
        http = FakeHTTPClient()
        orch = self._make_orchestrator(http)
        expected_limit = 4

        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                "Shot 1 (6s): Wide beach wreckage.\n"
                "Shot 2 (6s): Elara opens her eyes in the surf.\n"
                "Shot 3 (6s): Twisted metal in shallow water.\n"
                "Shot 4 (6s): Elara rises and looks down the beach.\n"
                "Shot 5 (6s): Smoke billows from the fuselage.\n"
                "Shot 6 (6s): Julian bursts from the jungle edge."
            ),
            skill_id="film-tv-screenwriting",
        )
        generation_task = _task(
            "task-2",
            depends_on=["task-1"],
            tool_categories=["generation"],
        )
        dag = _dag([script_task, generation_task])
        session = _session(dag)
        _sessions[session.id] = session

        for shot_num in range(6):
            http.queue("post", _gemini_response(f"Shot {shot_num + 1} complete"))

        resp = orch._execute_next(session)

        shot_tasks = [t for t in session.dag.tasks if t.id.startswith("task-2-shot-")]
        completed = [t for t in shot_tasks if t.status == TaskStatus.COMPLETED]
        pending = [t for t in shot_tasks if t.status == TaskStatus.PENDING]

        assert generation_task.status == TaskStatus.CANCELLED
        assert len(shot_tasks) == 6
        assert len(completed) == expected_limit
        assert len(pending) == 6 - expected_limit
        assert resp.done is False


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

    def test_structured_review_creates_targeted_shot_regen_tasks(self):
        session = _session(_dag([]))
        generation_task = _task(
            "task-4",
            status=TaskStatus.CANCELLED,
            task_type=TaskType.EXECUTION,
            tool_categories=["generation"],
        )
        shot_3 = _task(
            "task-4-shot-3",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            tool_categories=["generation"],
            skill_id="nano-banana-prompting",
        )
        shot_4 = _task(
            "task-4-shot-4",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.EXECUTION,
            tool_categories=["generation"],
            skill_id="nano-banana-prompting",
        )
        timeline_task = _task(
            "task-6",
            depends_on=["review-1"],
            task_type=TaskType.EXECUTION,
            tool_categories=["timeline_mgmt", "clip_editing"],
            skill_id="marketing-editor",
        )
        review_task = _task("review-1", task_type=TaskType.REVIEW, status=TaskStatus.COMPLETED, skill_id="marketing-editor")
        session.dag.tasks.extend([generation_task, shot_3, shot_4, timeline_task, review_task])

        review_message = """
{
  "overall_verdict": "fail",
  "summary": "Shots 3 and 4 are too on-the-nose and need replacement.",
  "actions": [
    {"kind": "regenerate_shot", "shot_number": 3, "reason": "Remove on-the-nose dialogue and rely on physical behavior."},
    {"kind": "regenerate_shot", "shot_number": 4, "reason": "Do not make a character speak the tagline."}
  ]
}
"""

        Orchestrator._handle_review_result(
            Orchestrator.__new__(Orchestrator),
            session,
            review_task,
            review_message,
        )

        correction_tasks = [t for t in session.dag.tasks if t.id.startswith("correction-review-1-shot-")]
        assert len(correction_tasks) == 2
        assert all(task.task_type == TaskType.EXECUTION for task in correction_tasks)
        assert all(task.skill_id == "nano-banana-prompting" for task in correction_tasks)
        assert all("review-1" in task.depends_on for task in correction_tasks)
        for correction_task in correction_tasks:
            assert correction_task.id in timeline_task.depends_on


class TestCoverageGuard:
    def test_undercovered_script_inserts_repair_task_before_generation(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                "Shot 1 (8s): Stadium tension.\n"
                "Shot 2 (6s): Pepsi can opens.\n"
                "Shot 3 (8s): Ball hits net.\n"
                "Shot 4 (8s): Fans celebrate."
            ),
            skill_id="advertising-screenwriter",
        )
        gen_task = _task(
            "task-2",
            depends_on=["task-1"],
            tool_categories=["generation"],
        )
        dag = TaskDAG(
            tasks=[script_task, gen_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is True
        repair_tasks = [t for t in session.dag.tasks if t.id.startswith("coverage-repair-")]
        assert len(repair_tasks) == 1
        assert repair_tasks[0].task_type == TaskType.CREATIVE
        assert repair_tasks[0].skill_id == "advertising-screenwriter"
        assert gen_task.depends_on == [repair_tasks[0].id]

    def test_dense_script_does_not_insert_repair_task(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                "Shot 1 (4s): Tunnel faces.\n"
                "Shot 2 (4s): Boots jitter.\n"
                "Shot 3 (4s): Cold Pepsi can.\n"
                "Shot 4 (4s): Eyes lock.\n"
                "Shot 5 (5s): Deep breath.\n"
                "Shot 6 (4s): First burst of movement.\n"
                "Shot 7 (5s): Confetti explodes."
            ),
            skill_id="advertising-screenwriter",
        )
        gen_task = _task(
            "task-2",
            depends_on=["task-1"],
            tool_categories=["generation"],
        )
        dag = TaskDAG(
            tasks=[script_task, gen_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is False
        assert [t for t in session.dag.tasks if t.id.startswith("coverage-repair-")] == []

    def test_dialogue_heavy_script_inserts_repair_task_before_generation(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                'Shot 1 (10s): A hero says "The world needs Pepsi right now."\\n'
                'Shot 2 (10s): A fan says "This is the taste of victory."\\n'
                'Shot 3 (10s): Another fan says "Thirsty for the world."'
            ),
            skill_id="advertising-screenwriter",
        )
        gen_task = _task(
            "task-2",
            depends_on=["task-1"],
            tool_categories=["generation"],
        )
        dag = TaskDAG(
            tasks=[script_task, gen_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is True
        repair_tasks = [t for t in session.dag.tasks if t.id.startswith("coverage-repair-")]
        assert len(repair_tasks) == 1

    def test_raw_coverage_script_does_not_repair_again(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "coverage-repair-task-2-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                'Shot 1 (8s): Tokyo arcade hook. Editorial Opportunity: cut on the stare.\\n'
                'Shot 2 (6s): Pepsi can crack. Editorial Opportunity: cut on the pop.\\n'
                'Shot 3 (6s): Match-cut football spin. Editorial Opportunity: use as transition.\\n'
                'Shot 4 (8s): Rio chest trap. Dialogue: FAN: "Minha vez!" Editorial Opportunity: trim to contact.\\n'
                'Shot 5 (6s): Sneaker volley insert. Editorial Opportunity: cut on impact.\\n'
                'Shot 6 (8s): London pub catch and raise. Editorial Opportunity: cut on the lift.\\n'
                'Shot 7 (6s): Crowd reaction. Editorial Opportunity: speed ramp.\\n'
                'Shot 8 (6s): Speaker cone bass hit. Editorial Opportunity: percussion insert.\\n'
                'Shot 9 (8s): Stadium tag. Editorial Opportunity: hold logo resolve.'
            ),
            skill_id="advertising-screenwriter",
        )
        gen_task = _task(
            "task-4",
            depends_on=["coverage-repair-task-2-1"],
            tool_categories=["generation"],
        )
        dag = TaskDAG(
            tasks=[script_task, gen_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is False
        assert [t for t in session.dag.tasks if t.id.startswith("coverage-repair-task-4")] == []

    def test_scene_preproduction_tasks_do_not_trigger_coverage_repair(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                "Shot 1 (8s): Stadium tension.\n"
                "Shot 2 (6s): Pepsi can opens.\n"
                "Shot 3 (8s): Ball hits net.\n"
                "Shot 4 (8s): Fans celebrate."
            ),
            skill_id="advertising-screenwriter",
        )
        preprod_task = _task(
            "task-4",
            depends_on=["task-1"],
            tool_categories=["generation"],
            skill_id="scene-preproduction",
        )
        dag = TaskDAG(
            tasks=[script_task, preprod_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is False
        assert [t for t in session.dag.tasks if t.id.startswith("coverage-repair-")] == []

    def test_coverage_repair_prefers_script_source_not_other_creative_dependency(self):
        orch = Orchestrator.__new__(Orchestrator)
        script_task = _task(
            "task-1",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary=(
                "Shot 1 (8s): Stadium tension.\n"
                "Shot 2 (6s): Pepsi can opens.\n"
                "Shot 3 (8s): Ball hits net.\n"
                "Shot 4 (8s): Fans celebrate."
            ),
            skill_id="advertising-screenwriter",
        )
        style_task = _task(
            "task-3",
            status=TaskStatus.COMPLETED,
            task_type=TaskType.CREATIVE,
            result_summary="NB2_STYLE_BLOCK:\ncamera: ARRI ALEXA 35\nfilm_stock: Kodak VISION3 500T 5219",
            skill_id="cinematography",
        )
        gen_task = _task(
            "task-6",
            depends_on=["task-1", "task-3"],
            tool_categories=["generation"],
        )
        dag = TaskDAG(
            tasks=[script_task, style_task, gen_task],
            original_prompt="Create a 30-second Pepsi World Cup ad",
            target_duration_seconds=30,
            creative_profile=CreativeProfile.BRAND_CINEMATIC,
            coverage_contract=build_coverage_contract(
                profile=CreativeProfile.BRAND_CINEMATIC,
                target_duration_seconds=30,
            ),
        )
        session = _session(dag)

        changed = orch._apply_coverage_guard(session, dag.get_ready_tasks())

        assert changed is True
        repair_task = next(t for t in session.dag.tasks if t.id.startswith("coverage-repair-"))
        assert "Shot 1 (8s): Stadium tension." in repair_task.description
        assert "NB2_STYLE_BLOCK" not in repair_task.description


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

    def test_start_structured_fallback_on_single_task_multistep_prompt(self):
        """When the planner returns 1 task for a multi-step prompt, the
        structured fallback produces a proper multi-task DAG."""
        http = FakeHTTPClient()
        http.queue("post", _planner_response([
            {"id": "task-1", "description": "Do everything", "task_type": "execution",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
        ]))

        prompt = (
            "create a short script, then do text to video to create a "
            "1-2 minutes scene of bugs bunny from looney tunes, something "
            "about the rise of oil prices due to the war with iran - it "
            "should really capture the looney tunes and bugs bunny feel - "
            "it should have dialogues, then edit a scene from it"
        )
        orch = Orchestrator(api_key="fake-key", http_client=http, skill_registry=SkillRegistry())
        resp = orch.start(OrchestrateRequest(prompt=prompt))

        assert len(resp.tasks) == 5
        assert resp.tasks[0].status == TaskStatus.PENDING.value

    def test_start_no_fallback_when_planner_returns_multiple_tasks(self):
        """When the planner returns a proper multi-task DAG, no fallback is used."""
        http = FakeHTTPClient()
        http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
            {"id": "task-2", "description": "Generate video", "task_type": "execution",
             "depends_on": ["task-1"], "tool_categories": ["generation"],
             "context_requirements": ["prior_results"]},
        ], duration=90))

        prompt = "first write a script then generate a video from it"
        orch = Orchestrator(api_key="fake-key", http_client=http, skill_registry=SkillRegistry())
        resp = orch.start(OrchestrateRequest(prompt=prompt))

        assert len(resp.tasks) == 2
        assert resp.tasks[0].description == "Write script"


# ====================================================================
# End-to-end orchestration tests
# ====================================================================


class TestEndToEndOrchestration:
    """Simulate the Bugs Bunny prompt through the full orchestration loop."""

    BUGS_BUNNY_PROMPT = (
        "create a short script, then do text to video to create a "
        "1-2 minutes scene of bugs bunny from looney tunes, something "
        "about the rise of oil prices due to the war with iran - it "
        "should really capture the looney tunes and bugs bunny feel - "
        "it should have dialogues, then edit a scene from it"
    )

    def _make_orchestrator(self, http: FakeHTTPClient) -> Orchestrator:
        return Orchestrator(
            api_key="fake-key",
            http_client=http,
            skill_registry=SkillRegistry(),
        )

    def test_full_loop_with_planner_fallback(self):
        """Planner returns 1 task -> fallback produces 5 tasks with pre/post review gates ->
        sub-agents run each task -> all tasks complete."""
        http = FakeHTTPClient()

        http.queue("post", _planner_response([
            {"id": "task-1", "description": "Do everything", "task_type": "execution",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
        ]))

        orch = self._make_orchestrator(http)
        resp = orch.start(OrchestrateRequest(prompt=self.BUGS_BUNNY_PROMPT))

        assert len(resp.tasks) == 5
        session_id = resp.session_id
        session = _get_session(session_id)
        assert session is not None
        dag = session.dag

        assert dag.tasks[0].task_type == TaskType.CREATIVE
        assert dag.tasks[1].task_type == TaskType.EXECUTION
        assert dag.tasks[2].task_type == TaskType.EXECUTION
        assert dag.tasks[3].task_type == TaskType.REVIEW
        assert dag.tasks[4].task_type == TaskType.REVIEW
        assert "generation" in dag.tasks[1].tool_categories
        assert "clip_editing" in dag.tasks[2].tool_categories

        # Advance: dispatch creative task (task-1).
        # Avoid "Shot N:" format to prevent _try_expand_shot_tasks.
        http.queue("post", _gemini_response(
            "Script: Bugs Bunny discovers oil prices have risen. "
            "He reads a newspaper about the war with Iran. "
            "Bugs delivers a classic monologue about the situation. "
            "The scene ends with Bugs breaking the fourth wall."
        ))
        resp = orch.continue_with_results(session_id, [])
        assert dag.tasks[0].status == TaskStatus.COMPLETED

        # Advance: dispatch generation task (task-2).
        http.queue("post", _gemini_response(function_calls=[{
            "name": "generate_video",
            "args": {"prompt": "Bugs Bunny reading newspaper", "mode": "text_to_video"},
        }]))
        resp = orch.continue_with_results(session_id, [])
        assert dag.tasks[1].status == TaskStatus.RUNNING
        assert len(resp.tool_calls) >= 1

        # Frontend executes generate_video and returns result.
        http.queue("post", _gemini_response("Generated 4 shots successfully."))
        tool_results = [ToolResult(
            tool_name="generate_video",
            call_id=resp.tool_calls[0].call_id,
            success=True,
            result={"asset_id": "video-asset-1"},
        )]
        resp = orch.continue_with_results(session_id, tool_results)
        assert dag.tasks[1].status == TaskStatus.COMPLETED

        # Advance: dispatch review task (task-4).
        http.queue("post", _gemini_response("Looks good. Approved for edit."))
        resp = orch.continue_with_results(session_id, [])
        assert dag.tasks[3].status == TaskStatus.COMPLETED

        # Advance: dispatch editing task (task-3).
        http.queue("post", _gemini_response(function_calls=[{
            "name": "add_clip_to_timeline",
            "args": {"asset_id": "video-asset-1", "track_index": 0},
        }]))
        resp = orch.continue_with_results(session_id, [])
        assert dag.tasks[2].status == TaskStatus.RUNNING

        # Frontend executes add_clip_to_timeline.
        http.queue("post", _gemini_response("Timeline assembled with 4 clips."))
        tool_results = [ToolResult(
            tool_name="add_clip_to_timeline",
            call_id=resp.tool_calls[0].call_id,
            success=True,
            result={"clip_id": "clip-1"},
        )]
        resp = orch.continue_with_results(session_id, tool_results)
        assert dag.tasks[2].status == TaskStatus.COMPLETED

        # Advance: dispatch final review task (task-5).
        http.queue("post", _gemini_response("Approved. The timeline is coherent."))
        resp = orch.continue_with_results(session_id, [])
        assert dag.tasks[4].status == TaskStatus.COMPLETED
        resp = orch.continue_with_results(session_id, [])
        assert resp.done is True
        assert session.status == OrchestratorStatus.DONE

    def test_execution_tasks_always_have_categories(self):
        """Even when planner omits tool_categories, _ensure_execution_categories fills them."""
        http = FakeHTTPClient()
        http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
            {"id": "task-2", "description": "Generate a video of Bugs Bunny",
             "task_type": "execution", "depends_on": ["task-1"],
             "tool_categories": [], "context_requirements": ["prior_results"]},
            {"id": "task-3", "description": "Edit the timeline and trim clips",
             "task_type": "execution", "depends_on": ["task-2"],
             "tool_categories": [], "context_requirements": ["prior_results"]},
        ]))

        orch = self._make_orchestrator(http)
        resp = orch.start(OrchestrateRequest(
            prompt="first write a script then generate video then edit it",
        ))

        assert len(resp.tasks) == 3
        session = _get_session(resp.session_id)
        assert session is not None
        dag = session.dag

        for task in dag.tasks:
            if task.task_type == TaskType.EXECUTION:
                assert len(task.tool_categories) > 0, (
                    f"Execution task {task.id} should have inferred categories"
                )
