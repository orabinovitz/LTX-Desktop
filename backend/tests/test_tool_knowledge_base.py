"""Tests for the tool knowledge base and intent classification system."""

from __future__ import annotations

import pytest

from agent.tool_knowledge_base import (
    ALLOWED_CATEGORIES_BY_VIEW,
    CATEGORIES,
    classify_intent,
    filter_categories_for_view,
    get_tools_for_categories,
    get_tools_for_categories_and_view,
    get_tools_for_prompt,
    build_category_catalog,
    build_workflow_recipes,
)
from agent.tool_registry import ALL_TOOLS, TOOLS_BY_NAME


class TestToolRegistryCompleteness:
    """Every tool in the registry must belong to exactly one category."""

    def test_all_tools_have_categories(self) -> None:
        all_category_tools: set[str] = set()
        for cat in CATEGORIES.values():
            all_category_tools.update(cat.tool_names)
        for tool in ALL_TOOLS:
            assert tool.name in all_category_tools, (
                f"Tool '{tool.name}' is not in any category"
            )

    def test_all_category_tool_names_exist_in_registry(self) -> None:
        for cat_name, cat in CATEGORIES.items():
            for tool_name in cat.tool_names:
                assert tool_name in TOOLS_BY_NAME, (
                    f"Category '{cat_name}' references non-existent tool '{tool_name}'"
                )

    def test_no_duplicate_tool_names(self) -> None:
        names = [tool.name for tool in ALL_TOOLS]
        assert len(names) == len(set(names)), "Duplicate tool names found"

    def test_every_category_has_tools(self) -> None:
        for cat_name, cat in CATEGORIES.items():
            assert len(cat.tool_names) > 0, f"Category '{cat_name}' has no tools"

    def test_tool_category_field_matches_registry(self) -> None:
        for tool in ALL_TOOLS:
            found = False
            for cat in CATEGORIES.values():
                if tool.name in cat.tool_names:
                    assert tool.category == cat.name, (
                        f"Tool '{tool.name}' has category='{tool.category}' "
                        f"but is listed in category '{cat.name}'"
                    )
                    found = True
                    break
            assert found, f"Tool '{tool.name}' not found in any category"

    def test_all_parameters_have_valid_types(self) -> None:
        valid_types = {"string", "number", "integer", "boolean", "array", "object"}
        for tool in ALL_TOOLS:
            for param in tool.parameters:
                assert param.type in valid_types, (
                    f"Tool '{tool.name}' param '{param.name}' has invalid type '{param.type}'"
                )

    def test_total_tool_count(self) -> None:
        assert len(ALL_TOOLS) == 64, f"Expected 64 tools, got {len(ALL_TOOLS)}"


