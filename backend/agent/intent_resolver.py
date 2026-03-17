"""Resolve user intent by grounding prompts against project context.

A single Gemini Flash call (~1-2s) that:
- Disambiguates ambiguous/conversational prompts using project memory
- Classifies complexity (simple vs orchestrated)
- Identifies relevant memory document IDs
- Produces a self-contained "grounded prompt" with no ambiguous references

Falls back to the heuristic classifier when the LLM call fails.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agent import project_memory
from agent.orchestration.complexity_router import classify_complexity
from agent.types import AgentMessage, ViewContext
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_MODEL = "gemini-3-flash-preview"
_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

_SYSTEM_PROMPT = """\
You are an intent resolver for a video editing application. Your job is to \
understand what the user actually means, given their project context and \
recent conversation.

You receive:
1. The user's raw prompt (possibly short, conversational, ambiguous)
2. A project digest (structured summary of their current project)
3. Recent conversation history (if any)
4. The current UI view context

Your task: produce a JSON response with these fields:

- "grounded_prompt": Rewrite the user's request as a clear, self-contained \
instruction. Replace pronouns ("it", "that", "the character") with specific \
names from the project context. Include the project name when relevant. \
Do NOT add creative ideas or expand scope — only disambiguate.
- "complexity": "simple" if the request is a single action (one generation, \
one edit, one question), "orchestrated" if it needs multi-step planning \
(script + generation, visual identity work, multi-shot production, etc.)
- "relevant_memory_ids": Array of document IDs from the project digest that \
the agent should read before executing. Empty if no documents are relevant.
- "intent_summary": One sentence describing what the user wants to accomplish.
- "requires_generation": true if the user is asking to generate images or \
videos, false otherwise.

Rules:
- If the project digest is empty, return the prompt mostly unchanged.
- Never invent content. Only use information from the project context.
- Keep grounded_prompt concise — aim for 1-3 sentences max.
- If the user references something not in the project context, keep their \
original wording.
"""

_MAX_HISTORY_MESSAGES = 5
_MAX_HISTORY_CHARS_PER_MSG = 500


def _format_conversation_history(messages: list[AgentMessage]) -> str:
    """Format recent conversation messages for the intent resolver."""
    if not messages:
        return ""
    recent = messages[-_MAX_HISTORY_MESSAGES:]
    lines: list[str] = []
    for msg in recent:
        content = msg.content[:_MAX_HISTORY_CHARS_PER_MSG]
        if len(msg.content) > _MAX_HISTORY_CHARS_PER_MSG:
            content += "..."
        lines.append(f"[{msg.role}]: {content}")
    return "\n".join(lines)


class IntentResolution:
    """Result of intent resolution."""

    __slots__ = (
        "grounded_prompt",
        "complexity",
        "relevant_memory_ids",
        "intent_summary",
        "requires_generation",
    )

    def __init__(
        self,
        grounded_prompt: str,
        complexity: str,
        relevant_memory_ids: list[str] | None = None,
        intent_summary: str = "",
        requires_generation: bool = False,
    ) -> None:
        self.grounded_prompt = grounded_prompt
        self.complexity = complexity
        self.relevant_memory_ids = relevant_memory_ids or []
        self.intent_summary = intent_summary
        self.requires_generation = requires_generation


def resolve_intent(
    prompt: str,
    project_id: str | None,
    conversation_history: list[AgentMessage] | None,
    view_context: ViewContext,
    assets_context: dict[str, object] | None,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> IntentResolution:
    """Resolve user intent using project context and conversation history.

    Makes a single Gemini Flash call. Falls back to heuristic
    classification with the raw prompt on any failure.
    """
    project_digest = ""
    if project_id:
        project_digest = project_memory.get_project_digest(project_id)

    has_context = bool(project_digest.strip()) or bool(conversation_history)
    if not has_context:
        return _heuristic_fallback(prompt)

    user_parts: list[str] = []

    if project_digest:
        user_parts.append(f"## Project Digest\n{project_digest}")

    if conversation_history:
        history_text = _format_conversation_history(conversation_history)
        if history_text:
            user_parts.append(f"## Recent Conversation\n{history_text}")

    view_label = {
        ViewContext.EDITOR: "Video Editor (timeline editing)",
        ViewContext.GENSPACE: "Gen Space (asset gallery & generation)",
        ViewContext.PLAYGROUND: "Playground (standalone generation)",
    }.get(view_context, str(view_context))
    user_parts.append(f"## Current View\n{view_label}")

    if assets_context:
        assets_str = json.dumps(assets_context, default=str)[:500]
        user_parts.append(f"## Assets Context\n{assets_str}")

    user_parts.append(f"## User Prompt\n{prompt}")

    user_message = "\n\n".join(user_parts)

    url = f"{_GEMINI_BASE_URL}/{_MODEL}:generateContent"
    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
        "systemInstruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
        },
    }

    try:
        resp = http_client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_api_key,
            },
            json_payload=payload,
            timeout=10,
        )

        if resp.status_code != 200:
            logger.warning(
                "Intent resolver Gemini call failed HTTP %d: %s",
                resp.status_code,
                resp.text[:300],
            )
            return _heuristic_fallback(prompt)

        body = resp.json()
        text: str = body["candidates"][0]["content"]["parts"][0]["text"]
        data: dict[str, Any] = json.loads(text)

    except Exception:
        logger.warning("Intent resolver failed, using heuristic fallback", exc_info=True)
        return _heuristic_fallback(prompt)

    return _parse_response(data, prompt)


def _parse_response(data: dict[str, Any], original_prompt: str) -> IntentResolution:
    """Parse LLM JSON into an IntentResolution, with safe defaults."""
    grounded = str(data.get("grounded_prompt", original_prompt)).strip()
    if not grounded:
        grounded = original_prompt

    complexity = str(data.get("complexity", "simple")).lower()
    if complexity not in ("simple", "orchestrated"):
        complexity = classify_complexity(original_prompt)

    raw_ids = data.get("relevant_memory_ids", [])
    memory_ids: list[str] = []
    if isinstance(raw_ids, list):
        memory_ids = [str(mid) for mid in raw_ids if mid]

    intent_summary = str(data.get("intent_summary", ""))
    requires_gen = bool(data.get("requires_generation", False))

    return IntentResolution(
        grounded_prompt=grounded,
        complexity=complexity,
        relevant_memory_ids=memory_ids,
        intent_summary=intent_summary,
        requires_generation=requires_gen,
    )


def _heuristic_fallback(prompt: str) -> IntentResolution:
    """Fall back to heuristic classification with the raw prompt."""
    complexity = classify_complexity(prompt)
    return IntentResolution(
        grounded_prompt=prompt,
        complexity=complexity,
    )
