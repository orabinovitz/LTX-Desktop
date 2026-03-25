"""Execute tasks as isolated Gemini sessions with skill-specific context.

Each sub-agent gets:
- A focused system prompt (skill instructions OR general brain)
- Only the tool declarations for its assigned categories
- Only the context data it needs
- A hard token budget

Sub-agents support **multi-round execution**: when a sub-agent returns
frontend tool calls, the orchestrator forwards them to the frontend,
collects results, and resumes the same sub-agent session so it can
continue its workflow (e.g. generate_image -> see asset_id -> generate_video).
"""

from __future__ import annotations

import logging
import random
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from agent.gemini_agent import GENERAL_CONTEXT_PROMPT
from agent.model_policy import AgentStage, select_model
from agent.tool_knowledge_base import classify_intent, get_tools_for_categories
from agent.tool_registry import TOOLS_BY_NAME, tools_to_gemini_declarations
from agent.types import (
    ExecutionTarget,
    SkillContent,
    SubAgentContext,
    SubAgentResult,
    TaskNode,
    TaskType,
    ToolCall,
    ToolResult,
)
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

_MAX_WORKERS = 10
_MAX_SUB_AGENT_TURNS = 30
_backend_tool_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sub-backend-tool")

_HIGH_STAKES_CONSISTENCY_KEYWORDS: tuple[str, ...] = (
    "continuity",
    "consistency",
    "consistent",
    "same ",
    "matching",
    "reference image",
    "reference images",
    "character sheet",
    "turnaround",
    "maintain visual consistency",
)


def _build_system_prompt(
    task: TaskNode,
    skill_content: SkillContent | None,
    project_id: str | None = None,
) -> str:
    """Build the system prompt for a sub-agent."""
    task_type = getattr(task, "task_type", "execution")
    is_execution = task_type == "execution"

    if is_execution:
        rules = (
            "## Rules\n"
            "- Execute this task by calling the available tools.\n"
            "- Call tools to perform the work rather than describing what should happen.\n"
            "- Stay focused on the task described above — the orchestrator handles "
            "the broader workflow.\n"
            "- After executing tools, summarize what you accomplished including "
            "any asset IDs or results.\n"
            "- Be concise — your output will be reviewed by an orchestrator."
        )
    else:
        rules = (
            "## Rules\n"
            "- Produce the requested creative output as text.\n"
            "- Be specific and detailed — your output will be used by other "
            "agents to execute.\n"
            "- Stay focused on the task described above — the orchestrator "
            "handles the broader workflow.\n"
            "- After producing your creative output, save it to project memory "
            "by calling `save_to_project_memory` with an appropriate type "
            "(e.g. 'script', 'research', 'storyboard', 'notes') and descriptive "
            "title so future agents can reference your work.\n"
            "- When done, summarize what you produced."
        )

    digest_section = ""
    if project_id:
        from agent import project_memory
        digest = project_memory.get_project_digest(project_id)
        if digest:
            digest_section = f"\n\n{digest}\n"

    if skill_content:
        parts = [
            "You are executing a specific task as part of a larger workflow.\n",
        ]
        if digest_section:
            parts.append(digest_section)
        parts.extend([
            f"## Your Task\n{task.description}\n",
            f"## Your Expertise\n{skill_content.system_prompt}\n",
            rules,
        ])
        if skill_content.references:
            parts.append("\n\n# Reference Material\n")
            parts.append(
                "The following reference documents are available inline. "
                "When the skill instructions say 'Read `references/<filename>`', "
                "the content is provided below.\n"
            )
            for filename, content in skill_content.references.items():
                parts.append(f"\n## Reference: {filename}\n\n{content}")
        return "\n\n".join(parts)

    parts = [
        "You are executing a specific task as part of a larger workflow.\n",
    ]
    if digest_section:
        parts.append(digest_section)
    parts.extend([
        f"## Your Task\n{task.description}\n",
        f"## General Instructions\n{GENERAL_CONTEXT_PROMPT}\n",
        rules,
    ])
    return "\n\n".join(parts)