class TestIntentClassification:
    """The intent classifier must route prompts to the right categories."""

    def test_core_always_included(self) -> None:
        cats = classify_intent("anything at all")
        assert "core" in cats

    def test_trim_routes_to_clip_editing(self) -> None:
        cats = classify_intent("trim clip X by 2 seconds")
        assert "clip_editing" in cats
        assert "core" in cats
        assert "generation" not in cats

    def test_generate_video_routes_to_generation(self) -> None:
        cats = classify_intent("generate a video of a cat")
        assert "generation" in cats
        assert "asset_mgmt" in cats  # dependency

    def test_generate_image_routes_to_generation(self) -> None:
        cats = classify_intent("create an image of a sunset")
        assert "generation" in cats

    def test_subtitle_routes_correctly(self) -> None:
        cats = classify_intent("add subtitles to the video")
        assert "subtitles" in cats

    def test_export_routes_correctly(self) -> None:
        cats = classify_intent("export the timeline")
        assert "export" in cats

    def test_track_mute_routes_correctly(self) -> None:
        cats = classify_intent("mute track 2")
        assert "track_mgmt" in cats

    def test_play_routes_to_playback(self) -> None:
        cats = classify_intent("play the video")
        assert "playback" in cats

    def test_analyze_routes_to_analysis(self) -> None:
        cats = classify_intent("analyze this video")
        assert "analysis" in cats

    def test_undo_routes_to_timeline_mgmt(self) -> None:
        cats = classify_intent("undo the last action")
        assert "timeline_mgmt" in cats

    def test_dissolve_routes_to_transitions(self) -> None:
        cats = classify_intent("add a dissolve between these clips")
        assert "transitions" in cats

    def test_volume_routes_to_clip_properties(self) -> None:
        cats = classify_intent("set the volume to 50%")
        assert "clip_properties" in cats

    def test_select_routes_to_selection_ui(self) -> None:
        cats = classify_intent("select all clips")
        assert "selection_ui" in cats

    def test_multi_category_request(self) -> None:
        cats = classify_intent(
            "generate an image and animate it, then add to timeline with a dissolve"
        )
        assert "generation" in cats
        assert "transitions" in cats

    def test_ambiguous_falls_back_to_all(self) -> None:
        cats = classify_intent("hello")
        # Should include all categories (fallback)
        assert len(cats) == len(CATEGORIES)

    def test_empty_prompt_falls_back(self) -> None:
        cats = classify_intent("")
        assert len(cats) == len(CATEGORIES)

    def test_dependency_resolution(self) -> None:
        cats = classify_intent("generate a video")
        assert "generation" in cats
        assert "asset_mgmt" in cats  # auto-included dependency

    def test_retake_routes_to_generation(self) -> None:
        cats = classify_intent("retake the last 3 seconds")
        assert "generation" in cats

    def test_import_routes_to_asset_mgmt(self) -> None:
        cats = classify_intent("import a video file")
        assert "asset_mgmt" in cats

    def test_snap_routes_to_selection_ui(self) -> None:
        cats = classify_intent("toggle snap on")
        assert "selection_ui" in cats

    def test_blade_routes_to_selection_ui(self) -> None:
        cats = classify_intent("switch to blade tool")
        assert "selection_ui" in cats

    def test_srt_routes_to_subtitles(self) -> None:
        cats = classify_intent("import an SRT file")
        assert "subtitles" in cats

    def test_fcp_xml_routes_to_export(self) -> None:
        cats = classify_intent("export as Final Cut XML")
        assert "export" in cats

    def test_brightness_routes_to_clip_properties(self) -> None:
        cats = classify_intent("increase the brightness of this clip")
        assert "clip_properties" in cats

    def test_lock_track_routes_correctly(self) -> None:
        cats = classify_intent("lock track 1")
        assert "track_mgmt" in cats

    def test_duplicate_routes_to_clip_editing(self) -> None:
        cats = classify_intent("duplicate this clip")
        assert "clip_editing" in cats

    def test_speed_routes_to_clip_editing(self) -> None:
        cats = classify_intent("make the clip faster")
        assert "clip_editing" in cats

    def test_reverse_routes_to_clip_editing(self) -> None:
        cats = classify_intent("reverse this clip")
        assert "clip_editing" in cats

    def test_complex_multi_step(self) -> None:
        cats = classify_intent(
            "generate an image of a dog, animate it jumping through a hoop, "
            "add it to the timeline, then add subtitles"
        )
        assert "generation" in cats
        assert "subtitles" in cats

    def test_search_content_routes_to_analysis(self) -> None:
        cats = classify_intent("find clips about the product demo")
        assert "analysis" in cats

    def test_transcript_routes_to_analysis(self) -> None:
        cats = classify_intent("what does the speaker say at 30 seconds?")
        # "say" doesn't match but other words might not either
        # This tests edge case - should fallback
        cats2 = classify_intent("get the transcript from 10s to 30s")
        assert "analysis" in cats2


class TestToolSelection:
    """get_tools_for_categories returns the right tools."""

    def test_core_only(self) -> None:
        tools = get_tools_for_categories(["core"])
        names = {t.name for t in tools}
        assert "get_timeline_state" in names
        assert "get_project_assets" in names
        assert "switch_view" in names
        assert len(names) == 3

    def test_clip_editing_includes_core_separately(self) -> None:
        tools = get_tools_for_categories(["core", "clip_editing"])
        names = {t.name for t in tools}
        assert "get_timeline_state" in names
        assert "trim_clip" in names
        assert "generate_video" not in names

    def test_generation_tools(self) -> None:
        tools = get_tools_for_categories(["generation"])
        names = {t.name for t in tools}
        assert "generate_video" in names
        assert "generate_image" in names
        assert "retake_section" in names

    def test_no_duplicates(self) -> None:
        tools = get_tools_for_categories(list(CATEGORIES.keys()))
        names = [t.name for t in tools]
        assert len(names) == len(set(names))

    def test_prompt_based_selection(self) -> None:
        tools = get_tools_for_prompt("trim clip X")
        names = {t.name for t in tools}
        assert "trim_clip" in names
        assert "get_timeline_state" in names
        assert len(tools) < 60  # Should be a subset

    def test_prompt_returns_fewer_tools_than_all(self) -> None:
        tools = get_tools_for_prompt("trim this clip")
        assert len(tools) < len(ALL_TOOLS)

    def test_ambiguous_prompt_returns_all_tools(self) -> None:
        tools = get_tools_for_prompt("hello")
        assert len(tools) == len(ALL_TOOLS)


