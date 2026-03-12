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
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from agent.gemini_agent import SYSTEM_PROMPT as BRAIN_SYSTEM_PROMPT
from agent.tool_knowledge_base import classify_intent, get_tools_for_categories
from agent.tool_registry import TOOLS_BY_NAME, tools_to_gemini_declarations
from agent.types import (
    ExecutionTarget,
    SkillContent,
    SubAgentContext,
    SubAgentResult,
    TaskNode,
    ToolCall,
    ToolResult,
)
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

_SUB_AGENT_MODEL = "gemini-3-flash-preview"
_MAX_WORKERS = 4
_MAX_SUB_AGENT_TURNS = 30


def _build_system_prompt(
    task: TaskNode,
    skill_content: SkillContent | None,
) -> str:
    """Build the system prompt for a sub-agent."""
    task_type = getattr(task, "task_type", "execution")
    is_execution = task_type == "execution"

    if is_execution:
        rules = (
            "## Rules\n"
            "- You MUST execute this task by calling the available tools.\n"
            "- Do NOT just describe what should be done — actually DO it by calling tools.\n"
            "- Focus ONLY on the task described above.\n"
            "- Do NOT attempt work outside your assigned task.\n"
            "- After executing tools, summarize what you accomplished including any asset IDs or results.\n"
            "- Be concise — your output will be reviewed by an orchestrator."
        )
    else:
        rules = (
            "## Rules\n"
            "- Produce the requested creative output as text.\n"
            "- Be specific and detailed — your output will be used by other agents to execute.\n"
            "- Focus ONLY on the task described above.\n"
            "- Do NOT attempt work outside your assigned task.\n"
            "- When done, summarize what you produced."
        )

    if skill_content:
        parts = [
            "You are executing a specific task as part of a larger workflow.\n",
            f"## Your Task\n{task.description}\n",
            f"## Your Expertise\n{skill_content.system_prompt}\n",
            rules,
        ]
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

    return (
        f"You are executing a specific task as part of a larger workflow.\n\n"
        f"## Your Task\n{task.description}\n\n"
        f"## General Instructions\n{BRAIN_SYSTEM_PROMPT}\n\n"
        f"{rules}"
    )


def _has_shot_list(prior_results: dict[str, str]) -> bool:
    """Check if any prior task result contains a numbered shot list."""
    for summary in prior_results.values():
        if any(f"Shot {i}:" in summary or f"Shot {i} :" in summary for i in range(1, 30)):
            return True
    return False


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

    if context.timeline_context:
        parts.append(f"## Timeline State\n{context.timeline_context}")

    if context.assets_context:
        parts.append(f"## Available Assets\n{context.assets_context}")

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
                "Do NOT just describe what to do — actually call the tools."
            )

        if has_script:
            parts.append(
                "## CRITICAL: Follow the Shot List\n"
                "The prior tasks contain a NUMBERED shot list. You MUST:\n"
                "- Generate EVERY shot listed (Shot 1, Shot 2, Shot 3, etc.)\n"
                "- Follow each shot's visual description EXACTLY\n"
                "- Do NOT skip any shots\n"
                "- Do NOT invent new shots that aren't in the list\n"
                "- For each shot: first call generate_image with the visual "
                "description, then call generate_video with image_to_video "
                "mode to animate it\n"
                "- Report each shot's asset_id in your summary"
            )

    elif task_type == "review":
        parts.append(
            "Evaluate the results from prior tasks now."
        )
        if has_script:
            parts.append(
                "## CRITICAL: Review Against the Script\n"
                "The prior tasks contain a NUMBERED shot list and generated "
                "content. You MUST:\n"
                "- Compare EACH generated shot against its corresponding "
                "shot description in the script\n"
                "- Reference shots by number (Shot 1, Shot 2, etc.)\n"
                "- For each shot, state: PASS (matches description) or "
                "FAIL (explain what's wrong)\n"
                "- If any shots need regeneration, say 'regenerate' and "
                "explain what should change\n"
                "- Evaluate overall visual consistency across all shots"
            )
    else:
        if "shot" in context.task.description.lower() or "script" in context.task.description.lower():
            parts.append(
                "## CRITICAL: Structured Output Required\n"
                "Your output MUST include a NUMBERED shot list using the "
                "format 'Shot 1:', 'Shot 2:', etc. Each shot must specify:\n"
                "- Visual description (what the camera sees)\n"
                "- Shot type (wide, medium, close-up, detail, POV)\n"
                "- Camera motion (static, dolly_in, dolly_out, etc.)\n"
                "- Duration in seconds\n"
                "- Any dialogue or text overlay\n\n"
                "Produce the creative output now."
            )
        else:
            parts.append("Produce the requested creative output now.")

    return "\n\n".join(parts)


