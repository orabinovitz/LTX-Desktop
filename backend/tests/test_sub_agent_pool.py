"""Focused tests for sub-agent failure reporting."""

from __future__ import annotations

from agent.orchestration import sub_agent_pool as sub_agent_pool_module
from agent.orchestration.sub_agent_pool import SubAgentPool, _has_reference_assets, execute_sub_agent
from agent.types import SubAgentContext, TaskNode, TaskStatus, TaskType
from services.http_client.http_client import HttpTimeoutError
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _task(task_id: str = "task-1") -> TaskNode:
    return TaskNode(
        id=task_id,
        description="Summarize the brief.",
        depends_on=[],
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["core"],
        context_requirements=[],
    )


def test_execute_sub_agent_exposes_timeout_category() -> None:
    http = FakeHTTPClient()
    http.queue("post", HttpTimeoutError("timed out"))

    task = _task()
    context = SubAgentContext(task=task, prior_task_results={})

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is False
    assert result.error is not None
    assert result.error_category == "timeout"
    assert "timeout" in result.error.lower()


def test_execute_sub_agent_exposes_malformed_response_category() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={"candidates": [{"content": {}}]},
        ),
    )

    task = _task()
    context = SubAgentContext(task=task, prior_task_results={})

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is False
    assert result.error is not None
    assert result.error_category == "malformed_response"
    assert "malformed" in result.error.lower()


def test_execute_sub_agent_exposes_provider_safety_block_category() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}},
        ),
    )

    task = _task()
    context = SubAgentContext(task=task, prior_task_results={})

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is False
    assert result.error is not None
    assert result.error_category == "provider_safety_block"
    assert "prohibited_content" in result.error.lower()


def test_execute_parallel_categorizes_internal_worker_crashes(monkeypatch) -> None:
    def _boom(*_args, **_kwargs):
        raise RuntimeError("worker crashed")

    monkeypatch.setattr(sub_agent_pool_module, "execute_sub_agent", _boom)

    pool = SubAgentPool(api_key="test-key", http_client=FakeHTTPClient())
    tasks_with_context = [
        (_task("task-1"), None, SubAgentContext(task=_task("task-1"), prior_task_results={})),
        (_task("task-2"), None, SubAgentContext(task=_task("task-2"), prior_task_results={})),
    ]

    results = pool.execute_parallel(tasks_with_context)

    assert len(results) == 2
    assert all(result.success is False for result in results)
    assert all(result.error_category == "sub_agent_internal_error" for result in results)


def test_has_reference_assets_detects_reference_payload() -> None:
    assert _has_reference_assets(
        {
            "task-1": (
                'REFERENCE_PAYLOAD: {"characters": {"elara": {"asset_id": "char-1"}}, '
                '"locations": {"plane_wreckage_beach_wide": {"asset_id": "loc-1"}}}'
            )
        }
    ) is True
