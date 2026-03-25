"""Tests for prompt guidance in the main Gemini agent system prompt."""

from __future__ import annotations

from agent.gemini_agent import GENERAL_CONTEXT_PROMPT


def test_general_context_prompt_separates_still_frames_from_video_motion() -> None:
    assert "For image generation, describe a single still frame" in GENERAL_CONTEXT_PROMPT
    assert "Reserve dialogue, temporal action, and motion for video prompts" in GENERAL_CONTEXT_PROMPT


def test_general_context_prompt_includes_image_guardrails() -> None:
    assert "Do not write aspect ratios or frame dimensions inside the prompt text" in GENERAL_CONTEXT_PROMPT
    assert "For cinematic image prompts, use cinema camera bodies instead of still photography cameras" in GENERAL_CONTEXT_PROMPT
    assert "no on-screen text, no letterbox, no film scratches, no stock overlays" in GENERAL_CONTEXT_PROMPT
