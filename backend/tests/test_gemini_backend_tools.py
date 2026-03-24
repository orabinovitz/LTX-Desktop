"""Focused tests for backend-side agent tool behavior."""

from __future__ import annotations

from agent.brain import ProjectBrain, _brain_lock, _brains
from agent.gemini_agent import _handle_query_brain
from agent.types import ToolCall
from tests.test_brain import _clip


def test_query_project_brain_scopes_to_active_project() -> None:
    with _brain_lock:
        _brains.clear()
        _brains["proj-1"] = ProjectBrain(
            project_id="proj-1",
            clips=[_clip(asset_id="p1-audio", description="audio quality improvements")],
        )
        _brains["proj-2"] = ProjectBrain(
            project_id="proj-2",
            clips=[_clip(asset_id="p2-audio", description="audio quality improvements from another project")],
        )

    result = _handle_query_brain(
        ToolCall(
            tool_name="query_project_brain",
            arguments={"query": "audio", "project_id": "proj-1"},
        ),
    )

    assert result.success is True
    matches = result.result["matches"]
    assert matches
    assert all(match["asset_id"].startswith("p1-") for match in matches)


def test_query_project_brain_without_scope_returns_error() -> None:
    with _brain_lock:
        _brains.clear()
        _brains["proj-1"] = ProjectBrain(
            project_id="proj-1",
            clips=[_clip(asset_id="p1-audio", description="audio quality improvements")],
        )

    result = _handle_query_brain(
        ToolCall(
            tool_name="query_project_brain",
            arguments={"query": "audio"},
        ),
    )

    assert result.success is False
    assert "project_id" in (result.error or "")
