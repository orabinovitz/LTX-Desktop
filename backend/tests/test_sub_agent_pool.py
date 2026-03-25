"""Focused tests for sub-agent failure reporting."""

from __future__ import annotations

from agent.orchestration.sub_agent_pool import _has_reference_assets, execute_sub_agent
from agent.types import SubAgentContext, TaskNode, TaskStatus, TaskType
from services.http_client.http_client import HttpTimeoutError
from tests.fakes.services import FakeHTTPClient


def _task() -> TaskNode:
    return TaskNode(
        id="task-1",
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
    assert "timeout" in result.error.lower()


def test_has_reference_assets_detects_reference_payload() -> None:
    assert _has_reference_assets(
        {
            "task-1": (
                'REFERENCE_PAYLOAD: {"characters": {"elara": {"asset_id": "char-1"}}, '
                '"locations": {"plane_wreckage_beach_wide": {"asset_id": "loc-1"}}}'
            )
        }
    ) is True
