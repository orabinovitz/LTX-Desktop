"""Benchmark helpers for evaluating agentic ad workflow quality."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
import re


_SHOT_RE = re.compile(
    r"Shot\s+\d+(?:\s*\((?P<duration>\d+)s\))?\s*:\s*(?P<body>.+?)(?=Shot\s+\d+|\Z)",
    re.IGNORECASE | re.DOTALL,
)
_DIALOGUE_RE = re.compile(
    r'["“][^"”]{3,}["”]|\bVO:|\bvoiceover\b|\bdialogue\b|\b[A-Z][A-Z\s]{1,20}:',
    re.IGNORECASE,
)
_TEXT_OVERLAY_RE = re.compile(
    r"\b(?:text overlay|on-screen text)\s*:\s*[\"“][^\"”]+[\"”]",
    re.IGNORECASE,
)
_FALLBACK_DURATION_RE = re.compile(r"(?P<duration>\d+)\s*s(?:ec(?:ond)?s?)?\b", re.IGNORECASE)


class AdWorkflowProfile(str, Enum):
    BRAND_CINEMATIC = "brand_cinematic"
    PERFORMANCE_SOCIAL = "performance_social"
    UGC_NATIVE = "ugc_native"
    DIALOGUE_SCENE = "dialogue_scene"
    MONTAGE = "montage"


class AdWorkflowFailure(str, Enum):
    UNDER_COVERED = "under_covered"
    NO_REAL_EDIT = "no_real_edit"
    DIALOGUE_HEAVY = "dialogue_heavy"
    GENERATION_SHORTFALL = "generation_shortfall"
    DURATION_MISMATCH = "duration_mismatch"


@dataclass(frozen=True)
class BenchmarkCase:
    id: str
    prompt: str
    profile: AdWorkflowProfile
    target_duration_seconds: int


@dataclass(frozen=True)
class ScriptPlanMetrics:
    shot_count: int
    total_planned_seconds: int
    average_shot_seconds: float
    dialogue_shot_count: int
    dialogue_seconds: int
    dialogue_share: float


@dataclass(frozen=True)
class AdWorkflowExecutionMetrics:
    generated_shot_count: int
    final_timeline_clip_count: int
    final_duration_seconds: int
    edit_operation_names: list[str] = field(default_factory=list)

    @property
    def meaningful_edit_operation_count(self) -> int:
        return sum(1 for name in self.edit_operation_names if name in _MEANINGFUL_EDIT_OPERATIONS)

    @property
    def effective_cut_count(self) -> int:
        return max(0, self.final_timeline_clip_count - 1)


@dataclass(frozen=True)
class AdWorkflowScorecard:
    case_id: str
    passed: bool
    failures: list[AdWorkflowFailure]
    notes: list[str]
    script_metrics: ScriptPlanMetrics
    execution_metrics: AdWorkflowExecutionMetrics


@dataclass(frozen=True)
class _ProfileThresholds:
    min_shots_per_30_seconds: int
    max_dialogue_share: float
    min_meaningful_edit_operations: int
    max_duration_delta_seconds: int = 2


_PROFILE_THRESHOLDS: dict[AdWorkflowProfile, _ProfileThresholds] = {
    AdWorkflowProfile.BRAND_CINEMATIC: _ProfileThresholds(
        min_shots_per_30_seconds=6,
        max_dialogue_share=0.2,
        min_meaningful_edit_operations=2,
    ),
    AdWorkflowProfile.PERFORMANCE_SOCIAL: _ProfileThresholds(
        min_shots_per_30_seconds=10,
        max_dialogue_share=0.15,
        min_meaningful_edit_operations=3,
    ),
    AdWorkflowProfile.UGC_NATIVE: _ProfileThresholds(
        min_shots_per_30_seconds=8,
        max_dialogue_share=0.45,
        min_meaningful_edit_operations=2,
    ),
    AdWorkflowProfile.DIALOGUE_SCENE: _ProfileThresholds(
        min_shots_per_30_seconds=5,
        max_dialogue_share=0.75,
        min_meaningful_edit_operations=2,
    ),
    AdWorkflowProfile.MONTAGE: _ProfileThresholds(
        min_shots_per_30_seconds=9,
        max_dialogue_share=0.1,
        min_meaningful_edit_operations=3,
    ),
}

_MEANINGFUL_EDIT_OPERATIONS = {
    "trim_clip",
    "split_clip",
    "delete_clip",
    "move_clip",
    "duplicate_clip",
    "set_clip_speed",
    "flip_clip",
    "reverse_clip",
    "add_dissolve",
}


def build_default_benchmark_cases() -> list[BenchmarkCase]:
    """Return the default benchmark matrix for the ad workflow overhaul."""
    return [
        BenchmarkCase(
            id="sports-brand-30",
            prompt=(
                "Create a 30-second Pepsi World Cup ad for 2026: concept, visual identity, "
                "image and video generation, and a final edited timeline."
            ),
            profile=AdWorkflowProfile.BRAND_CINEMATIC,
            target_duration_seconds=30,
        ),
        BenchmarkCase(
            id="performance-ad-30",
            prompt=(
                "Create a 30-second performance marketing ad for a fitness app with a strong hook, "
                "clear proof, and a CTA."
            ),
            profile=AdWorkflowProfile.PERFORMANCE_SOCIAL,
            target_duration_seconds=30,
        ),
        BenchmarkCase(
            id="ugc-native-30",
            prompt=(
                "Create a 30-second UGC-style skincare ad that feels native to TikTok and uses "
                "caption-driven storytelling."
            ),
            profile=AdWorkflowProfile.UGC_NATIVE,
            target_duration_seconds=30,
        ),
        BenchmarkCase(
            id="dialogue-scene-90",
            prompt=(
                "Create a 90-second cinematic dialogue scene between two siblings arguing after a football match."
            ),
            profile=AdWorkflowProfile.DIALOGUE_SCENE,
            target_duration_seconds=90,
        ),
        BenchmarkCase(
            id="montage-promo-30",
            prompt=(
                "Create a 30-second fast-cut montage promo for a World Cup fan festival with music-driven energy."
            ),
            profile=AdWorkflowProfile.MONTAGE,
            target_duration_seconds=30,
        ),
    ]


def extract_script_plan_metrics(script_text: str, target_duration_seconds: int) -> ScriptPlanMetrics:
    """Extract shot/duration/dialogue metrics from a numbered shot list."""
    shot_count = 0
    total_planned_seconds = 0
    dialogue_shot_count = 0
    dialogue_seconds = 0

    for match in _SHOT_RE.finditer(script_text):
        shot_count += 1
        duration = _parse_duration(match.group("duration"), match.group("body"))
        total_planned_seconds += duration
        if _shot_has_dialogue(match.group("body")):
            dialogue_shot_count += 1
            dialogue_seconds += duration

    if shot_count == 0:
        average_shot_seconds = 0.0
    else:
        average_shot_seconds = total_planned_seconds / shot_count

    duration_basis = total_planned_seconds or target_duration_seconds or 1
    dialogue_share = dialogue_seconds / duration_basis

    return ScriptPlanMetrics(
        shot_count=shot_count,
        total_planned_seconds=total_planned_seconds,
        average_shot_seconds=average_shot_seconds,
        dialogue_shot_count=dialogue_shot_count,
        dialogue_seconds=dialogue_seconds,
        dialogue_share=dialogue_share,
    )


def score_benchmark_case(
    case: BenchmarkCase,
    script_metrics: ScriptPlanMetrics,
    execution_metrics: AdWorkflowExecutionMetrics,
) -> AdWorkflowScorecard:
    """Score a benchmark case against profile-aware creative thresholds."""
    thresholds = _PROFILE_THRESHOLDS[case.profile]
    failures: list[AdWorkflowFailure] = []
    notes: list[str] = []

    min_expected_shots = math.ceil(
        thresholds.min_shots_per_30_seconds * (case.target_duration_seconds / 30),
    )
    if script_metrics.shot_count < min_expected_shots:
        failures.append(AdWorkflowFailure.UNDER_COVERED)
        notes.append(
            f"Planned only {script_metrics.shot_count} shots; expected at least {min_expected_shots} "
            f"for {case.profile.value}.",
        )

    if script_metrics.dialogue_share > thresholds.max_dialogue_share:
        failures.append(AdWorkflowFailure.DIALOGUE_HEAVY)
        notes.append(
            f"Dialogue consumes {script_metrics.dialogue_share:.0%} of planned runtime; "
            f"target is <= {thresholds.max_dialogue_share:.0%}.",
        )

    if execution_metrics.generated_shot_count < script_metrics.shot_count:
        failures.append(AdWorkflowFailure.GENERATION_SHORTFALL)
        notes.append(
            f"Generated only {execution_metrics.generated_shot_count} shots for "
            f"{script_metrics.shot_count} planned shots.",
        )

    if execution_metrics.meaningful_edit_operation_count < thresholds.min_meaningful_edit_operations:
        failures.append(AdWorkflowFailure.NO_REAL_EDIT)
        notes.append(
            "Timeline assembly did not show enough meaningful edit operations beyond placement.",
        )

    if abs(execution_metrics.final_duration_seconds - case.target_duration_seconds) > thresholds.max_duration_delta_seconds:
        failures.append(AdWorkflowFailure.DURATION_MISMATCH)
        notes.append(
            f"Final runtime {execution_metrics.final_duration_seconds}s diverged from target "
            f"{case.target_duration_seconds}s by more than {thresholds.max_duration_delta_seconds}s.",
        )

    return AdWorkflowScorecard(
        case_id=case.id,
        passed=not failures,
        failures=failures,
        notes=notes,
        script_metrics=script_metrics,
        execution_metrics=execution_metrics,
    )


def _parse_duration(raw_duration: str | None, shot_body: str) -> int:
    if raw_duration:
        return int(raw_duration)

    fallback = _FALLBACK_DURATION_RE.search(shot_body)
    if fallback:
        return int(fallback.group("duration"))

    return 0


def _shot_has_dialogue(shot_body: str) -> bool:
    sanitized = _TEXT_OVERLAY_RE.sub("", shot_body)
    return bool(_DIALOGUE_RE.search(sanitized))
