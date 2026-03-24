"""Centralized Gemini model routing policy for agentic workflows."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum

from agent.types import TaskType

PRO_MODEL = "gemini-3.1-pro-preview"
FLASH_LITE_MODEL = "gemini-3.1-flash-lite-preview"
FAST_LITE_MODEL = "gemini-2.5-flash-lite"
LIVE_AUDIO_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

LEGACY_PRO_MODEL = "gemini-3.1-pro-preview"
LEGACY_FLASH_MODEL = "gemini-3-flash-preview"
LEGACY_LIVE_AUDIO_MODEL = LIVE_AUDIO_MODEL

_ROUTING_FLAG_ENV = "LTX_AGENT_MODEL_ROUTING"

EDITING_TOOL_CATEGORIES: frozenset[str] = frozenset({
    "clip_editing",
    "timeline_mgmt",
    "track_mgmt",
    "editing_ops",
    "selection_ui",
    "transitions",
    "subtitles",
    "clip_properties",
    "export",
    "review",
})

EDITING_SKILLS: frozenset[str] = frozenset({
    "general-editor",
    "tv-film-editing",
    "documentary-editing",
})

PRO_SKILLS: frozenset[str] = frozenset({
    "visual-identity",
    "film-tv-screenwriting",
    "directing",
    "cinematography",
})

_FLASH_LITE_SKILLS: frozenset[str] = frozenset({
    "scene-preproduction",
    "nano-banana-prompting",
})

_EDITING_PROMPT_KEYWORDS: tuple[str, ...] = (
    "edit",
    "editing",
    "edits",
    "trim",
    "trims",
    "timeline",
    "subtitle",
    "subtitles",
    "reorder",
    "reorders",
    "ripple",
    "ripples",
)

_EDITING_PROMPT_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(rf"\b{re.escape(keyword)}\b", re.IGNORECASE)
    for keyword in _EDITING_PROMPT_KEYWORDS
)
_EDITING_PROMPT_PHRASES: tuple[str, ...] = (
    "add a transition",
    "add the transition",
    "add transition",
    "add transitions",
    "apply transitions",
    "apply a dissolve",
    "apply the dissolve",
    "tighten pacing",
    "adjust pacing",
    "improve pacing",
    "cut the clip",
    "cut this clip",
    "cut the video",
    "this cut",
    "tighten the cuts",
    "make cuts",
    "apply cuts",
    "add a caption",
    "add captions",
    "split clip",
    "split the clip",
    "split this clip",
    "split at",
    "assemble these clips",
    "assemble the clips",
    "sequence these clips",
    "sequence the clips",
    "arrange these clips",
    "arrange the clips",
    "make a montage from these clips",
    "turn these clips into a montage",
)


class ModelTier(str, Enum):
    PRO = "pro"
    FLASH_LITE = "flash_lite"
    FAST_LITE = "fast_lite"
    LIVE_AUDIO = "live_audio"


class AgentStage(str, Enum):
    SIMPLE_AGENT = "simple_agent"
    SIMPLE_AGENT_REVIEW = "simple_agent_review"
    ORCHESTRATOR_PLANNER = "orchestrator_planner"
    ORCHESTRATOR_SUB_AGENT = "orchestrator_sub_agent"
    INTENT_RESOLVER = "intent_resolver"
    CLARIFICATION = "clarification"
    ASSET_NAMER = "asset_namer"
    PROJECT_BRAIN = "project_brain"
    VIDEO_ANALYZER = "video_analyzer"
    LIVE_AUDIO = "live_audio"


@dataclass(frozen=True)
class ModelSelection:
    stage: AgentStage
    tier: ModelTier
    model: str
    fallback_model: str | None = None
    reason: str = ""


def is_model_routing_enabled() -> bool:
    raw = os.getenv(_ROUTING_FLAG_ENV, "1").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def has_editing_categories(tool_categories: Iterable[str] | None) -> bool:
    if tool_categories is None:
        return False
    return any(category in EDITING_TOOL_CATEGORIES for category in tool_categories)


def prompt_has_editing_signals(prompt: str) -> bool:
    prompt_lower = prompt.lower()
    if any(pattern.search(prompt) for pattern in _EDITING_PROMPT_PATTERNS):
        return True
    return any(phrase in prompt_lower for phrase in _EDITING_PROMPT_PHRASES)


def _legacy_selection(stage: AgentStage) -> ModelSelection:
    if stage == AgentStage.LIVE_AUDIO:
        return ModelSelection(stage=stage, tier=ModelTier.LIVE_AUDIO, model=LEGACY_LIVE_AUDIO_MODEL)
    if stage in {AgentStage.SIMPLE_AGENT, AgentStage.SIMPLE_AGENT_REVIEW}:
        return ModelSelection(
            stage=stage,
            tier=ModelTier.PRO,
            model=LEGACY_PRO_MODEL,
            fallback_model=LEGACY_FLASH_MODEL,
            reason="legacy simple-agent routing",
        )
    return ModelSelection(
        stage=stage,
        tier=ModelTier.FLASH_LITE,
        model=LEGACY_FLASH_MODEL,
        reason="legacy auxiliary-stage routing",
    )


def _pro_selection(stage: AgentStage, reason: str) -> ModelSelection:
    return ModelSelection(
        stage=stage,
        tier=ModelTier.PRO,
        model=PRO_MODEL,
        fallback_model=FLASH_LITE_MODEL,
        reason=reason,
    )


def _flash_lite_selection(stage: AgentStage, reason: str) -> ModelSelection:
    return ModelSelection(
        stage=stage,
        tier=ModelTier.FLASH_LITE,
        model=FLASH_LITE_MODEL,
        reason=reason,
    )


def _fast_lite_selection(stage: AgentStage, reason: str) -> ModelSelection:
    return ModelSelection(
        stage=stage,
        tier=ModelTier.FAST_LITE,
        model=FAST_LITE_MODEL,
        reason=reason,
    )


def select_model(
    stage: AgentStage,
    *,
    prompt: str = "",
    task_type: TaskType | str | None = None,
    tool_categories: Iterable[str] | None = None,
    skill_id: str | None = None,
    preferred_model_tier: str | None = None,
    reasoning_class: str | None = None,
    has_memory_tool_access: bool = False,
    has_destructive_tool_access: bool = False,
    wide_tool_surface: bool = False,
    high_stakes_consistency: bool = False,
    search_grounded: bool = False,
    editing_critical: bool = False,
    turn_depth: int = 0,
) -> ModelSelection:
    """Choose the appropriate Gemini model for a stage.

    The routing policy deliberately keeps editing on Pro. Low-risk JSON-only
    and helper stages are downgraded to the lighter tiers.
    """

    if not is_model_routing_enabled():
        return _legacy_selection(stage)

    if stage == AgentStage.LIVE_AUDIO:
        return ModelSelection(
            stage=stage,
            tier=ModelTier.LIVE_AUDIO,
            model=LIVE_AUDIO_MODEL,
            reason="live audio stage uses the native audio model",
        )

    if stage in {AgentStage.INTENT_RESOLVER, AgentStage.ASSET_NAMER}:
        return _fast_lite_selection(stage, "json-only helper stage")

    if stage in {AgentStage.CLARIFICATION, AgentStage.PROJECT_BRAIN, AgentStage.VIDEO_ANALYZER}:
        return _flash_lite_selection(stage, "bounded non-editing helper stage")

    normalized_task_type = task_type.value if isinstance(task_type, TaskType) else str(task_type or "")
    editing_signal = (
        editing_critical
        or has_editing_categories(tool_categories)
        or skill_id in EDITING_SKILLS
        or (prompt and prompt_has_editing_signals(prompt))
    )
    review_signal = stage == AgentStage.SIMPLE_AGENT_REVIEW or normalized_task_type == TaskType.REVIEW.value
    pro_skill_signal = (
        reasoning_class in {"creative_synthesis", "research_synthesis"}
        or
        skill_id in PRO_SKILLS
        or high_stakes_consistency
        or search_grounded
    )

    if review_signal:
        return _pro_selection(stage, "review stages stay on the smartest model")

    if editing_signal:
        return _pro_selection(stage, "editing stays on the smartest model")

    if has_destructive_tool_access or has_memory_tool_access or wide_tool_surface:
        return _pro_selection(stage, "high-risk tool access requires Pro")

    if pro_skill_signal:
        return _pro_selection(stage, "creative/search/high-stakes task requires Pro")

    if preferred_model_tier == "pro":
        return _pro_selection(stage, "preferred model tier requests Pro")
    if preferred_model_tier in {"flash_lite", "fast_lite"}:
        return (
            _flash_lite_selection(stage, "preferred model tier requests Flash Lite")
            if preferred_model_tier == "flash_lite"
            else _fast_lite_selection(stage, "preferred model tier requests Fast Lite")
        )

    if skill_id in _FLASH_LITE_SKILLS:
        return _flash_lite_selection(stage, "guided non-editing skill")

    if stage in {
        AgentStage.SIMPLE_AGENT,
        AgentStage.ORCHESTRATOR_PLANNER,
        AgentStage.ORCHESTRATOR_SUB_AGENT,
    }:
        return _flash_lite_selection(stage, "default non-editing execution path")

    return _flash_lite_selection(stage, "default routed stage")