def _has_shot_list(prior_results: dict[str, str]) -> bool:
    """Check if any prior task result contains a numbered shot list."""
    for summary in prior_results.values():
        if any(f"Shot {i}:" in summary or f"Shot {i} :" in summary for i in range(1, 30)):
            return True
    return False


def _has_reference_assets(prior_results: dict[str, str]) -> bool:
    """Check if any prior task result contains CHARACTER_REFS or LOCATION_REFS."""
    for summary in prior_results.values():
        normalized = summary.lower()
        if (
            "character_refs" in normalized
            or "location_refs" in normalized
            or "character refs" in normalized
            or "location refs" in normalized
        ):
            return True
    return False


def _task_has_high_stakes_consistency(task: TaskNode, skill_content: SkillContent | None) -> bool:
    text_parts = [task.description.lower()]
    if skill_content is not None:
        text_parts.append(skill_content.system_prompt.lower())
        text_parts.append(skill_content.descriptor.description.lower())
    haystack = "\n".join(text_parts)
    return any(keyword in haystack for keyword in _HIGH_STAKES_CONSISTENCY_KEYWORDS)


def _task_uses_reference_continuity(task: TaskNode) -> bool:
    text = task.description.lower()
    return any(keyword in text for keyword in ("reference", "references", "consistent", "consistency", "continuity", "same ", "matching"))


