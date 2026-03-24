"""Generate clarification questions for complex agent requests.

Makes a single Gemini Flash call to produce structured questions that
will meaningfully improve the agent's output.  Returns an empty list
when the prompt is already clear enough to execute.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from agent.model_policy import AgentStage, select_model
from agent.types import (
    AgentDiagnostics,
    ClarificationOption,
    ClarificationQuestion,
    ClarifyRequest,
    ClarifyResponse,
    TimelineState,
)
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
_MAX_QUESTIONS = 6

_SYSTEM_PROMPT = """\
You are a senior video editor assistant. The user has given you a complex video \
editing or generation request. Your job is to decide whether you need more \
information before executing, and if so, generate a short list of clarification \
questions.

## Rules

- Be HONEST and DIRECT. Do not ask questions just to seem thorough. Only ask \
questions whose answers will materially change what you produce.
- If the request is already specific enough to execute well, return \
needs_clarification=false with an empty questions list.
- Maximum {max_questions} questions. Prefer fewer if possible.
- Each question must have 3-6 concrete, distinct options. Options should cover \
the most common reasonable choices for that question.
- Questions should be about creative and technical decisions that affect the \
output: platform/format, visual style, pacing, duration, mood, composition, \
audio, etc.
- Do NOT ask about things the user already specified in their prompt.
- Do NOT ask vague or philosophical questions. Be specific and actionable.
- Question IDs should be short kebab-case strings (e.g. "target-platform").
- Option IDs should be short kebab-case strings (e.g. "vertical-916").

## Context

The user is working in a video editing application with AI generation \
capabilities. They can generate videos from text prompts, edit timelines, \
add transitions, and export in various formats.

{timeline_context}

## Output Format

Return a JSON object with this schema:
{{
  "needs_clarification": boolean,
  "questions": [
    {{
      "id": "string",
      "question": "string",
      "options": [
        {{ "id": "string", "label": "string" }}
      ],
      "allow_custom": boolean
    }}
  ]
}}
""".replace("{max_questions}", str(_MAX_QUESTIONS))


def _format_timeline_context(ts: TimelineState) -> str:
    if not ts.clips:
        return "The timeline is currently empty."
    lines = [
        f"Timeline: {len(ts.clips)} clips, {ts.track_count} tracks, "
        f"{ts.total_duration:.1f}s total duration."
    ]
    for clip in ts.clips[:10]:
        lines.append(
            f"  - {clip.type} clip ({clip.duration:.1f}s) on track {clip.track_index}"
        )
    if len(ts.clips) > 10:
        lines.append(f"  ... and {len(ts.clips) - 10} more clips")
    return "\n".join(lines)


def generate_questions(
    request: ClarifyRequest,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> ClarifyResponse:
    """Generate clarification questions for a complex user request.

    Returns ``ClarifyResponse(needs_clarification=False)`` on any error
    so the agent can proceed without blocking.
    """
    timeline_context = ""
    if request.timeline_state is not None:
        timeline_context = _format_timeline_context(request.timeline_state)

    project_context = ""
    if request.project_id:
        from agent import project_memory
        digest = project_memory.get_project_digest(request.project_id)
        if digest:
            project_context = f"\n\n## Project Context\n{digest}"

    system_prompt = _SYSTEM_PROMPT.replace(
        "{timeline_context}", timeline_context + project_context,
    )

    user_message = f"User request:\n{request.prompt}"
    if request.project_id:
        from agent import project_memory as pm
        memory_ctx = pm.format_memory_for_agent(request.project_id)
        if memory_ctx:
            user_message += f"\n\n{memory_ctx}"
    if request.assets_context:
        user_message += f"\n\nAvailable assets context:\n{json.dumps(request.assets_context, default=str)[:2000]}"

    selection = select_model(AgentStage.CLARIFICATION)
    url = f"{_GEMINI_BASE_URL}/{selection.model}:generateContent"
    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    t0 = time.monotonic()
    try:
        resp = http_client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_api_key,
            },
            json_payload=payload,
            timeout=30,
        )
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info("[clarification] Gemini responded HTTP %d in %dms", resp.status_code, elapsed_ms)

        if resp.status_code != 200:
            logger.warning(
                "Clarification Gemini call failed with HTTP %d: %s",
                resp.status_code,
                resp.text[:300],
            )
            return ClarifyResponse(needs_clarification=False)

        body: Any = resp.json()
        text: str = body["candidates"][0]["content"]["parts"][0]["text"]
        data: Any = json.loads(text)

    except Exception:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.warning("Clarification generation failed after %dms", elapsed_ms, exc_info=True)
        return ClarifyResponse(needs_clarification=False)

    parsed = _parse_response(data)
    parsed.diagnostics = AgentDiagnostics(
        selected_model=selection.model,
        stage_name=AgentStage.CLARIFICATION.value,
        llm_ms=elapsed_ms,
    )
    return parsed


def _parse_response(data: Any) -> ClarifyResponse:
    """Parse LLM JSON into a validated ClarifyResponse."""
    if not isinstance(data, dict):
        return ClarifyResponse(needs_clarification=False)

    needs = bool(data.get("needs_clarification", False))
    raw_questions = data.get("questions", [])

    if not needs or not isinstance(raw_questions, list) or len(raw_questions) == 0:
        return ClarifyResponse(needs_clarification=False)

    questions: list[ClarificationQuestion] = []
    for raw_q in raw_questions[:_MAX_QUESTIONS]:
        if not isinstance(raw_q, dict):
            continue
        q_id = str(raw_q.get("id", ""))
        q_text = str(raw_q.get("question", ""))
        raw_opts = raw_q.get("options", [])
        if not q_id or not q_text or not isinstance(raw_opts, list) or len(raw_opts) < 2:
            continue

        options: list[ClarificationOption] = []
        for raw_opt in raw_opts[:6]:
            if not isinstance(raw_opt, dict):
                continue
            opt_id = str(raw_opt.get("id", ""))
            opt_label = str(raw_opt.get("label", ""))
            if opt_id and opt_label:
                options.append(ClarificationOption(id=opt_id, label=opt_label))

        if len(options) < 2:
            continue

        questions.append(ClarificationQuestion(
            id=q_id,
            question=q_text,
            options=options,
            allow_custom=bool(raw_q.get("allow_custom", True)),
        ))

    if not questions:
        return ClarifyResponse(needs_clarification=False)

    return ClarifyResponse(needs_clarification=True, questions=questions)