class TestSystemPromptHelpers:
    """build_category_catalog and build_workflow_recipes produce valid output."""

    def test_catalog_includes_category_names(self) -> None:
        catalog = build_category_catalog(["core", "generation"])
        assert "Core" in catalog
        assert "Content Generation" in catalog

    def test_catalog_includes_tool_names(self) -> None:
        catalog = build_category_catalog(["generation"])
        assert "generate_video" in catalog
        assert "generate_image" in catalog

    def test_recipes_for_generation(self) -> None:
        recipes = build_workflow_recipes(["generation"])
        assert "image_then_animate" in recipes
        assert "generate_and_place" in recipes

    def test_recipes_empty_for_core(self) -> None:
        recipes = build_workflow_recipes(["core"])
        assert recipes == ""

    def test_unknown_category_handled(self) -> None:
        catalog = build_category_catalog(["nonexistent"])
        assert "## Available Tool Categories" in catalog

    def test_review_category_in_catalog(self) -> None:
        catalog = build_category_catalog(["review"])
        assert "Edit Quality Review" in catalog
        assert "review_edit_quality" in catalog

    def test_recipes_for_review(self) -> None:
        recipes = build_workflow_recipes(["review"])
        assert "iterative_edit" in recipes


class TestNewToolsIntegration:
    """Tests for the 3 new tools: get_full_transcript, review_edit_quality, review_edit_structure."""

    def test_get_full_transcript_exists(self) -> None:
        assert "get_full_transcript" in TOOLS_BY_NAME
        tool = TOOLS_BY_NAME["get_full_transcript"]
        assert tool.category == "analysis"
        assert tool.execution_target.value == "backend"

    def test_review_edit_quality_exists(self) -> None:
        assert "review_edit_quality" in TOOLS_BY_NAME
        tool = TOOLS_BY_NAME["review_edit_quality"]
        assert tool.category == "review"
        assert tool.execution_target.value == "backend"

    def test_review_edit_structure_exists(self) -> None:
        assert "review_edit_structure" in TOOLS_BY_NAME
        tool = TOOLS_BY_NAME["review_edit_structure"]
        assert tool.category == "review"
        assert tool.execution_target.value == "backend"

    def test_review_category_exists(self) -> None:
        assert "review" in CATEGORIES
        cat = CATEGORIES["review"]
        assert "review_edit_quality" in cat.tool_names
        assert "review_edit_structure" in cat.tool_names

    def test_review_category_depends_on_clip_editing_and_analysis(self) -> None:
        cat = CATEGORIES["review"]
        assert "clip_editing" in cat.depends_on
        assert "analysis" in cat.depends_on

    def test_review_intent_classification(self) -> None:
        cats = classify_intent("review the quality of my edit")
        assert "review" in cats

    def test_review_intent_includes_dependencies(self) -> None:
        cats = classify_intent("review the edit quality")
        assert "review" in cats
        assert "clip_editing" in cats
        assert "analysis" in cats

    def test_full_transcript_intent_classification(self) -> None:
        cats = classify_intent("get the full transcript")
        assert "analysis" in cats

    def test_iterate_intent_classification(self) -> None:
        cats = classify_intent("improve the edit and iterate on quality")
        assert "review" in cats

    def test_feedback_intent_classification(self) -> None:
        cats = classify_intent("give me feedback on this edit")
        assert "review" in cats

    def test_polish_intent_classification(self) -> None:
        cats = classify_intent("polish this edit")
        assert "review" in cats

    def test_complex_long_form_edit_request(self) -> None:
        cats = classify_intent(
            "make a 45 second edit about audio improvements from this video "
            "and review the quality"
        )
        assert "review" in cats
        assert "analysis" in cats
        assert "core" in cats

    def test_review_tools_in_selection(self) -> None:
        tools = get_tools_for_categories(["review"])
        names = {t.name for t in tools}
        assert "review_edit_quality" in names
        assert "review_edit_structure" in names

    def test_analysis_includes_get_full_transcript(self) -> None:
        tools = get_tools_for_categories(["analysis"])
        names = {t.name for t in tools}
        assert "get_full_transcript" in names
        assert "get_video_metadata" in names

    def test_get_full_transcript_handler_exists(self) -> None:
        from agent.gemini_agent import _handle_get_full_transcript
        assert callable(_handle_get_full_transcript)

    def test_review_edit_quality_handler_exists(self) -> None:
        from agent.gemini_agent import _handle_review_edit_quality
        assert callable(_handle_review_edit_quality)

    def test_review_edit_structure_handler_exists(self) -> None:
        from agent.gemini_agent import _handle_review_edit_structure
        assert callable(_handle_review_edit_structure)

    def test_sentence_builder(self) -> None:
        from agent.gemini_agent import _build_sentences
        from agent.types import DialogueLine

        lines = [
            DialogueLine(start_time=0.0, end_time=2.0, text="Hello there everyone."),
            DialogueLine(start_time=2.5, end_time=5.0, text="This is a test of the system."),
            DialogueLine(start_time=5.5, end_time=8.0, text="It should merge lines"),
            DialogueLine(start_time=8.2, end_time=10.0, text="that are close together."),
            DialogueLine(start_time=15.0, end_time=18.0, text="But not across big gaps."),
        ]
        sentences = _build_sentences(lines)
        assert len(sentences) >= 3
        assert sentences[0]["text"] == "Hello there everyone."
        assert sentences[1]["text"] == "This is a test of the system."
        assert "merge lines" in sentences[2]["text"]

    def test_get_full_transcript_handler_missing_asset(self) -> None:
        from agent.gemini_agent import _handle_get_full_transcript
        from agent.types import ToolCall

        tc = ToolCall(tool_name="get_full_transcript", arguments={"asset_id": "nonexistent"})
        result = _handle_get_full_transcript(tc)
        assert not result.success
        assert "not have been analyzed" in (result.error or "")

    def test_get_full_transcript_handler_missing_arg(self) -> None:
        from agent.gemini_agent import _handle_get_full_transcript
        from agent.types import ToolCall

        tc = ToolCall(tool_name="get_full_transcript", arguments={})
        result = _handle_get_full_transcript(tc)
        assert not result.success
        assert "asset_id" in (result.error or "")

    def test_review_edit_quality_handler_missing_transcript(self) -> None:
        from agent.gemini_agent import _handle_review_edit_quality
        from agent.types import ToolCall

        tc = ToolCall(tool_name="review_edit_quality", arguments={"topic": "test"})
        result = _handle_review_edit_quality(tc, api_key="", http_client=None)
        assert not result.success
        assert "edit_transcript" in (result.error or "")

    def test_review_edit_structure_handler_missing_transcript(self) -> None:
        from agent.gemini_agent import _handle_review_edit_structure
        from agent.types import ToolCall

        tc = ToolCall(tool_name="review_edit_structure", arguments={"topic": "test"})
        result = _handle_review_edit_structure(tc, api_key="", http_client=None)
        assert not result.success
        assert "edit_transcript" in (result.error or "")


