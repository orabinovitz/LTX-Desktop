from __future__ import annotations

import logging

from agent.orchestration.orchestrator import Orchestrator, OrchestratorSession, _sessions
from agent.orchestration.sub_agent_pool import SubAgentPool, _execute_backend_tools_parallel
from agent.skills.skill_registry import SkillRegistry
from agent.types import OrchestratorStatus, SubAgentContext, SubAgentResult, TaskDAG, TaskNode, TaskStatus, TaskType, ToolCall, ToolResult
from log_context import bind_log_context, log_extra, reset_log_context
from tests.fakes.services import FakeHTTPClient


def _task(task_id: str) -> TaskNode:
    return TaskNode(
        id=task_id,
        description=f"Task {task_id}",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )


def test_orchestrator_skip_log_includes_session_and_task_context(caplog) -> None:
    caplog.set_level(logging.INFO)
    _sessions.clear()
    session = OrchestratorSession(
        id="sess-log-1",
        dag=TaskDAG(tasks=[_task("task-log-1")], original_prompt="test"),
        status=OrchestratorStatus.EXECUTING,
    )
    _sessions[session.id] = session

    orchestrator = Orchestrator.__new__(Orchestrator)
    orchestrator._registry = SkillRegistry()  # type: ignore[attr-defined]

    orchestrator.skip_task(session.id, "task-log-1")

    records = [
        record
        for record in caplog.records
        if record.name == "agent.orchestration.orchestrator"
        and "skipped by user" in record.getMessage()
    ]
    assert len(records) == 1
    assert getattr(records[0], "agent_session_id", None) == "sess-log-1"
    assert getattr(records[0], "task_id", None) == "task-log-1"


def test_sub_agent_pool_parallel_execution_preserves_request_context(caplog, monkeypatch) -> None:
    caplog.set_level(logging.ERROR)
    tokens = bind_log_context(request_id="req-subagent-1", trace_id="trace-subagent-1")

    def _fake_execute_sub_agent(task, skill, context, api_key, http_client):  # noqa: ARG001
        logging.getLogger("subagent_pool_context_test").error(
            "sub-agent pool marker",
            extra=log_extra(category="sub-agent.test"),
        )
        return SubAgentResult(
            task_id=task.id,
            session_id=context.session_id,
            success=True,
            message="ok",
        )

    monkeypatch.setattr("agent.orchestration.sub_agent_pool.execute_sub_agent", _fake_execute_sub_agent)

    pool = SubAgentPool(api_key="fake-key", http_client=FakeHTTPClient())
    task_a = _task("task-a")
    task_b = _task("task-b")
    try:
        pool.execute_parallel([
            (task_a, None, SubAgentContext(task=task_a, session_id="sess-subagent-1")),
            (task_b, None, SubAgentContext(task=task_b, session_id="sess-subagent-1")),
        ])
    finally:
        reset_log_context(tokens)

    records = [
        record for record in caplog.records
        if record.name == "subagent_pool_context_test" and "sub-agent pool marker" in record.getMessage()
    ]
    assert len(records) == 2
    assert all(getattr(record, "request_id", None) == "req-subagent-1" for record in records)
    assert all(getattr(record, "trace_id", None) == "trace-subagent-1" for record in records)
    assert all(getattr(record, "agent_session_id", None) == "sess-subagent-1" for record in records)


def test_sub_agent_pool_execute_single_preserves_request_context(caplog, monkeypatch) -> None:
    caplog.set_level(logging.ERROR)
    tokens = bind_log_context(request_id="req-subagent-single", trace_id="trace-subagent-single")

    def _fake_execute_sub_agent(task, skill, context, api_key, http_client):  # noqa: ARG001
        logging.getLogger("subagent_single_context_test").error(
            "sub-agent single marker",
            extra=log_extra(category="sub-agent.test"),
        )
        return SubAgentResult(
            task_id=task.id,
            session_id=context.session_id,
            success=True,
            message="ok",
        )

    monkeypatch.setattr("agent.orchestration.sub_agent_pool.execute_sub_agent", _fake_execute_sub_agent)

    pool = SubAgentPool(api_key="fake-key", http_client=FakeHTTPClient())
    task = _task("task-single")
    try:
        pool.execute_single(task, None, SubAgentContext(task=task, session_id="sess-single-1"))
    finally:
        reset_log_context(tokens)

    records = [
        record for record in caplog.records
        if record.name == "subagent_single_context_test" and "sub-agent single marker" in record.getMessage()
    ]
    assert len(records) == 1
    assert getattr(records[0], "request_id", None) == "req-subagent-single"
    assert getattr(records[0], "trace_id", None) == "trace-subagent-single"
    assert getattr(records[0], "agent_session_id", None) == "sess-single-1"


