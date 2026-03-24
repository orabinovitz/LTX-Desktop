"""Tests for agent.model_policy."""

from __future__ import annotations

import pytest

from agent.model_policy import (
    AgentStage,
    LEGACY_FLASH_MODEL,
    PRO_MODEL,
    FLASH_LITE_MODEL,
    FAST_LITE_MODEL,
    ModelTier,
    select_model,
)
from agent.types import TaskType


def test_intent_resolver_uses_fast_lite() -> None:
    selection = select_model(AgentStage.INTENT_RESOLVER)

    assert selection.tier == ModelTier.FAST_LITE
    assert selection.model == FAST_LITE_MODEL


def test_clarification_uses_flash_lite() -> None:
    selection = select_model(AgentStage.CLARIFICATION)

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_simple_agent_editing_categories_use_pro() -> None:
    selection = select_model(
        AgentStage.SIMPLE_AGENT,
        tool_categories=["clip_editing"],
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL
    assert selection.fallback_model == FLASH_LITE_MODEL


def test_simple_agent_memory_write_access_uses_pro() -> None:
    selection = select_model(
        AgentStage.SIMPLE_AGENT,
        tool_categories=["memory"],
        has_memory_tool_access=True,
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_simple_agent_non_editing_read_only_turn_uses_flash_lite() -> None:
    selection = select_model(
        AgentStage.SIMPLE_AGENT,
        tool_categories=["analysis"],
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_planner_escalates_editing_heavy_prompt_to_pro() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="trim the clips, tighten pacing, and add transitions",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_sub_agent_review_tasks_use_pro() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        task_type=TaskType.REVIEW,
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_sub_agent_non_editing_execution_uses_flash_lite() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        task_type=TaskType.EXECUTION,
        skill_id="scene-preproduction",
        tool_categories=["generation"],
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_sub_agent_high_stakes_consistency_uses_pro() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        task_type=TaskType.EXECUTION,
        skill_id="scene-preproduction",
        tool_categories=["generation"],
        high_stakes_consistency=True,
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_clip_word_alone_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Generate three clips of a sunset",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_turn_depth_alone_does_not_force_pro() -> None:
    selection = select_model(
        AgentStage.SIMPLE_AGENT,
        prompt="analyze the transcript",
        tool_categories=["analysis"],
        turn_depth=5,
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_assemble_montage_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="assemble these clips into a montage",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_sequence_reel_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="sequence these clips into a reel",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_cutaway_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Generate a cutaway shot of the city skyline",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_split_screen_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Generate a split-screen intro for the trailer",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_arrange_generation_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Arrange flowers in a vase and generate an image",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_montage_generation_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Generate a montage of city lights at night",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_sequence_generation_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Create a sequence of still images showing sunrise over the ocean",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_plural_transitions_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="add transitions between these shots",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_cuts_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="tighten the cuts across the montage",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_subtitles_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="add subtitles to the clip",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_edits_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="apply edits across these clips",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_trims_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="make trims across the montage",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_reorders_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="do reorders across these scenes",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_plural_ripples_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="perform ripples after each deletion",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_singular_transition_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="add a transition between these clips",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_dissolve_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="apply a dissolve between these clips",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_article_transition_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="add the transition between these clips",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_article_dissolve_prompt_counts_as_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="apply the dissolve between these clips",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_prime_cuts_noun_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Create a food video about prime cuts of beef",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_transition_noun_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Generate a time-lapse transition from day to night over the skyline.",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_creative_pacing_prompt_does_not_force_editing() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_PLANNER,
        prompt="Write three Instagram captions with playful pacing.",
    )

    assert selection.tier == ModelTier.FLASH_LITE
    assert selection.model == FLASH_LITE_MODEL


def test_preferred_model_tier_pro_routes_to_pro() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        preferred_model_tier="pro",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_reasoning_class_creative_synthesis_routes_to_pro() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        reasoning_class="creative_synthesis",
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_flash_lite_preference_does_not_override_memory_risk() -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        preferred_model_tier="flash_lite",
        has_memory_tool_access=True,
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


@pytest.mark.parametrize(
    ("skill_id", "description"),
    [
        ("visual-identity", "Create a visual identity bible."),
        ("film-tv-screenwriting", "Write the script for the scene."),
        ("directing", "Write directing notes for the actors."),
        ("cinematography", "Create a cinematography style guide."),
    ],
)
def test_explicit_creative_pro_skills_use_pro(skill_id: str, description: str) -> None:
    selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        prompt=description,
        task_type=TaskType.CREATIVE,
        skill_id=skill_id,
    )

    assert selection.tier == ModelTier.PRO
    assert selection.model == PRO_MODEL


def test_routing_flag_can_restore_legacy_behavior(monkeypatch) -> None:
    monkeypatch.setenv("LTX_AGENT_MODEL_ROUTING", "0")

    selection = select_model(AgentStage.INTENT_RESOLVER)

    assert selection.model == LEGACY_FLASH_MODEL
