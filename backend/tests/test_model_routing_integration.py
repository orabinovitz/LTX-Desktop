"""Integration-style tests for model routing across Gemini call sites."""

from __future__ import annotations

import json

import pytest

from agent.brain import _call_gemini_for_topics
from agent import gemini_agent
from agent.asset_namer import suggest_asset_meta
from agent.clarification_generator import generate_questions
from agent.intent_resolver import resolve_intent
from agent.orchestration.sub_agent_pool import execute_sub_agent
from agent.orchestration.task_planner import TaskPlanner
from agent.types import (
    AgentExecuteRequest,
    AgentMessage,
    ClarifyRequest,
    SkillContent,
    SkillDescriptor,
    SubAgentContext,
    TaskNode,
    TaskStatus,
    TaskType,
    TimelineState,
    ToolCall,
    ViewContext,
)
from agent.video_analyzer import _gemini_generate
from tests.fakes.services import FakeHTTPClient, FakeResponse


@pytest.fixture(autouse=True)
def _clear_agent_sessions():
    gemini_agent._sessions.clear()
    yield
    gemini_agent._sessions.clear()


def _json_response(payload: dict) -> FakeResponse:
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}],
        },
    )


def _text_response(text: str = "") -> FakeResponse:
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{"content": {"parts": [{"text": text}]}}],
        },
    )


def test_intent_resolver_uses_routed_model() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({
        "grounded_prompt": "Analyze the transcript",
        "complexity": "simple",
        "relevant_memory_ids": [],
        "intent_summary": "Analyze the transcript",
        "requires_generation": False,
    }))

    resolve_intent(
        prompt="analyze the transcript",
        project_id=None,
        conversation_history=[AgentMessage(role="user", content="analyze the transcript")],
        view_context=ViewContext.EDITOR,
        assets_context=None,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-2.5-flash-lite:generateContent")


def test_clarification_generator_uses_routed_model() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({"needs_clarification": False, "questions": []}))

    generate_questions(
        ClarifyRequest(prompt="Create a video", timeline_state=TimelineState()),
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_asset_namer_uses_routed_model() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({"name": "Sunset Beach", "tags": ["sunset", "beach"]}))

    result = suggest_asset_meta(
        prompt="golden sunset over the ocean",
        asset_type="image",
        existing_tags=[],
        gemini_api_key="test-key",
        http_client=http,
    )

    assert result is not None
    assert http.calls[0].url.endswith("/gemini-2.5-flash-lite:generateContent")