def _build_user_message(context: SubAgentContext, tool_names: list[str]) -> str:
    """Build the user message with all relevant context for the sub-agent."""
    parts: list[str] = []

    parts.append(f"## Task\n{context.task.description}")

    if context.target_duration_seconds is not None:
        parts.append(
            f"## Target Duration\n"
            f"The planned target duration for this project is "
            f"**{context.target_duration_seconds:.0f} seconds** "
            f"(~{context.target_duration_seconds / 60:.1f} minutes). "
            f"All shot counts, pacing decisions, and timeline assembly "
            f"must target this duration."
        )

    if context.creative_profile is not None:
        parts.append(
            f"## Creative Profile\n"
            f"This request is operating under the structured profile "
            f"`{context.creative_profile.value}`. Match your decisions to that "
            f"profile rather than defaulting to a generic cinematic workflow."
        )

    if context.coverage_contract is not None:
        parts.append(
            "## Coverage Contract\n"
            f"- Minimum shot count: {context.coverage_contract.min_shot_count}\n"
            f"- Maximum dialogue share: {context.coverage_contract.max_dialogue_share:.0%}\n"
            f"- Minimum meaningful edit operations: {context.coverage_contract.min_meaningful_edit_operations}\n"
            f"- Structured review required: {context.coverage_contract.requires_structured_review}\n"
            f"- Timeline review required: {context.coverage_contract.requires_timeline_review}\n"
            "Use this as a hard creative constraint when planning coverage, "
            "generation density, and editorial shape."
        )

    if context.timeline_context:
        parts.append(f"## Timeline State\n{context.timeline_context}")

    if context.assets_context:
        parts.append(f"## Available Assets\n{context.assets_context}")

    if context.project_id:
        from agent import project_memory
        memory_ctx = project_memory.format_memory_for_agent(context.project_id)
        if memory_ctx:
            parts.append(memory_ctx)

    if context.prior_task_results:
        results_text = "\n".join(
            f"- **{tid}**: {summary}"
            for tid, summary in context.prior_task_results.items()
        )
        parts.append(f"## Results From Prior Tasks\n{results_text}")

    task_type = getattr(context.task, "task_type", "execution")
    has_script = _has_shot_list(context.prior_task_results) if context.prior_task_results else False

    if task_type == "execution":
        if tool_names:
            tools_summary = ", ".join(tool_names[:15])
            parts.append(
                f"## Available Tools\n"
                f"You have access to these tools: {tools_summary}\n\n"
                f"Execute the task NOW by calling the appropriate tools. "
                f"Do NOT describe what to do — call the tools to do it."
            )
        else:
            parts.append(
                "Execute the task now by calling the available tools. "
                "Call tools to perform the work rather than describing "
                "what should happen."
            )

        if has_script:
            parts.append(
                "## Shot Execution\n"
                "The prior tasks produced a numbered shot list. Generate "
                "each shot in order because downstream tasks (review, "
                "timeline assembly) expect this structure.\n"
                "- Generate every listed shot (Shot 1, Shot 2, Shot 3, etc.)\n"
                "- Follow each shot's visual description precisely\n"
                "- For each shot: call generate_image with the visual "
                "description and aspect_ratio='16:9' for standard landscape "
                "video framing, then call generate_video with image_to_video "
                "mode to animate it\n"
                "- Pass aspect_ratio='16:9' to generate_image unless the "
                "user explicitly requested a different ratio\n"
                "- Report each shot's asset_id in your summary"
            )

        has_refs = _has_reference_assets(context.prior_task_results) if context.prior_task_results else False
        if has_refs:
            parts.append(
                "## Visual Consistency\n"
                "Pre-production tasks generated character and/or location "
                "reference images. Pass the relevant reference asset IDs "
                "in the `image_urls` parameter of `generate_image` calls "
                "to maintain visual consistency across shots.\n\n"
                "If the task description includes specific asset IDs to "
                "use as image_urls, use those exactly.\n\n"
                "In your prompt, anchor character identity in the first "
                "10 words and use identical vocabulary to the character "
                "descriptions from pre-production."
            )

    elif task_type == "review":
        parts.append(
            "Evaluate the results from prior tasks now."
        )
        if has_script:
            parts.append(
                "## Script Review\n"
                "The prior tasks contain a numbered shot list and generated "
                "content. Compare each generated shot against its "
                "corresponding shot description in the script:\n"
                "- Reference shots by number (Shot 1, Shot 2, etc.)\n"
                "- For each shot, state: PASS (matches description) or "
                "FAIL (explain what's wrong)\n"
                "- If any shots need regeneration, say 'regenerate' and "
                "explain what should change\n"
                "- Evaluate overall visual consistency across all shots"
            )
            parts.append(
                "## Review Output Format\n"
                "Return JSON with this exact shape:\n"
                "{\n"
                '  "overall_verdict": "pass" | "fail",\n'
                '  "summary": "short summary",\n'
                '  "actions": [\n'
                '    {"kind": "regenerate_shot", "shot_number": 3, "reason": "what to fix"},\n'
                '    {"kind": "recut_timeline", "reason": "how the timeline should change"},\n'
                '    {"kind": "rewrite_script", "reason": "why upstream script work is needed"}\n'
                "  ]\n"
                "}\n"
                "Only include actions that are actually necessary."
            )
    else:
        if "shot" in context.task.description.lower() or "script" in context.task.description.lower():
            parts.append(
                "## Structured Output\n"
                "Include a numbered shot list using the format "
                "'Shot 1 (Ns):', 'Shot 2 (Ns):', etc. because downstream "
                "agents parse this structure. Each shot should specify:\n"
                "- Visual description (what the camera sees)\n"
                "- Shot type (wide, medium, close-up, detail, POV)\n"
                "- Camera motion (static, dolly_in, dolly_out, etc.)\n"
                "- Duration as (Ns) in the shot header — e.g., Shot 3 (10s): "
                "Valid durations: 6, 8, 10, 12, 14, 16, 18, or 20 seconds. "
                "Dialogue shots need 8-12s minimum.\n"
                "- Any dialogue as quoted speech — e.g., "
                "BUGS: \"What's up, doc?\" — so downstream agents can "
                "show speaking characters\n\n"
                "Produce the creative output now."
            )
        else:
            parts.append("Produce the requested creative output now.")

    return "\n\n".join(parts)