class TestViewContextFiltering:
    """View-based tool filtering restricts tools per view."""

    def test_editor_allows_all_categories(self) -> None:
        all_cats = sorted(CATEGORIES.keys())
        filtered = filter_categories_for_view(all_cats, "editor")
        assert filtered == all_cats

    def test_genspace_allows_only_allowed_categories(self) -> None:
        all_cats = sorted(CATEGORIES.keys())
        filtered = filter_categories_for_view(all_cats, "genspace")
        assert set(filtered) == {
            "core", "generation", "asset_mgmt", "analysis",
            "clip_editing", "timeline_mgmt", "track_mgmt",
        }
        assert "playback" not in filtered
        assert "subtitles" not in filtered
        assert "export" not in filtered

    def test_playground_allows_only_generation(self) -> None:
        all_cats = sorted(CATEGORIES.keys())
        filtered = filter_categories_for_view(all_cats, "playground")
        assert filtered == ["generation"]

    def test_genspace_excludes_get_timeline_state(self) -> None:
        tools = get_tools_for_categories_and_view(["core"], "genspace")
        names = {t.name for t in tools}
        assert "get_project_assets" in names
        assert "get_timeline_state" not in names

    def test_playground_excludes_both_core_tools(self) -> None:
        tools = get_tools_for_categories_and_view(["core", "generation"], "playground")
        names = {t.name for t in tools}
        assert "get_timeline_state" not in names
        assert "get_project_assets" not in names
        assert "generate_video" in names
        assert "generate_image" in names

    def test_editor_includes_all_tools(self) -> None:
        tools = get_tools_for_categories_and_view(["core"], "editor")
        names = {t.name for t in tools}
        assert "get_timeline_state" in names
        assert "get_project_assets" in names

    def test_genspace_generation_tools_available(self) -> None:
        tools = get_tools_for_categories_and_view(
            ["core", "generation", "asset_mgmt"], "genspace"
        )
        names = {t.name for t in tools}
        assert "generate_video" in names
        assert "generate_image" in names
        assert "delete_asset" in names
        assert "get_project_assets" in names

    def test_unknown_view_defaults_to_editor(self) -> None:
        all_cats = sorted(CATEGORIES.keys())
        filtered = filter_categories_for_view(all_cats, "unknown_view")
        assert filtered == all_cats

    def test_allowed_categories_cover_all_views(self) -> None:
        assert "editor" in ALLOWED_CATEGORIES_BY_VIEW
        assert "genspace" in ALLOWED_CATEGORIES_BY_VIEW
        assert "playground" in ALLOWED_CATEGORIES_BY_VIEW
