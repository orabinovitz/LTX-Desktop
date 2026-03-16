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


# --- Style keyword alone → stays simple (no production signal) ---


def test_style_keyword_alone_cinematic_is_simple() -> None:
    """A style keyword without a production signal is just a modifier."""
    assert classify_complexity("make it cinematic") == "simple"


def test_style_keyword_alone_documentary_is_simple() -> None:
    assert classify_complexity("documentary style") == "simple"


# --- Style keyword + production signal → orchestrated ---


def test_style_plus_production_create_video_is_orchestrated() -> None:
    assert classify_complexity("create a cinematic video of a sunset") == "orchestrated"


def test_style_plus_production_make_scene_is_orchestrated() -> None:
    assert classify_complexity("make a documentary scene about wildlife") == "orchestrated"


def test_style_plus_production_create_ad_is_orchestrated() -> None:
    assert classify_complexity("create a commercial ad for sneakers") == "orchestrated"


def test_style_plus_production_create_trailer_is_orchestrated() -> None:
    assert classify_complexity("create a trailer for my short film") == "orchestrated"


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


# --- Long prompts (>45 words) → orchestrated ---


def test_long_prompt_no_signals_is_orchestrated() -> None:
    """46+ words with no other signals → orchestrated as fallback."""
    prompt = " ".join(f"word{i}" for i in range(46))
    assert len(prompt.split()) == 46
    assert classify_complexity(prompt) == "orchestrated"


# --- Edge cases ---


def test_empty_string_is_simple() -> None:
    assert classify_complexity("") == "simple"


def test_single_word_is_simple() -> None:
    assert classify_complexity("trim") == "simple"


def test_case_insensitive_style_with_production() -> None:
    assert classify_complexity("CREATE a CINEMATIC video") == "orchestrated"


def test_case_insensitive_simple_stays_simple() -> None:
    assert classify_complexity("TRIM THIS CLIP") == "simple"


# --- Word count boundary ---


def test_exactly_45_words_is_simple() -> None:
    prompt = " ".join(f"word{i}" for i in range(45))
    assert len(prompt.split()) == 45
    assert classify_complexity(prompt) == "simple"


def test_46_words_is_orchestrated() -> None:
    prompt = " ".join(f"word{i}" for i in range(46))
    assert len(prompt.split()) == 46
    assert classify_complexity(prompt) == "orchestrated"


# --- Regression: single-action requests that were previously over-classified ---


def test_write_a_script_is_simple() -> None:
    """A request for just a script should not trigger full orchestration."""
    assert classify_complexity("write me a script") == "simple"


def test_generate_image_descriptive_is_simple() -> None:
    """A descriptive single-image request should stay simple even with many words."""
    prompt = "generate an image of a golden sunset over the ocean with warm tones"
    assert classify_complexity(prompt) == "simple"


def test_cinematic_script_only_is_simple() -> None:
    """Style keyword on a non-production request stays simple."""
    assert classify_complexity("write a cinematic noir script") == "simple"


def test_edit_pacing_is_simple() -> None:
    assert classify_complexity("adjust the pacing of the timeline") == "simple"


def test_generate_single_shot_is_simple() -> None:
    assert classify_complexity("generate a video of a cat playing") == "simple"


def test_moderate_length_single_action_is_simple() -> None:
    """30-word single-domain request stays simple under the raised threshold."""
    prompt = (
        "generate an extremely beautiful and detailed image of a mountain "
        "landscape at sunrise with fog rolling through the valley and birds "
        "flying in the golden morning light over the trees"
    )
    assert len(prompt.split()) > 25
    assert len(prompt.split()) <= 45
    assert classify_complexity(prompt) == "simple"


# --- Creative planning tasks → orchestrated ---


def test_create_visual_identity_is_orchestrated() -> None:
    """Visual identity requests need the orchestrator's skill routing."""
    assert classify_complexity("create the visual identity") == "orchestrated"


def test_visual_identity_guide_is_orchestrated() -> None:
    assert classify_complexity("now please create a visual identity guide") == "orchestrated"


def test_identity_bible_is_orchestrated() -> None:
    assert classify_complexity("write an identity bible for this project") == "orchestrated"


def test_style_guide_is_orchestrated() -> None:
    assert classify_complexity("create a style guide") == "orchestrated"


def test_storyboard_is_orchestrated() -> None:
    assert classify_complexity("create a storyboard for this scene") == "orchestrated"


def test_shot_list_is_orchestrated() -> None:
    assert classify_complexity("create a shot list") == "orchestrated"


def test_look_development_is_orchestrated() -> None:
    assert classify_complexity("do look development for this project") == "orchestrated"


def test_pre_production_is_orchestrated() -> None:
    assert classify_complexity("start pre-production") == "orchestrated"


def test_moodboard_is_orchestrated() -> None:
    assert classify_complexity("create a moodboard for the scene") == "orchestrated"


def test_character_sheet_is_orchestrated() -> None:
    assert classify_complexity("create a character sheet for the detective") == "orchestrated"