def _get_scoped_tools(
    task: TaskNode,
    skill_content: SkillContent | None,
) -> tuple[list[Any], list[str], list[str]]:
    """Get tool declarations scoped to the task's categories.

    Returns (declarations, tool_names) so the user message can list
    available tools.
    """
    if skill_content and skill_content.tool_overrides:
        tools = [TOOLS_BY_NAME[name] for name in skill_content.tool_overrides if name in TOOLS_BY_NAME]
        if tools:
            categories = [tool.category for tool in tools]
            if "memory" not in categories and getattr(task, "task_type", "execution") in (TaskType.CREATIVE, TaskType.REVIEW):
                categories.append("memory")
            return tools_to_gemini_declarations(tools), [t.name for t in tools], categories

    categories = task.tool_categories or (
        skill_content.descriptor.tool_categories if skill_content else []
    )

    if not categories:
        inferred = classify_intent(task.description)
        if not inferred or len(inferred) > 6:
            categories = ["core", "generation", "clip_editing", "timeline_mgmt"]
        else:
            categories = inferred
        logger.info(
            "[sub-agent] task=%s | no categories, inferred: %s",
            task.id, categories,
        )

    if "core" not in categories:
        categories = ["core", *categories]
    task_type_val = getattr(task, "task_type", "execution")
    task_type_str = task_type_val.value if hasattr(task_type_val, "value") else str(task_type_val)
    if "memory" not in categories and task_type_str in ("creative", "review"):
        categories = [*categories, "memory"]

    scoped_tools = get_tools_for_categories(categories)
    if not scoped_tools:
        return tools_to_gemini_declarations(None), [], categories

    return tools_to_gemini_declarations(scoped_tools), [t.name for t in scoped_tools], categories


def _execute_backend_tool_inline(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
    project_id: str | None = None,
) -> ToolResult:
    """Execute a backend tool inline."""
    from agent.gemini_agent import _execute_backend_tool
    return _execute_backend_tool(
        tool_call,
        api_key=api_key,
        http_client=http_client,
        session_id="sub-agent",
        project_id=project_id,
    )


def _execute_backend_tools_parallel(
    backend_calls: list[ToolCall],
    *,
    api_key: str,
    http_client: HTTPClient,
    project_id: str | None = None,
) -> tuple[list[ToolResult], list[dict[str, Any]]]:
    """Execute backend tools in parallel and return (results, fn_response_parts)."""
    if len(backend_calls) == 1:
        results = [_execute_backend_tool_inline(
            backend_calls[0], api_key=api_key, http_client=http_client, project_id=project_id,
        )]
    else:
        results = list(_backend_tool_pool.map(
            lambda bc: _execute_backend_tool_inline(
                bc, api_key=api_key, http_client=http_client, project_id=project_id,
            ),
            backend_calls,
        ))

    fn_parts: list[dict[str, Any]] = []
    for br in results:
        payload: dict[str, Any] = (
            {"result": br.result} if br.success
            else {"error": br.error or "unknown"}
        )
        fn_parts.append(
            {"functionResponse": {"name": br.call_id, "response": payload}}
        )
    return results, fn_parts


