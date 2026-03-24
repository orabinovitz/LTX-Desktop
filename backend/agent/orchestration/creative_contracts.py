"""Structured creative profiles and coverage contracts for orchestrated work."""

from __future__ import annotations

from enum import Enum
import math
import re

from pydantic import BaseModel, Field


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


class CreativeProfile(str, Enum):
    BRAND_CINEMATIC = "brand_cinematic"
    PERFORMANCE_SOCIAL = "performance_social"
    UGC_NATIVE = "ugc_native"
    DIALOGUE_SCENE = "dialogue_scene"
    MONTAGE = "montage"


class CoverageValidationIssue(str, Enum):
    UNDER_COVERED = "under_covered"
    DIALOGUE_HEAVY = "dialogue_heavy"
    DURATION_MISMATCH = "duration_mismatch"


class ShotPlanMetrics(BaseModel):
    shot_count: int = 0
    total_planned_seconds: int = 0
    average_shot_seconds: float = 0.0
    dialogue_shot_count: int = 0
    dialogue_seconds: int = 0
    dialogue_share: float = 0.0


class CoverageContract(BaseModel):
    profile: CreativeProfile
    target_duration_seconds: float = Field(gt=0)
    min_shot_count: int = Field(ge=1)
    max_average_shot_seconds: float = Field(gt=0)
    max_dialogue_share: float = Field(ge=0, le=1)
    min_meaningful_edit_operations: int = Field(ge=0, default=2)
    requires_structured_review: bool = True
    requires_timeline_review: bool = True
    max_duration_delta_seconds: int = 2


class _ProfileThresholds(BaseModel):
    min_shots_per_30_seconds: int
    max_average_shot_seconds: float
    max_dialogue_share: float
    min_meaningful_edit_operations: int


_PROFILE_THRESHOLDS: dict[CreativeProfile, _ProfileThresholds] = {
    CreativeProfile.BRAND_CINEMATIC: _ProfileThresholds(
        min_shots_per_30_seconds=6,
        max_average_shot_seconds=6.0,
        max_dialogue_share=0.20,
        min_meaningful_edit_operations=2,
    ),
    CreativeProfile.PERFORMANCE_SOCIAL: _ProfileThresholds(
        min_shots_per_30_seconds=10,
        max_average_shot_seconds=4.0,
        max_dialogue_share=0.15,
        min_meaningful_edit_operations=3,
    ),
    CreativeProfile.UGC_NATIVE: _ProfileThresholds(
        min_shots_per_30_seconds=8,
        max_average_shot_seconds=5.0,
        max_dialogue_share=0.45,
        min_meaningful_edit_operations=2,
    ),
    CreativeProfile.DIALOGUE_SCENE: _ProfileThresholds(
        min_shots_per_30_seconds=5,
        max_average_shot_seconds=8.0,
        max_dialogue_share=0.75,
        min_meaningful_edit_operations=2,
    ),
    CreativeProfile.MONTAGE: _ProfileThresholds(
        min_shots_per_30_seconds=9,
        max_average_shot_seconds=4.0,
        max_dialogue_share=0.10,
        min_meaningful_edit_operations=3,
    ),
}


def infer_creative_profile(prompt: str) -> CreativeProfile | None:
    """Infer a creative profile from the user brief."""
    prompt_lower = prompt.lower()

    if any(keyword in prompt_lower for keyword in ("ugc", "tiktok native", "creator style", "selfie", "testimonial")):
        return CreativeProfile.UGC_NATIVE
    if any(keyword in prompt_lower for keyword in ("performance ad", "performance marketing", "cta", "hook", "meta ad", "facebook ad", "instagram ad", "roas")):
        return CreativeProfile.PERFORMANCE_SOCIAL
    if any(keyword in prompt_lower for keyword in ("montage", "promo", "sizzle", "highlight reel", "fan festival")):
        return CreativeProfile.MONTAGE
    if any(keyword in prompt_lower for keyword in ("dialogue scene", "conversation", "arguing", "two people talking", "siblings", "scene")) and not any(
        keyword in prompt_lower for keyword in ("ad", "advertisement", "commercial", "promo")
    ):
        return CreativeProfile.DIALOGUE_SCENE
    if any(keyword in prompt_lower for keyword in ("ad", "advertisement", "commercial", "brand film", "world cup", "campaign")):
        return CreativeProfile.BRAND_CINEMATIC
    return None


def build_coverage_contract(
    profile: CreativeProfile,
    target_duration_seconds: float,
) -> CoverageContract:
    """Build a profile-aware coverage contract for downstream validation."""
    thresholds = _PROFILE_THRESHOLDS[profile]
    min_shot_count = max(
        1,
        math.ceil(thresholds.min_shots_per_30_seconds * (target_duration_seconds / 30)),
    )
    return CoverageContract(
        profile=profile,
        target_duration_seconds=target_duration_seconds,
        min_shot_count=min_shot_count,
        max_average_shot_seconds=thresholds.max_average_shot_seconds,
        max_dialogue_share=thresholds.max_dialogue_share,
        min_meaningful_edit_operations=thresholds.min_meaningful_edit_operations,
    )


def extract_shot_plan_metrics(script_text: str, target_duration_seconds: float) -> ShotPlanMetrics:
    """Extract shot density and dialogue share from a numbered shot list."""
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

    average_shot_seconds = total_planned_seconds / shot_count if shot_count else 0.0
    duration_basis = total_planned_seconds or target_duration_seconds or 1
    dialogue_share = dialogue_seconds / duration_basis

    return ShotPlanMetrics(
        shot_count=shot_count,
        total_planned_seconds=total_planned_seconds,
        average_shot_seconds=average_shot_seconds,
        dialogue_shot_count=dialogue_shot_count,
        dialogue_seconds=dialogue_seconds,
        dialogue_share=dialogue_share,
    )


def validate_shot_plan(script_text: str, contract: CoverageContract) -> list[CoverageValidationIssue]:
    """Validate a shot plan against a creative coverage contract."""
    metrics = extract_shot_plan_metrics(script_text, contract.target_duration_seconds)
    issues: list[CoverageValidationIssue] = []

    if (
        metrics.shot_count < contract.min_shot_count
        or (metrics.average_shot_seconds and metrics.average_shot_seconds > contract.max_average_shot_seconds)
    ):
        issues.append(CoverageValidationIssue.UNDER_COVERED)

    if metrics.dialogue_share > contract.max_dialogue_share:
        issues.append(CoverageValidationIssue.DIALOGUE_HEAVY)

    if metrics.total_planned_seconds == 0:
        issues.append(CoverageValidationIssue.DURATION_MISMATCH)
    elif abs(metrics.total_planned_seconds - contract.target_duration_seconds) > contract.max_duration_delta_seconds:
        issues.append(CoverageValidationIssue.DURATION_MISMATCH)

    return issues


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