def test_task_planner_uses_flash_lite_for_non_editing_prompt() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({
        "tasks": [
            {
                "id": "task-1",
                "description": "Generate an image",
                "task_type": "execution",
                "depends_on": [],
                "tool_categories": ["generation"],
                "context_requirements": [],
            },
        ],
        "target_duration_seconds": 0,
    }))

    planner = TaskPlanner(api_key="test-key", http_client=http)
    planner.decompose(
        "generate an image of a sunset",
        available_skills=[],
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_task_planner_uses_pro_for_editing_prompt() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({
        "tasks": [
            {
                "id": "task-1",
                "description": "Trim the clip",
                "task_type": "execution",
                "depends_on": [],
                "tool_categories": ["clip_editing"],
                "context_requirements": [],
            },
        ],
        "target_duration_seconds": 0,
    }))

    planner = TaskPlanner(api_key="test-key", http_client=http)
    planner.decompose(
        "trim the clip and tighten pacing",
        available_skills=[],
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_uses_flash_lite_for_non_editing_execution() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the requested asset."))

    task = TaskNode(
        id="task-1",
        description="Generate an image of a sunset.",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_sub_agent_uses_pro_for_editing_execution() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Trimmed the clip."))

    task = TaskNode(
        id="task-1",
        description="Trim the clip to five seconds.",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["clip_editing"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_review_call_site_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("The review passed."))

    task = TaskNode(
        id="task-1",
        description="Review the generated output against the brief.",
        status=TaskStatus.PENDING,
        task_type=TaskType.REVIEW,
        tool_categories=["review"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_uses_flash_lite_for_non_editing_prompt() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here are the transcript highlights."))

    request = AgentExecuteRequest(
        prompt="analyze the transcript",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_uses_pro_for_editing_prompt() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("I trimmed the clip."))

    request = AgentExecuteRequest(
        prompt="trim the clip to five seconds",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_speed_change_prompt_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Sped up the clip."))

    request = AgentExecuteRequest(
        prompt="speed up this clip",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_mute_track_prompt_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Muted track 2."))

    request = AgentExecuteRequest(
        prompt="mute track 2",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_benign_memory_wording_stays_flash_lite() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here is a nostalgic image prompt."))

    request = AgentExecuteRequest(
        prompt="Make this feel nostalgic, like a memory",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_generic_prompt_stays_flash_lite_even_with_intent_fallback() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here is your haiku."))

    request = AgentExecuteRequest(
        prompt="write a haiku about rain",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_generic_prompt_exposes_trimmed_tool_surface() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here is your haiku."))

    request = AgentExecuteRequest(
        prompt="write a haiku about rain",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    payload = http.calls[0].json_payload
    assert payload is not None
    tool_count = len(payload["tools"][0]["functionDeclarations"])
    assert tool_count < 10


def test_simple_agent_non_asset_organize_prompt_stays_flash_lite() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here is a short outline."))

    request = AgentExecuteRequest(
        prompt="organize these ideas into a short outline",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_non_destructive_asset_management_stays_flash_lite() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Organized the assets into bins."))

    request = AgentExecuteRequest(
        prompt="organize the assets into bins",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_caption_copy_prompt_stays_flash_lite() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here are three captions."))

    request = AgentExecuteRequest(
        prompt="Write three Instagram captions for this launch video.",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_caption_edit_prompt_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Added the caption."))

    request = AgentExecuteRequest(
        prompt="add a caption to this clip",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_respects_search_grounded_pro_skill() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        _text_response("Produced a visual identity bible."),
        _text_response("Saved the research to project memory."),
    )

    skill_content = SkillContent(
        descriptor=SkillDescriptor(
            id="visual-identity",
            name="Visual Identity",
            description="Research and create a visual identity bible.",
            tool_categories=[],
            trigger_keywords=["visual identity"],
        ),
        system_prompt="Research references and produce a bible.",
        enable_search=True,
    )
    task = TaskNode(
        id="task-1",
        description="Research the visual identity.",
        skill_id="visual-identity",
        status=TaskStatus.PENDING,
        task_type=TaskType.CREATIVE,
        tool_categories=[],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=skill_content,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_search_grounding_alone_routes_non_pro_skill_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        _text_response("Found external references."),
        _text_response("Saved the references."),
    )

    skill_content = SkillContent(
        descriptor=SkillDescriptor(
            id="scene-preproduction",
            name="Scene Pre-production",
            description="Prepare references for the next shot.",
            tool_categories=["generation"],
            trigger_keywords=["references"],
        ),
        system_prompt="Research and summarize visual references.",
        enable_search=True,
    )
    task = TaskNode(
        id="task-1",
        description="Research external visual references for the next shot.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.CREATIVE,
        tool_categories=["generation"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=skill_content,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_creative_pro_skill_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Produced the style guide."))

    skill_content = SkillContent(
        descriptor=SkillDescriptor(
            id="cinematography",
            name="Cinematography",
            description="Translate intent into a visual style guide.",
            tool_categories=[],
            trigger_keywords=["camera", "lens", "lighting"],
        ),
        system_prompt="Write a cinematography style guide.",
    )
    task = TaskNode(
        id="task-1",
        description="Create a cinematography style guide for the project.",
        skill_id="cinematography",
        status=TaskStatus.PENDING,
        task_type=TaskType.CREATIVE,
        tool_categories=[],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=skill_content,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_creative_task_with_memory_tools_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Wrote the outline."))

    task = TaskNode(
        id="task-1",
        description="Write a short creative outline for the scene.",
        status=TaskStatus.PENDING,
        task_type=TaskType.CREATIVE,
        tool_categories=[],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_high_stakes_consistency_routes_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Prepared the consistency references."))

    skill_content = SkillContent(
        descriptor=SkillDescriptor(
            id="scene-preproduction",
            name="Scene Pre-production",
            description="Create reference assets for consistency.",
            tool_categories=["generation"],
            trigger_keywords=["reference image", "consistency"],
        ),
        system_prompt="Maintain consistency across shots with reference images.",
    )
    task = TaskNode(
        id="task-1",
        description="Generate reference images to maintain visual consistency across shots.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=skill_content,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_reference_assets_route_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the consistent shot."))

    task = TaskNode(
        id="task-1",
        description="Generate the next shot using the available references.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(
        task=task,
        prior_task_results={
            "task-0": "CHARACTER_REFS: {\"hero\": \"img-1\"}\nLOCATION_REFS: {\"studio\": \"img-2\"}",
        },
    )

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_lowercase_reference_assets_route_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the consistent shot."))

    task = TaskNode(
        id="task-1",
        description="Generate the next shot using the available references.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(
        task=task,
        prior_task_results={
            "task-0": "character_refs: {\"hero\": \"img-1\"}\nlocation_refs: {\"studio\": \"img-2\"}",
        },
    )

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_same_character_same_location_with_refs_routes_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the matching shot."))

    task = TaskNode(
        id="task-1",
        description="Generate the next shot with the same hero in the same studio.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(
        task=task,
        prior_task_results={
            "task-0": "CHARACTER_REFS: {\"hero\": \"img-1\"}\nLOCATION_REFS: {\"studio\": \"img-2\"}",
        },
    )

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_same_character_same_location_without_refs_routes_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the matching shot."))

    task = TaskNode(
        id="task-1",
        description="Generate the next shot with the same hero in the same studio.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_sub_agent_continuity_wording_without_refs_routes_to_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Generated the continuous shot."))

    task = TaskNode(
        id="task-1",
        description="Generate the next shot and maintain continuity with the prior scene.",
        skill_id="scene-preproduction",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["generation"],
    )
    context = SubAgentContext(task=task)

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_reference_assets_do_not_escalate_unrelated_task() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Organized the assets into bins."))

    task = TaskNode(
        id="task-1",
        description="Organize the generated assets into bins.",
        status=TaskStatus.PENDING,
        task_type=TaskType.EXECUTION,
        tool_categories=["asset_mgmt"],
    )
    context = SubAgentContext(
        task=task,
        prior_task_results={
            "task-0": "CHARACTER_REFS: {\"hero\": \"img-1\"}\nLOCATION_REFS: {\"studio\": \"img-2\"}",
        },
    )

    result = execute_sub_agent(
        task=task,
        skill_content=None,
        context=context,
        api_key="test-key",
        http_client=http,
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_brain_topic_extraction_uses_routed_model() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({"summary": "Project summary", "topics": []}))

    _call_gemini_for_topics(
        "Clip 1: Interview about pricing",
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_video_analyzer_uses_routed_model() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({"summary": "A scene", "scenes": [], "dialogue": [], "topics": []}))

    _gemini_generate(
        file_uri="storage://video/123",
        mime_type="video/mp4",
        system_prompt="Analyze this video.",
        user_text="Describe the scenes.",
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-flash-lite-preview:generateContent")


def test_simple_agent_review_calls_use_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _json_response({"overall_score": 9, "feedback": []}))

    result = gemini_agent._gemini_review_call(
        "Review this edit.",
        ToolCall(tool_name="review_edit_quality", call_id="call-1"),
        api_key="test-key",
        http_client=http,
        label="review_edit_quality",
    )

    assert result.success is True
    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_plain_review_prompt_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("Here is the review."))

    request = AgentExecuteRequest(
        prompt="review the generated output against the brief",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_simple_agent_cut_feedback_prompt_uses_pro() -> None:
    http = FakeHTTPClient()
    http.queue("post", _text_response("The cut works well."))

    request = AgentExecuteRequest(
        prompt="what do you think of this cut?",
        view_context=ViewContext.EDITOR,
    )
    gemini_agent.execute_prompt(
        request=request,
        gemini_api_key="test-key",
        http_client=http,
    )

    assert http.calls[0].url.endswith("/gemini-3.1-pro-preview:generateContent")


def test_routing_flag_restores_legacy_call_site_behavior(monkeypatch) -> None:
    monkeypatch.setenv("LTX_AGENT_MODEL_ROUTING", "0")
    http = FakeHTTPClient()
    http.queue("post", _json_response({"name": "Sunset Beach", "tags": ["sunset", "beach"]}))

    result = suggest_asset_meta(
        prompt="golden sunset over the ocean",
        asset_type="image",
        existing_tags=[],
        gemini_api_key="test-key",
        http_client=http,
    )

    assert result is not None
    assert http.calls[0].url.endswith("/gemini-3-flash-preview:generateContent")