def _get_scoped_tools(
    task: TaskNode,
    skill_content: SkillContent | None,
) -> tuple[list[Any], list[str]]:
    """Get tool declarations scoped to the task's categories.

    Returns (declarations, tool_names) so the user message can list
    available tools.
    """
    if skill_content and skill_content.tool_overrides:
        tools = [TOOLS_BY_NAME[name] for name in skill_content.tool_overrides if name in TOOLS_BY_NAME]
        if tools:
            return tools_to_gemini_declarations(tools), [t.name for t in tools]

    categories = task.tool_categories or (
        skill_content.descriptor.tool_categories if skill_content else []
    )

    if not categories:
        inferred = classify_intent(task.description)
        categories = inferred if inferred else ["core", "generation", "clip_editing", "timeline_mgmt"]
        logger.info(
            "[sub-agent] task=%s | no categories, inferred: %s",
            task.id, categories,
        )

    if "core" not in categories:
        categories = ["core", *categories]

    scoped_tools = get_tools_for_categories(categories)
    if not scoped_tools:
        return tools_to_gemini_declarations(None), []

    return tools_to_gemini_declarations(scoped_tools), [t.name for t in scoped_tools]


def _execute_backend_tool_inline(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
) -> ToolResult:
    """Execute a backend tool inline."""
    from agent.gemini_agent import _execute_backend_tool
    return _execute_backend_tool(
        tool_call,
        api_key=api_key,
        http_client=http_client,
        session_id="sub-agent",
    )


def _run_gemini_turn(
    contents: list[dict[str, Any]],
    system_prompt: str,
    tool_declarations: list[Any],
    api_key: str,
    http_client: HTTPClient,
    task_id: str,
    turn: int,
) -> tuple[list[dict[str, Any]], list[ToolCall], list[ToolCall]] | None:
    """Make one Gemini API call and parse the response.

    Returns (parts, frontend_calls, backend_calls) or None on error.
    """
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_SUB_AGENT_MODEL}:generateContent"
    )
    payload: dict[str, Any] = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "tools": [{"functionDeclarations": tool_declarations}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 8192},
    }

    t0 = time.monotonic()
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
    except HttpTimeoutError:
        logger.error("Sub-agent timed out for task %s (turn %d)", task_id, turn)
        return None
    except Exception:
        logger.error("Sub-agent request failed for task %s", task_id, exc_info=True)
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
    system_prompt = _build_system_prompt(task, skill_content)
    tool_declarations, tool_names = _get_scoped_tools(task, skill_content)
    user_message = _build_user_message(context, tool_names)

    contents: list[dict[str, Any]] = [
        {"role": "user", "parts": [{"text": user_message}]},
    ]

    all_frontend_tool_calls: list[ToolCall] = []
    all_backend_results: list[ToolResult] = []
    text_fragments: list[str] = []

    for turn in range(_MAX_SUB_AGENT_TURNS):
        result = _run_gemini_turn(
            contents, system_prompt, tool_declarations,
            api_key, http_client, task.id, turn,
        )
        if result is None:
            return SubAgentResult(
                task_id=task.id, success=False,
                error="Gemini call failed",
            )

        parts, frontend_calls, backend_calls = result
        contents.append({"role": "model", "parts": parts})

        for part in parts:
            if "text" in part:
                text_fragments.append(part["text"])

        if not frontend_calls and not backend_calls:
            break

        if backend_calls:
            fn_response_parts: list[dict[str, Any]] = []
            for bc in backend_calls:
                br = _execute_backend_tool_inline(
                    bc, api_key=api_key, http_client=http_client,
                )
                all_backend_results.append(br)
                result_payload: dict[str, Any] = (
                    {"result": br.result} if br.success
                    else {"error": br.error or "unknown"}
                )
                fn_response_parts.append(
                    {"functionResponse": {"name": bc.tool_name, "response": result_payload}}
                )
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
    )


def resume_sub_agent(
    prev_result: SubAgentResult,
    tool_results: list[ToolResult],
    api_key: str,
    http_client: HTTPClient,
) -> SubAgentResult:
    """Resume a sub-agent session after frontend tool execution.

    Feeds tool results back into the Gemini conversation and lets
    the sub-agent continue its workflow.
    """
    contents = list(prev_result.sub_agent_contents or [])
    system_prompt = prev_result.sub_agent_system_prompt or ""
    tool_declarations = prev_result.sub_agent_tool_declarations or []
    task_id = prev_result.task_id

    if not contents or not system_prompt:
        return SubAgentResult(
            task_id=task_id, success=True,
            message=prev_result.message,
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
            api_key, http_client, task_id, turn + 100,
        )
        if result is None:
            return SubAgentResult(
                task_id=task_id, success=False,
                error="Resume Gemini call failed",
            )

        parts, frontend_calls, backend_calls = result
        contents.append({"role": "model", "parts": parts})

        for part in parts:
            if "text" in part:
                text_fragments.append(part["text"])

        if not frontend_calls and not backend_calls:
            break

        if backend_calls:
            fn_resp: list[dict[str, Any]] = []
            for bc in backend_calls:
                br = _execute_backend_tool_inline(
                    bc, api_key=api_key, http_client=http_client,
                )
                all_backend_results.append(br)
                rp: dict[str, Any] = (
                    {"result": br.result} if br.success
                    else {"error": br.error or "unknown"}
                )
                fn_resp.append(
                    {"functionResponse": {"name": bc.tool_name, "response": rp}}
                )
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
    ) -> SubAgentResult:
        return resume_sub_agent(
            prev_result, tool_results,
            self._api_key, self._http_client,
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
