"""Tests for creative profiles, budgets, and coverage validation."""

from __future__ import annotations

from agent.orchestration.creative_contracts import (
    CoverageValidationIssue,
    CreativeProfile,
    build_coverage_contract,
    infer_creative_profile,
    validate_shot_plan,
)


def test_infer_brand_cinematic_profile_for_world_cup_ad() -> None:
    prompt = "Create a 30-second Pepsi World Cup ad with cinematic storytelling."
    assert infer_creative_profile(prompt) == CreativeProfile.BRAND_CINEMATIC


def test_infer_performance_social_profile() -> None:
    prompt = "Create a 30-second performance marketing ad with a hook, proof, and CTA for Meta."
    assert infer_creative_profile(prompt) == CreativeProfile.PERFORMANCE_SOCIAL


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
Shot 1 (4s): Faces hold their breath in the tunnel.
Shot 2 (4s): Boots jitter against concrete.
Shot 3 (4s): Cold Pepsi can sweats in a clenched hand.
Shot 4 (4s): Eyes lock on the ball.
Shot 5 (5s): The deep breath before release.
Shot 6 (4s): A first burst of movement.
Shot 7 (5s): Confetti and bodies explode into frame.
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
