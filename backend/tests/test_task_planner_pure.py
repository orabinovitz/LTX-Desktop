"""Pure function tests for agent.orchestration.task_planner."""

from __future__ import annotations

import pytest

from agent.orchestration.task_planner import (
    TaskPlanner,
    _build_skill_catalog,
    _parse_planner_response,
    _validate_dag,
)
from agent.types import SkillDescriptor, TaskDAG, TaskNode, TaskStatus, TaskType


# ---------------------------------------------------------------------------
# _build_skill_catalog
# ---------------------------------------------------------------------------


def test_build_skill_catalog_empty_returns_placeholder() -> None:
    """Empty list returns placeholder string."""
    result = _build_skill_catalog([])
    assert result == "(no specialized skills available — use null for all tasks)"


def test_build_skill_catalog_single_descriptor_with_categories() -> None:
    """Single descriptor with categories produces formatted line."""
    desc = SkillDescriptor(
        id="visual-identity",
        name="Visual Identity",
        description="Researches reference films and produces visual identity bibles.",
        tool_categories=["analysis", "memory"],
    )
    result = _build_skill_catalog([desc])
    assert "- **visual-identity** (Visual Identity):" in result
    assert "Researches reference films" in result
    assert "[categories: analysis, memory]" in result


def test_build_skill_catalog_multiple_descriptors() -> None:
    """Multiple descriptors produce multi-line output."""
    descs = [
        SkillDescriptor(id="a", name="A", description="First", tool_categories=["gen"]),
        SkillDescriptor(id="b", name="B", description="Second", tool_categories=["edit"]),
    ]
    result = _build_skill_catalog(descs)
    assert "- **a** (A): First [categories: gen]" in result
    assert "- **b** (B): Second [categories: edit]" in result
    assert result.count("\n") == 1


def test_build_skill_catalog_no_categories_shows_general() -> None:
    """Descriptor with no categories shows 'general'."""
    desc = SkillDescriptor(
        id="general-skill",
        name="General",
        description="Does stuff.",
        tool_categories=[],
    )
    result = _build_skill_catalog([desc])
    assert "[categories: general]" in result


# ---------------------------------------------------------------------------
# _validate_dag
# ---------------------------------------------------------------------------


def _task(id: str, depends_on: list[str]) -> TaskNode:
    return TaskNode(
        id=id,
        description="",
        skill_id=None,
        depends_on=depends_on,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )


def test_validate_dag_valid_acyclic_passes_unchanged() -> None:
    """Valid acyclic DAG passes through unchanged."""
    tasks = [
        _task("task-1", []),
        _task("task-2", ["task-1"]),
        _task("task-3", ["task-1", "task-2"]),
    ]
    result = _validate_dag(tasks)
    assert [t.depends_on for t in result] == [[], ["task-1"], ["task-1", "task-2"]]


def test_validate_dag_removes_unknown_dependency_references() -> None:
    """Unknown dependency references are removed."""
    tasks = [
        _task("task-1", []),
        _task("task-2", ["task-1", "task-99"]),  # task-99 does not exist
    ]
    result = _validate_dag(tasks)
    assert result[1].depends_on == ["task-1"]


def test_validate_dag_simple_cycle_removes_edges() -> None:
    """Simple cycle A→B, B→A removes cycle edges."""
    tasks = [
        _task("task-a", ["task-b"]),
        _task("task-b", ["task-a"]),
    ]
    result = _validate_dag(tasks)
    assert result[0].depends_on == []
    assert result[1].depends_on == []


def test_validate_dag_longer_cycle_removes_edges() -> None:
    """Longer cycle A→B→C→A removes cycle edges."""
    tasks = [
        _task("task-a", ["task-c"]),
        _task("task-b", ["task-a"]),
        _task("task-c", ["task-b"]),
    ]
    result = _validate_dag(tasks)
    assert result[0].depends_on == []
    assert result[1].depends_on == []
    assert result[2].depends_on == []


def test_validate_dag_mixed_valid_and_cycle_removes_only_cycle_edges() -> None:
    """Valid deps preserved; only cycle edges removed."""
    tasks = [
        _task("task-1", []),
        _task("task-a", ["task-b", "task-1"]),
        _task("task-b", ["task-a"]),
    ]
    result = _validate_dag(tasks)
    # task-1: no deps
    assert result[0].depends_on == []
    # task-a: was [task-b, task-1]; task-b in cycle, task-1 not
    assert result[1].depends_on == ["task-1"]
    # task-b: was [task-a]; task-a in cycle
    assert result[2].depends_on == []


def test_validate_dag_self_referencing_cycle_detected() -> None:
    """Self-referencing task A→A is cycle, edge removed."""
    tasks = [_task("task-a", ["task-a"])]
    result = _validate_dag(tasks)
    assert result[0].depends_on == []


# ---------------------------------------------------------------------------
# _parse_planner_response
# ---------------------------------------------------------------------------


def test_parse_planner_response_dict_with_tasks_and_duration() -> None:
    """Dict with tasks and target_duration_seconds extracts both."""
    text = '{"tasks": [{"id": "task-1"}], "target_duration_seconds": 180}'
    tasks, duration = _parse_planner_response(text)
    assert tasks == [{"id": "task-1"}]
    assert duration == 180.0


def test_parse_planner_response_dict_with_tasks_no_duration() -> None:
    """Dict with tasks key, no duration returns (tasks, None)."""
    text = '{"tasks": [{"id": "task-1", "description": "Do X"}]}'
    tasks, duration = _parse_planner_response(text)
    assert tasks == [{"id": "task-1", "description": "Do X"}]
    assert duration is None


def test_parse_planner_response_bare_list() -> None:
    """Bare JSON list returns (list, None)."""
    text = '[{"id": "task-1"}, {"id": "task-2"}]'
    tasks, duration = _parse_planner_response(text)
    assert tasks == [{"id": "task-1"}, {"id": "task-2"}]
    assert duration is None


def test_parse_planner_response_code_fenced_json() -> None:
    """Code-fenced JSON strips fences and parses."""
    text = '```json\n{"tasks": [{"id": "task-1"}], "target_duration_seconds": 90}\n```'
    tasks, duration = _parse_planner_response(text)
    assert tasks == [{"id": "task-1"}]
    assert duration == 90.0


def test_parse_planner_response_invalid_shape_raises() -> None:
    """Invalid shape (e.g. string) raises ValueError."""
    text = '"just a string"'
    with pytest.raises(ValueError, match="Unexpected planner response shape"):
        _parse_planner_response(text)


# ---------------------------------------------------------------------------
# TaskPlanner._fallback_dag
# ---------------------------------------------------------------------------


def test_fallback_dag_creates_single_task_with_prompt() -> None:
    """Creates single-task DAG with prompt as description."""
    prompt = "Create a 30-second ad for my product"
    dag = TaskPlanner._fallback_dag(prompt)
    assert isinstance(dag, TaskDAG)
    assert len(dag.tasks) == 1
    assert dag.tasks[0].id == "task-1"
    assert dag.tasks[0].description == prompt
    assert dag.tasks[0].skill_id is None
    assert dag.tasks[0].depends_on == []
    assert dag.original_prompt == prompt
    assert dag.target_duration_seconds is None