def _run_gemini_turn(
    contents: list[dict[str, Any]],
    system_prompt: str,
    tool_declarations: list[Any],
    model: str,
    api_key: str,
    http_client: HTTPClient,
    task_id: str,
    turn: int,
    *,
    enable_search: bool = False,
    fallback_model: str | None = None,
) -> tuple[list[dict[str, Any]], list[ToolCall], list[ToolCall]] | None:
    """Make one Gemini API call and parse the response.

    Returns (parts, frontend_calls, backend_calls) or None on error.
    """
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent"
    )
    if enable_search:
        tools: list[dict[str, Any]] = [{"google_search": {}}]
    else:
        tools: list[dict[str, Any]] = [{"functionDeclarations": tool_declarations}]

    payload: dict[str, Any] = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "tools": tools,
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 8192},
    }

    _MAX_RETRIES = 3
    t0 = time.monotonic()
    resp = None
    for _attempt in range(_MAX_RETRIES):
        try:
            resp = http_client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=120,
            )
            if resp.status_code != 503:
                break
            wait = min(1 * (2 ** _attempt) + random.random(), 8)
            logger.warning(
                "[sub-agent] task=%s turn=%d | 503, retrying in %.1fs (attempt %d/%d)",
                task_id, turn, wait, _attempt + 1, _MAX_RETRIES,
            )
            time.sleep(wait)
        except HttpTimeoutError:
            logger.error("Sub-agent timed out for task %s (turn %d)", task_id, turn)
            return None
        except Exception:
            logger.error("Sub-agent request failed for task %s", task_id, exc_info=True)
            return None

    if resp is None:
        logger.error("[sub-agent] task=%s | no response after retries", task_id)
        return None

    if resp.status_code == 503 and fallback_model and fallback_model != model:
        fallback_url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{fallback_model}:generateContent"
        )
        logger.warning(
            "[sub-agent] task=%s turn=%d | %s exhausted 503 retries, falling back to %s",
            task_id, turn, model, fallback_model,
        )
        try:
            resp = http_client.post(
                fallback_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=120,
            )
        except Exception:
            logger.error("[sub-agent] task=%s | fallback request failed", task_id, exc_info=True)
            return None

    elapsed = time.monotonic() - t0
    logger.info(
        "[sub-agent] task=%s turn=%d | HTTP %d in %.1fs",
        task_id, turn, resp.status_code, elapsed,
    )

    if resp.status_code != 200:
        logger.error("[sub-agent] task=%s | error: %s", task_id, resp.text[:300])
        return None

    try:
        body = resp.json()
        parts: list[dict[str, Any]] = body["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error("[sub-agent] task=%s | malformed response: %s", task_id, exc)
        return None

    frontend_calls: list[ToolCall] = []
    backend_calls: list[ToolCall] = []

    for part in parts:
        if "functionCall" in part:
            fc = part["functionCall"]
            tool_name: str = fc.get("name", "")
            arguments: dict[str, Any] = fc.get("args", {})

            tool_def = TOOLS_BY_NAME.get(tool_name)
            if tool_def is None:
                continue

            tc = ToolCall(
                tool_name=tool_name,
                arguments=arguments,
                call_id=f"{tool_name}_{uuid.uuid4().hex[:8]}",
                task_id=task_id,
            )
            if tool_def.execution_target == ExecutionTarget.BACKEND:
                backend_calls.append(tc)
            else:
                frontend_calls.append(tc)

    return parts, frontend_calls, backend_calls


def execute_sub_agent(
    task: TaskNode,
    skill_content: SkillContent | None,
    context: SubAgentContext,
    api_key: str,
    http_client: HTTPClient,
) -> SubAgentResult:
    """Run a single sub-agent Gemini session for one task.

    Backend tools are executed inline. Frontend tools are returned
    to the orchestrator for forwarding to the frontend.  The
    orchestrator can later resume this session via
    ``resume_sub_agent`` with the frontend tool results.
    """
    system_prompt = _build_system_prompt(task, skill_content, context.project_id)
    tool_declarations, tool_names, resolved_categories = _get_scoped_tools(task, skill_content)
    user_message = _build_user_message(context, tool_names)
    search_enabled = skill_content.enable_search if skill_content else False
    has_reference_assets = _has_reference_assets(context.prior_task_results) if context.prior_task_results else False
    model_selection = select_model(
        AgentStage.ORCHESTRATOR_SUB_AGENT,
        prompt=task.description,
        task_type=task.task_type,
        tool_categories=resolved_categories,
        skill_id=task.skill_id,
        preferred_model_tier=skill_content.descriptor.preferred_model_tier if skill_content else None,
        reasoning_class=skill_content.descriptor.reasoning_class if skill_content else None,
        editing_critical=skill_content.descriptor.editing_critical if skill_content else False,
        has_memory_tool_access="memory" in resolved_categories,
        search_grounded=(skill_content.descriptor.search_grounded if skill_content else False) or search_enabled,
        high_stakes_consistency=(
            (skill_content.descriptor.high_stakes_consistency if skill_content else False)
            or _task_has_high_stakes_consistency(task, skill_content)
            or (has_reference_assets and _task_uses_reference_continuity(task))
        ),
    )

    contents: list[dict[str, Any]] = [
        {"role": "user", "parts": [{"text": user_message}]},
    ]

    all_frontend_tool_calls: list[ToolCall] = []
    all_backend_results: list[ToolResult] = []
    text_fragments: list[str] = []

    search_phase = search_enabled

    for turn in range(_MAX_SUB_AGENT_TURNS):
        result = _run_gemini_turn(
            contents, system_prompt, tool_declarations,
            model_selection.model,
            api_key, http_client, task.id, turn,
            enable_search=search_phase,
            fallback_model=model_selection.fallback_model,
        )
        if result is None:
            return SubAgentResult(
                task_id=task.id, success=False,
                error="Gemini call failed",
                sub_agent_model=model_selection.model,
                sub_agent_fallback_model=model_selection.fallback_model,
            )

        parts, frontend_calls, backend_calls = result
        contents.append({"role": "model", "parts": parts})

        for part in parts:
            if "text" in part:
                text_fragments.append(part["text"])

        if search_phase and not frontend_calls and not backend_calls:
            search_phase = False
            contents.append({
                "role": "user",
                "parts": [{"text": "Now save your research output to project memory using save_to_project_memory."}],
            })
            continue

        if not frontend_calls and not backend_calls:
            break

        if backend_calls:
            batch_results, fn_response_parts = _execute_backend_tools_parallel(
                backend_calls, api_key=api_key, http_client=http_client, project_id=context.project_id,
            )
            all_backend_results.extend(batch_results)
            contents.append({"role": "function", "parts": fn_response_parts})

        if frontend_calls:
            if not backend_calls:
                all_frontend_tool_calls.extend(frontend_calls)
                break
            # BUG-8 fix: when backend AND frontend calls exist in same turn,
            # make another Gemini call so the model sees the backend results
            # before we return frontend calls.
            all_frontend_tool_calls.extend(frontend_calls)
            break

    message = "\n".join(text_fragments).strip()

    logger.info(
        "[sub-agent] task=%s | completed: %d frontend tools, %d backend tools, %d chars text",
        task.id,
        len(all_frontend_tool_calls),
        len(all_backend_results),
        len(message),
    )

    return SubAgentResult(
        task_id=task.id,
        success=True,
        tool_calls=all_frontend_tool_calls,
        backend_tool_results=all_backend_results,
        message=message,
        sub_agent_contents=contents,
        sub_agent_system_prompt=system_prompt,
        sub_agent_tool_declarations=tool_declarations,
        sub_agent_enable_search=search_enabled,
        sub_agent_model=model_selection.model,
        sub_agent_fallback_model=model_selection.fallback_model,
    )


def resume_sub_agent(
    prev_result: SubAgentResult,
    tool_results: list[ToolResult],
    api_key: str,
    http_client: HTTPClient,
    project_id: str | None = None,
) -> SubAgentResult:
    """Resume a sub-agent session after frontend tool execution.

    Feeds tool results back into the Gemini conversation and lets
    the sub-agent continue its workflow.
    """
    contents = list(prev_result.sub_agent_contents or [])
    system_prompt = prev_result.sub_agent_system_prompt or ""
    tool_declarations = prev_result.sub_agent_tool_declarations or []
    search_enabled = prev_result.sub_agent_enable_search
    task_id = prev_result.task_id
    model = prev_result.sub_agent_model
    fallback_model = prev_result.sub_agent_fallback_model

    if not contents or not system_prompt:
        return SubAgentResult(
            task_id=task_id, success=True,
            message=prev_result.message,
            sub_agent_model=model,
            sub_agent_fallback_model=fallback_model,
        )

    fn_response_parts: list[dict[str, Any]] = []
    for tr in tool_results:
        payload: dict[str, Any] = (
            {"result": tr.result} if tr.success
            else {"error": tr.error or "unknown error"}
        )
        fn_response_parts.append(
            {"functionResponse": {"name": tr.tool_name or "unknown", "response": payload}}
        )

    if fn_response_parts:
        contents.append({"role": "function", "parts": fn_response_parts})

    all_frontend_tool_calls: list[ToolCall] = []
    all_backend_results: list[ToolResult] = []
    text_fragments: list[str] = []

    for turn in range(_MAX_SUB_AGENT_TURNS):
        result = _run_gemini_turn(
            contents, system_prompt, tool_declarations,
            model,
            api_key, http_client, task_id, turn + 100,
            enable_search=search_enabled,
            fallback_model=fallback_model,
        )
        if result is None:
            return SubAgentResult(
                task_id=task_id, success=False,
                error="Resume Gemini call failed",
                sub_agent_model=model,
                sub_agent_fallback_model=fallback_model,
            )

        parts, frontend_calls, backend_calls = result
        contents.append({"role": "model", "parts": parts})

        for part in parts:
            if "text" in part:
                text_fragments.append(part["text"])

        if not frontend_calls and not backend_calls:
            break

        if backend_calls:
            batch_results, fn_resp = _execute_backend_tools_parallel(
                backend_calls, api_key=api_key, http_client=http_client, project_id=project_id,
            )
            all_backend_results.extend(batch_results)
            contents.append({"role": "function", "parts": fn_resp})

        if frontend_calls:
            all_frontend_tool_calls.extend(frontend_calls)
            break

    message = "\n".join(text_fragments).strip()

    logger.info(
        "[sub-agent] task=%s | resume completed: %d frontend tools, %d backend tools",
        task_id, len(all_frontend_tool_calls), len(all_backend_results),
    )

    return SubAgentResult(
        task_id=task_id,
        success=True,
        tool_calls=all_frontend_tool_calls,
        backend_tool_results=all_backend_results,
        message=message,
        sub_agent_contents=contents,
        sub_agent_system_prompt=system_prompt,
        sub_agent_tool_declarations=tool_declarations,
        sub_agent_enable_search=search_enabled,
        sub_agent_model=model,
        sub_agent_fallback_model=fallback_model,
    )


class SubAgentPool:
    """Manages concurrent sub-agent execution with a bounded thread pool."""

    def __init__(self, api_key: str, http_client: HTTPClient) -> None:
        self._api_key = api_key
        self._http_client = http_client

    def execute_single(
        self,
        task: TaskNode,
        skill_content: SkillContent | None,
        context: SubAgentContext,
    ) -> SubAgentResult:
        return execute_sub_agent(
            task, skill_content, context,
            self._api_key, self._http_client,
        )

    def resume_single(
        self,
        prev_result: SubAgentResult,
        tool_results: list[ToolResult],
        project_id: str | None = None,
    ) -> SubAgentResult:
        return resume_sub_agent(
            prev_result, tool_results,
            self._api_key, self._http_client,
            project_id=project_id,
        )

    def execute_parallel(
        self,
        tasks_with_context: list[tuple[TaskNode, SkillContent | None, SubAgentContext]],
    ) -> list[SubAgentResult]:
        if len(tasks_with_context) == 1:
            task, skill, ctx = tasks_with_context[0]
            return [self.execute_single(task, skill, ctx)]

        results: list[SubAgentResult] = [
            SubAgentResult(task_id="", success=False, error="not executed")
        ] * len(tasks_with_context)

        with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(tasks_with_context))) as pool:
            future_to_idx = {
                pool.submit(
                    execute_sub_agent,
                    task, skill, ctx,
                    self._api_key, self._http_client,
                ): i
                for i, (task, skill, ctx) in enumerate(tasks_with_context)
            }

            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:
                    task_id = tasks_with_context[idx][0].id
                    logger.error("Sub-agent crashed for task %s", task_id, exc_info=True)
                    results[idx] = SubAgentResult(
                        task_id=task_id,
                        success=False,
                        error=str(exc),
                    )

        return results