def test_parallel_backend_tool_execution_preserves_request_context(caplog, monkeypatch) -> None:
    caplog.set_level(logging.ERROR)
    tokens = bind_log_context(request_id="req-tool-1", trace_id="trace-tool-1")

    def _fake_execute_backend_tool(tool_call, *, api_key, http_client, session_id, project_id=None):  # noqa: ARG001
        logging.getLogger("backend_tool_context_test").error(
            "backend tool marker",
            extra=log_extra(
                category="agent.tool.test",
                agent_session_id=session_id,
                tool_call_id=tool_call.call_id,
                task_id=tool_call.task_id,
            ),
        )
        return ToolResult(
            tool_name=tool_call.tool_name,
            call_id=tool_call.call_id,
            success=True,
            result={"ok": True},
        )

    monkeypatch.setattr("agent.gemini_agent._execute_backend_tool", _fake_execute_backend_tool)

    tool_calls = [
        ToolCall(tool_name="query_project_brain", call_id="call-a", task_id="task-a"),
        ToolCall(tool_name="read_project_memory", call_id="call-b", task_id="task-b"),
    ]
    try:
        _execute_backend_tools_parallel(
            tool_calls,
            api_key="fake-key",
            http_client=FakeHTTPClient(),
            session_id="sess-tools-1",
            inherited_context={"request_id": "req-tool-1", "trace_id": "trace-tool-1"},
        )
    finally:
        reset_log_context(tokens)

    records = [
        record for record in caplog.records
        if record.name == "backend_tool_context_test" and "backend tool marker" in record.getMessage()
    ]
    assert len(records) == 2
    assert all(getattr(record, "request_id", None) == "req-tool-1" for record in records)
    assert all(getattr(record, "trace_id", None) == "trace-tool-1" for record in records)
    assert all(getattr(record, "agent_session_id", None) == "sess-tools-1" for record in records)


def test_sub_agent_pool_resume_single_preserves_request_context(caplog, monkeypatch) -> None:
    caplog.set_level(logging.ERROR)
    tokens = bind_log_context(request_id="req-resume-1", trace_id="trace-resume-1")

    def _fake_resume_sub_agent(prev_result, tool_results, api_key, http_client, project_id=None):  # noqa: ARG001
        logging.getLogger("subagent_resume_context_test").error(
            "sub-agent resume marker",
            extra=log_extra(category="sub-agent.test"),
        )
        return SubAgentResult(
            task_id=prev_result.task_id,
            session_id=prev_result.session_id,
            success=True,
            message="ok",
        )

    monkeypatch.setattr("agent.orchestration.sub_agent_pool.resume_sub_agent", _fake_resume_sub_agent)

    pool = SubAgentPool(api_key="fake-key", http_client=FakeHTTPClient())
    try:
        pool.resume_single(
            SubAgentResult(task_id="task-resume", session_id="sess-resume-1", success=True, message="ok"),
            [],
        )
    finally:
        reset_log_context(tokens)

    records = [
        record for record in caplog.records
        if record.name == "subagent_resume_context_test" and "sub-agent resume marker" in record.getMessage()
    ]
    assert len(records) == 1
    assert getattr(records[0], "request_id", None) == "req-resume-1"
    assert getattr(records[0], "trace_id", None) == "trace-resume-1"
    assert getattr(records[0], "agent_session_id", None) == "sess-resume-1"
