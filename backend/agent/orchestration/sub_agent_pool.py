"""Execute tasks as isolated Gemini sessions with skill-specific context.

Each sub-agent gets:
- A focused system prompt (skill instructions OR general brain)
- Only the tool declarations for its assigned categories
- Only the context data it needs
- A hard token budget

This keeps each sub-agent call lean (~30K tokens) compared to the
monolithic single-session approach.
"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from agent.gemini_agent import SYSTEM_PROMPT as BRAIN_SYSTEM_PROMPT
from agent.tool_knowledge_base import get_tools_for_categories
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
_MAX_SUB_AGENT_TURNS = 10


def _build_system_prompt(
    task: TaskNode,
    skill_content: SkillContent | None,
) -> str:
    """Build the system prompt for a sub-agent.

    Uses the skill's system prompt if available, otherwise falls
    back to the general brain prompt.  Reference files from the
    skill are appended as labeled sections so the sub-agent has
    access to domain knowledge without needing file-system tools.
    """
    rules = (
        "## Rules\n"
        "- Focus ONLY on the task described above.\n"
        "- Do NOT attempt work outside your assigned task.\n"
        "- When done, summarize what you accomplished.\n"
        "- Be concise — your output will be reviewed by an orchestrator."
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


def _build_user_message(context: SubAgentContext) -> str:
    """Build the user message with all relevant context for the sub-agent."""
    parts: list[str] = []

    parts.append(f"## Task\n{context.task.description}")

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

    parts.append("Execute the task now. Use the available tools as needed.")
    return "\n\n".join(parts)


def _get_scoped_tools(
    task: TaskNode,
    skill_content: SkillContent | None,
) -> list[Any]:
    """Get tool declarations scoped to the task's categories."""
    if skill_content and skill_content.tool_overrides:
        tools = [TOOLS_BY_NAME[name] for name in skill_content.tool_overrides if name in TOOLS_BY_NAME]
        if tools:
            return tools_to_gemini_declarations(tools)

    categories = task.tool_categories or (
        skill_content.descriptor.tool_categories if skill_content else ["core"]
    )

    if not categories:
        categories = ["core"]

    if "core" not in categories:
        categories = ["core", *categories]

    scoped_tools = get_tools_for_categories(categories)
    if not scoped_tools:
        return tools_to_gemini_declarations(None)

    return tools_to_gemini_declarations(scoped_tools)


def _execute_backend_tool_inline(
    tool_call: ToolCall,
    *,
    api_key: str,
    http_client: HTTPClient,
) -> ToolResult:
    """Execute a backend tool inline (mirrors gemini_agent._execute_backend_tool)."""
    from agent.gemini_agent import _execute_backend_tool
    return _execute_backend_tool(
        tool_call,
        api_key=api_key,
        http_client=http_client,
        session_id="sub-agent",
    )


def execute_sub_agent(
    task: TaskNode,
    skill_content: SkillContent | None,
    context: SubAgentContext,
    api_key: str,
    http_client: HTTPClient,
) -> SubAgentResult:
    """Run a single sub-agent Gemini session for one task.

    Backend tools are executed inline; frontend tools are collected
    and returned for the orchestrator to forward to the frontend.
    """
    system_prompt = _build_system_prompt(task, skill_content)
    user_message = _build_user_message(context)
    tool_declarations = _get_scoped_tools(task, skill_content)

    contents: list[dict[str, Any]] = [
        {"role": "user", "parts": [{"text": user_message}]},
    ]

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_SUB_AGENT_MODEL}:generateContent"
    )

    all_frontend_tool_calls: list[ToolCall] = []
    all_backend_results: list[ToolResult] = []
    text_fragments: list[str] = []

    for turn in range(_MAX_SUB_AGENT_TURNS):
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
            logger.error("Sub-agent timed out for task %s (turn %d)", task.id, turn)
            return SubAgentResult(
                task_id=task.id,
                success=False,
                error="Sub-agent timed out",
            )
        except Exception:
            logger.error("Sub-agent request failed for task %s", task.id, exc_info=True)
            return SubAgentResult(
                task_id=task.id,
                success=False,
                error="Sub-agent request failed",
            )

        elapsed = time.monotonic() - t0
        logger.info(
            "[sub-agent] task=%s turn=%d | HTTP %d in %.1fs",
            task.id, turn, resp.status_code, elapsed,
        )

        if resp.status_code != 200:
            logger.error(
                "[sub-agent] task=%s | error: %s",
                task.id, resp.text[:300],
            )
            return SubAgentResult(
                task_id=task.id,
                success=False,
                error=f"Gemini returned HTTP {resp.status_code}",
            )

        try:
            body = resp.json()
            parts: list[dict[str, Any]] = body["candidates"][0]["content"]["parts"]
        except (KeyError, IndexError, TypeError) as exc:
            logger.error("[sub-agent] task=%s | malformed response: %s", task.id, exc)
            return SubAgentResult(
                task_id=task.id,
                success=False,
                error="Malformed Gemini response",
            )

        contents.append({"role": "model", "parts": parts})

        frontend_calls: list[ToolCall] = []
        backend_calls: list[ToolCall] = []

        for part in parts:
            if "text" in part:
                text_fragments.append(part["text"])
            elif "functionCall" in part:
                fc = part["functionCall"]
                tool_name: str = fc.get("name", "")
                arguments: dict[str, Any] = fc.get("args", {})

                tool_def = TOOLS_BY_NAME.get(tool_name)
                if tool_def is None:
                    continue

                tc = ToolCall(
                    tool_name=tool_name,
                    arguments=arguments,
                    call_id=tool_name,
                )
                if tool_def.execution_target == ExecutionTarget.BACKEND:
                    backend_calls.append(tc)
                else:
                    frontend_calls.append(tc)

        if not frontend_calls and not backend_calls:
            break

        if backend_calls:
            fn_response_parts: list[dict[str, Any]] = []
            for bc in backend_calls:
                result = _execute_backend_tool_inline(
                    bc, api_key=api_key, http_client=http_client,
                )
                all_backend_results.append(result)
                result_payload: dict[str, Any] = (
                    {"result": result.result} if result.success
                    else {"error": result.error or "unknown"}
                )
                fn_response_parts.append(
                    {"functionResponse": {"name": bc.call_id, "response": result_payload}}
                )
            contents.append({"role": "function", "parts": fn_response_parts})

        if frontend_calls:
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
        """Execute a single task synchronously."""
        return execute_sub_agent(
            task, skill_content, context,
            self._api_key, self._http_client,
        )

    def execute_parallel(
        self,
        tasks_with_context: list[tuple[TaskNode, SkillContent | None, SubAgentContext]],
    ) -> list[SubAgentResult]:
        """Execute multiple tasks in parallel, up to _MAX_WORKERS concurrent."""
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
