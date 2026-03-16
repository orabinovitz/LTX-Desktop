"""Tests for agent.orchestration.skill_router.SkillRouter."""

from __future__ import annotations

import pytest

from agent.orchestration.skill_router import SkillRouter
from agent.types import SkillDescriptor, TaskNode, TaskStatus, TaskType


def _default_descriptors() -> list[SkillDescriptor]:
    return [
        SkillDescriptor(
            id="marketing-editor",
            name="Marketing Editor",
            description="Edits marketing and brand content",
            tool_categories=[],
            trigger_keywords=["marketing", "brand", "ad", "commercial"],
        ),
        SkillDescriptor(
            id="tv-film-editing",
            name="TV/Film Editing",
            description="Edits video with cuts, pacing, and scene structure",
            tool_categories=[],
            trigger_keywords=["edit", "cut", "trim", "pacing", "scene"],
        ),
        SkillDescriptor(
            id="cinematography",
            name="Cinematography",
            description="Camera, lens, lighting, and framing",
            tool_categories=[],
            trigger_keywords=["camera", "lens", "lighting", "framing"],
        ),
    ]


def test_valid_skill_id_in_descriptors_returns_that_skill_id() -> None:
    """When task.skill_id is set and exists in descriptors, return it."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t1",
        description="Trim the clip and add a transition",
        skill_id="marketing-editor",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    assert router.route(task) == "marketing-editor"


def test_valid_skill_id_task_description_irrelevant() -> None:
    """Exact skill_id match wins; task description is ignored."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t2",
        description="camera lens lighting framing",  # would match cinematography by keywords
        skill_id="tv-film-editing",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    assert router.route(task) == "tv-film-editing"


def test_unknown_skill_id_falls_back_to_keyword_matching() -> None:
    """When skill_id is set but not in descriptors, fall back to keywords."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t3",
        description="Edit the marketing ad for the brand",
        skill_id="nonexistent-skill",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    # marketing-editor: marketing, ad, brand = 3; tv-film-editing: edit = 1
    assert router.route(task) == "marketing-editor"


def test_no_skill_id_uses_keyword_matching() -> None:
    """When skill_id is None, route by keyword overlap."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t4",
        description="Improve the camera angle and lighting",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    # cinematography: camera, lighting = 2
    assert router.route(task) == "cinematography"


def test_keyword_matching_multiple_keywords_one_descriptor_wins() -> None:
    """Multiple keywords matching one descriptor yields that descriptor."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t5",
        description="Cut and trim the scene with better pacing",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    # tv-film-editing: cut, trim, scene, pacing = 4
    assert router.route(task) == "tv-film-editing"


def test_keyword_matching_higher_score_wins() -> None:
    """When two descriptors compete, the one with more keyword matches wins."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t6",
        description="Edit the marketing ad and brand commercial",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    # marketing-editor: marketing, ad, brand, commercial = 4
    # tv-film-editing: edit = 1
    assert router.route(task) == "marketing-editor"


def test_keyword_matching_case_insensitive() -> None:
    """Keyword matching is case-insensitive."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t7",
        description="CAMERA and LIGHTING setup",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    assert router.route(task) == "cinematography"


def test_no_descriptors_returns_none() -> None:
    """When router has no descriptors, route returns None."""
    router = SkillRouter([])
    task = TaskNode(
        id="t8",
        description="Edit the marketing ad",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    assert router.route(task) is None


def test_empty_task_description_no_skill_id_returns_none() -> None:
    """Empty description with no skill_id yields None."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t9",
        description="",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    assert router.route(task) is None


def test_keyword_match_zero_score_returns_none() -> None:
    """When no keywords match, return None."""
    router = SkillRouter(_default_descriptors())
    task = TaskNode(
        id="t10",
        description="Export the video to MP4",
        skill_id=None,
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
    )
    # None of: marketing, brand, ad, commercial, edit, cut, trim, pacing, scene, camera, lens, lighting, framing
    assert router.route(task) is None
