"""Tests for agentic ad workflow benchmark helpers."""

from __future__ import annotations

from agent.evals.ad_workflow_benchmark import (
    AdWorkflowExecutionMetrics,
    AdWorkflowFailure,
    AdWorkflowProfile,
    BenchmarkCase,
    build_default_benchmark_cases,
    extract_script_plan_metrics,
    score_benchmark_case,
)


def test_default_benchmark_matrix_covers_core_ad_profiles() -> None:
    cases = build_default_benchmark_cases()

    assert len(cases) >= 5
    assert {case.id for case in cases} >= {
        "sports-brand-30",
        "performance-ad-30",
        "ugc-native-30",
        "dialogue-scene-90",
        "montage-promo-30",
    }


def test_extract_script_plan_metrics_counts_shots_duration_and_dialogue() -> None:
    script = """
Shot 1 (8s): A packed stadium plaza at golden hour.
Shot 2 (6s): Extreme close-up of a Pepsi can cracking open.
Shot 3 (8s): A fan lowers the can and says "Here we go."
Shot 4 (8s): The crowd explodes as lights flare and confetti flies.
"""

    metrics = extract_script_plan_metrics(script, target_duration_seconds=30)

    assert metrics.shot_count == 4
    assert metrics.total_planned_seconds == 30
    assert metrics.dialogue_shot_count == 1
    assert round(metrics.dialogue_share, 2) == 0.27


def test_text_overlay_does_not_count_as_dialogue() -> None:
    script = """
Shot 1 (8s): A footballer sprints through a tunnel.
Shot 2 (8s): The crowd erupts. Text overlay: "THIRSTY FOR GREATNESS."
"""

    metrics = extract_script_plan_metrics(script, target_duration_seconds=16)

    assert metrics.dialogue_shot_count == 0
    assert metrics.dialogue_share == 0


def test_brand_cinematic_score_flags_undercoverage_and_no_real_edit() -> None:
    case = BenchmarkCase(
        id="sports-brand-30",
        prompt="Create a 30-second Pepsi World Cup ad",
        profile=AdWorkflowProfile.BRAND_CINEMATIC,
        target_duration_seconds=30,
    )
    script = """
Shot 1 (8s): A packed stadium plaza at golden hour.
Shot 2 (6s): Extreme close-up of a Pepsi can cracking open.
Shot 3 (8s): A fan lowers the can and says "Here we go."
Shot 4 (8s): The crowd explodes as lights flare and confetti flies.
"""
    script_metrics = extract_script_plan_metrics(script, target_duration_seconds=30)
    execution_metrics = AdWorkflowExecutionMetrics(
        generated_shot_count=4,
        final_timeline_clip_count=4,
        final_duration_seconds=30,
        edit_operation_names=["create_timeline", "add_clip_to_timeline"],
    )

    scorecard = score_benchmark_case(case, script_metrics, execution_metrics)

    assert scorecard.passed is False
    assert AdWorkflowFailure.UNDER_COVERED in scorecard.failures
    assert AdWorkflowFailure.NO_REAL_EDIT in scorecard.failures
    assert AdWorkflowFailure.DIALOGUE_HEAVY in scorecard.failures


def test_dense_brand_cut_can_pass_minimum_creative_bar() -> None:
    case = BenchmarkCase(
        id="sports-brand-30",
        prompt="Create a 30-second Pepsi World Cup ad",
        profile=AdWorkflowProfile.BRAND_CINEMATIC,
        target_duration_seconds=30,
    )
    script = """
Shot 1 (4s): Sun-baked faces staring at the stadium screen.
Shot 2 (4s): Boots stamping on metal bleachers.
Shot 3 (4s): A hand crushing a cold Pepsi can.
Shot 4 (4s): Eyes lock forward in silence.
Shot 5 (5s): A deep breath before the whistle.
Shot 6 (4s): The first eruption of movement.
Shot 7 (5s): Confetti, sweat, flags, bodies surging.
"""
    script_metrics = extract_script_plan_metrics(script, target_duration_seconds=30)
    execution_metrics = AdWorkflowExecutionMetrics(
        generated_shot_count=7,
        final_timeline_clip_count=11,
        final_duration_seconds=30,
        edit_operation_names=[
            "create_timeline",
            "add_clip_to_timeline",
            "trim_clip",
            "split_clip",
            "move_clip",
            "set_clip_speed",
        ],
    )

    scorecard = score_benchmark_case(case, script_metrics, execution_metrics)

    assert scorecard.passed is True
    assert scorecard.failures == []
