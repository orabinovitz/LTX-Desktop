"""Tests for agent.orchestration.complexity_router."""

from __future__ import annotations

from agent.orchestration.complexity_router import classify_complexity


# --- Simple short prompts ---


def test_trim_clip_is_simple() -> None:
    assert classify_complexity("trim this clip") == "simple"


def test_generate_video_is_simple() -> None:
    assert classify_complexity("generate a video") == "simple"


# --- Multi-step signals → orchestrated ---


def test_first_then_is_orchestrated() -> None:
    assert classify_complexity("first generate a video then edit it") == "orchestrated"


def test_after_that_is_orchestrated() -> None:
    assert classify_complexity("trim the clip after that add a transition") == "orchestrated"


def test_next_is_orchestrated() -> None:
    assert classify_complexity("generate a video next export it") == "orchestrated"


def test_finally_is_orchestrated() -> None:
    assert classify_complexity("trim the clip add music finally render") == "orchestrated"


def test_step_number_is_orchestrated() -> None:
    assert classify_complexity("step 1 generate video step 2 edit") == "orchestrated"


def test_followed_by_is_orchestrated() -> None:
    assert classify_complexity("generate a video followed by a dissolve") == "orchestrated"


def test_once_done_is_orchestrated() -> None:
    assert classify_complexity("trim the clip once done export to fcpxml") == "orchestrated"


def test_and_then_is_orchestrated() -> None:
    assert classify_complexity("generate a video and then edit it") == "orchestrated"


# --- Style keywords → orchestrated ---


def test_style_keyword_cinematic_is_orchestrated() -> None:
    assert classify_complexity("make it cinematic") == "orchestrated"


def test_style_keyword_documentary_is_orchestrated() -> None:
    assert classify_complexity("documentary style video") == "orchestrated"


# --- Multi-domain → orchestrated ---


def test_generation_plus_editing_is_orchestrated() -> None:
    assert classify_complexity("generate a video and edit the trim") == "orchestrated"


def test_generation_plus_analysis_is_orchestrated() -> None:
    assert classify_complexity("generate a video and analyze the transcript") == "orchestrated"


# --- Single domain stays simple ---


def test_single_domain_editing_stays_simple() -> None:
    assert classify_complexity("trim this clip") == "simple"


def test_single_domain_generation_stays_simple() -> None:
    assert classify_complexity("create video from image") == "simple"


# --- Long prompts (>25 words) → orchestrated ---


def test_long_prompt_no_signals_is_orchestrated() -> None:
    """26+ words with no multi-step, style, or multi-domain signals → orchestrated."""
    prompt = " ".join(f"word{i}" for i in range(26))
    assert len(prompt.split()) == 26
    assert classify_complexity(prompt) == "orchestrated"


# --- Edge cases ---


def test_empty_string_is_simple() -> None:
    assert classify_complexity("") == "simple"


def test_single_word_is_simple() -> None:
    assert classify_complexity("trim") == "simple"


def test_case_insensitive_style_keyword() -> None:
    assert classify_complexity("CINEMATIC video") == "orchestrated"


def test_case_insensitive_simple_stays_simple() -> None:
    assert classify_complexity("TRIM THIS CLIP") == "simple"


# --- Word count boundary ---


def test_exactly_25_words_is_simple() -> None:
    prompt = " ".join(f"word{i}" for i in range(25))
    assert len(prompt.split()) == 25
    assert classify_complexity(prompt) == "simple"


def test_26_words_is_orchestrated() -> None:
    prompt = " ".join(f"word{i}" for i in range(26))
    assert len(prompt.split()) == 26
    assert classify_complexity(prompt) == "orchestrated"
