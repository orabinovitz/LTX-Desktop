"""Tests for creative profiles, budgets, and coverage validation."""

from __future__ import annotations

from agent.orchestration.creative_contracts import (
    CoverageValidationIssue,
    CreativeProfile,
    build_coverage_contract,
    infer_creative_profile,
    validate_shot_plan,
)
from tests.fixtures.agentic_workflow_benchmarks import ISLAND_SURVIVOR_SCENE_BRIEF


def test_infer_brand_cinematic_profile_for_world_cup_ad() -> None:
    prompt = "Create a 30-second Pepsi World Cup ad with cinematic storytelling."
    assert infer_creative_profile(prompt) == CreativeProfile.BRAND_CINEMATIC


def test_infer_performance_social_profile() -> None:
    prompt = "Create a 30-second performance marketing ad with a hook, proof, and CTA for Meta."
    assert infer_creative_profile(prompt) == CreativeProfile.PERFORMANCE_SOCIAL


def test_infer_dialogue_scene_profile_for_narrative_scene_prompt() -> None:
    assert infer_creative_profile(ISLAND_SURVIVOR_SCENE_BRIEF) == CreativeProfile.DIALOGUE_SCENE


def test_infer_dialogue_scene_profile_does_not_match_ad_inside_dead() -> None:
    prompt = (
        "Create a tense scene where one survivor tells another in a short conversation "
        "that everyone else is dead after the plane crash."
    )
    assert infer_creative_profile(prompt) == CreativeProfile.DIALOGUE_SCENE


def test_infer_dialogue_scene_profile_ignores_negated_dialogue() -> None:
    prompt = "Create a dialogue-free tropical survival montage with no dialogue and no spoken lines."
    assert infer_creative_profile(prompt) == CreativeProfile.MONTAGE


def test_infer_dialogue_scene_profile_ignores_negated_dialogue_without_other_profile() -> None:
    prompt = "Create a dialogue-free tropical survival scene with no dialogue or spoken lines."
    assert infer_creative_profile(prompt) is None


def test_build_coverage_contract_scales_with_duration() -> None:
    contract = build_coverage_contract(
        profile=CreativeProfile.BRAND_CINEMATIC,
        target_duration_seconds=60,
    )

    assert contract.profile == CreativeProfile.BRAND_CINEMATIC
    assert contract.target_duration_seconds == 60
    assert contract.min_shot_count == 12
    assert contract.requires_structured_review is True


def test_validate_shot_plan_flags_undercoverage_for_sparse_brand_ad() -> None:
    contract = build_coverage_contract(
        profile=CreativeProfile.BRAND_CINEMATIC,
        target_duration_seconds=30,
    )
    script = """
Shot 1 (8s): Stadium tension before the kick.
Shot 2 (6s): Pepsi can cracks open.
Shot 3 (8s): Ball flies into the net.
Shot 4 (8s): Fans celebrate with Pepsi branding.
"""

    issues = validate_shot_plan(script, contract)

    assert CoverageValidationIssue.UNDER_COVERED in issues


def test_validate_shot_plan_accepts_dense_brand_ad() -> None:
    contract = build_coverage_contract(
        profile=CreativeProfile.BRAND_CINEMATIC,
        target_duration_seconds=30,
    )
    script = """
Shot 1 (8s): Faces hold their breath in the tunnel. Editorial Opportunity: trim to the eye flicker.
Shot 2 (6s): Boots jitter against concrete. Editorial Opportunity: use as a percussion insert.
Shot 3 (6s): Cold Pepsi can sweats in a clenched hand. Editorial Opportunity: cut on the drop.
Shot 4 (6s): Eyes lock on the ball. Editorial Opportunity: hold to the inhale.
Shot 5 (8s): The deep breath before release. Editorial Opportunity: split before the plunge.
Shot 6 (6s): A first burst of movement. Editorial Opportunity: cut on impact.
Shot 7 (8s): Confetti and bodies explode into frame. Editorial Opportunity: flash-cut the crowd.
Shot 8 (6s): A boombox speaker vibrates to the bass kick. Editorial Opportunity: punctuate the rhythm.
Shot 9 (8s): The final tag lands over the stadium crowd. Editorial Opportunity: hold the logo resolve.
"""

    issues = validate_shot_plan(script, contract)

    assert issues == []


def test_validate_shot_plan_flags_missing_durations() -> None:
    contract = build_coverage_contract(
        profile=CreativeProfile.BRAND_CINEMATIC,
        target_duration_seconds=30,
    )
    script = """
Shot 1: Tunnel faces freeze in suspense.
Shot 2: A Pepsi can sweats in a clenched hand.
Shot 3: The crowd detonates in celebration.
"""

    issues = validate_shot_plan(script, contract)

    assert CoverageValidationIssue.DURATION_MISMATCH in issues
