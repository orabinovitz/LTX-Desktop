"""Gemini function-calling agent for the LTX Desktop agentic editor.

Orchestrates a multi-turn conversation with Gemini 2.0 Flash, feeding
timeline context and tool definitions so the model can plan and execute
video-editing operations.  Backend tools (e.g. ``get_video_metadata``)
are resolved inline; frontend tools are returned to the React app for
execution.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from agent.tool_registry import TOOLS_BY_NAME, tools_to_gemini_declarations
from agent.types import (
    AgentExecuteRequest,
    AgentExecuteResponse,
    ExecutionTarget,
    TimelineState,
    ToolCall,
    ToolResult,
    VideoMetadata,
)
from agent import video_analyzer
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MAX_TURNS = 10
"""Hard ceiling on agentic loop iterations to prevent runaway calls."""

_GEMINI_MODEL = "gemini-2.0-flash"

SYSTEM_PROMPT = """\
You are an expert video editor assistant integrated into the LTX Desktop \
video editor. You help users edit their timeline by calling the available \
tools.

## Capabilities
- Read and understand the current timeline state (tracks, clips, timing).
- Analyse video assets to understand their content, scenes, and dialogue.
- Perform non-destructive edits: trim, split, delete, move, and add clips.
- Duplicate timelines as safety snapshots before destructive changes.
- Position the playhead for preview.

## Editing Principles
1. **Duplicate before destructive edits** — always call duplicate_timeline \
before deleting or heavily trimming clips so the user can revert.
2. **Prioritize important scenes** — when shortening a video, keep scenes \
with high importance scores and key actions; remove filler or repetitive \
segments.
3. **Clean cuts at scene boundaries** — prefer splitting/trimming at detected \
scene boundaries rather than arbitrary timestamps. This produces \
professional-looking edits.
4. **Ripple delete to close gaps** — after removing a clip, use \
ripple=true so subsequent clips slide left and the timeline stays tight.
5. **Preserve audio continuity** — avoid cuts that land mid-sentence in \
dialogue unless the user explicitly asks.

## Linked Clips
Video clips and their audio counterparts are linked via `linked_clip_ids`. \
When you call trim_clip, split_clip, delete_clip, or move_clip on one clip \
in a linked group, the operation automatically applies to ALL linked siblings. \
**Do NOT call the same operation separately on each linked clip** — that would \
double the effect. Always operate on just one clip from a linked group.

## Workflow
1. Call get_timeline_state to understand the current layout.
2. If you need to understand a video's content, call get_video_metadata \
for each relevant asset.
3. Plan your edits based on the user's request and the metadata.
4. Call duplicate_timeline to create a safety backup.
5. Execute edits (trim, split, delete, move, add) in logical order.
6. Explain what you did and why.

## Response Style
- Be concise. State what you will do, then do it.
- After executing, summarise the key decisions (which scenes kept/removed \
and why).
- If the request is ambiguous, ask a clarifying question instead of guessing.
- Use seconds for all time references.
"""

# ---------------------------------------------------------------------------
# Session storage
# ---------------------------------------------------------------------------

_sessions: dict[str, list[dict[str, Any]]] = {}
"""Maps session IDs to Gemini conversation ``contents`` arrays."""


def create_session() -> str:
    """Create a new conversation session and return its UUID."""
    session_id = uuid.uuid4().hex
    _sessions[session_id] = []
    logger.info("Created agent session %s", session_id)
    return session_id


# ---------------------------------------------------------------------------
# Public entry-points
# ---------------------------------------------------------------------------


def execute_prompt(
    request: AgentExecuteRequest,
    gemini_api_key: str,
    http_client: HTTPClient,
) -> tuple[str, AgentExecuteResponse]:
    """Start or continue an agentic loop for the given user prompt.

    If ``request.session_id`` references an existing session the new user
    message is appended to the full Gemini conversation history (which
    includes all prior function calls and results).  Otherwise a fresh
    session is created.

    Returns ``(session_id, response)`` where *response* may contain
    frontend tool calls that the caller must execute and feed back via
    :func:`continue_with_results`.
    """
    # Reuse existing session when available so full Gemini history
    # (including function calls / results) is preserved.
    existing = (
        request.session_id
        and request.session_id in _sessions
    )
    if existing:
        session_id = request.session_id  # type: ignore[assignment]
        logger.info("Reusing existing session %s", session_id)
    else:
        session_id = create_session()

    # -- Build context text from timeline state --------------------------
    context_parts: list[str] = []

    if request.timeline_state is not None:
        context_parts.append(_format_timeline_context(request.timeline_state))

        # Attach video metadata for every asset already on the timeline
        seen_assets: set[str] = set()
        for clip in request.timeline_state.clips:
            if not clip.asset_id or clip.asset_id in seen_assets:
                continue
            seen_assets.add(clip.asset_id)
            meta = video_analyzer.get_metadata(clip.asset_id)
            if meta is not None:
                context_parts.append(_format_video_metadata(meta))

    # -- Build the user message ------------------------------------------
    user_text_parts: list[str] = []
    if context_parts:
        user_text_parts.append(
            "## Current Editor Context\n" + "\n\n".join(context_parts)
        )
    user_text_parts.append(f"## User Request\n{request.prompt}")

    user_message: dict[str, Any] = {
        "role": "user",
        "parts": [{"text": "\n\n".join(user_text_parts)}],
    }

    if existing:
        # Append new user message to existing conversation
        _sessions[session_id].append(user_message)
    else:
        # New session — seed with any prior text history as fallback
        _role_map = {"user": "user", "agent": "model", "assistant": "model", "model": "model"}
        contents: list[dict[str, Any]] = []
        for msg in request.conversation_history:
            gemini_role = _role_map.get(msg.role, "user")
            contents.append({"role": gemini_role, "parts": [{"text": msg.content}]})
        contents.append(user_message)
        _sessions[session_id] = contents

    logger.info(
        "Executing prompt for session %s: %.120s",
        session_id,
        request.prompt,
    )

    response = _call_gemini(session_id, gemini_api_key, http_client)
    return session_id, response


def continue_with_results(
    session_id: str,
    tool_results: list[ToolResult],
    gemini_api_key: str,
    http_client: HTTPClient,
) -> AgentExecuteResponse:
    """Feed frontend tool-execution results back and continue the loop.

    Raises ``KeyError`` if the session does not exist.
    """
    if session_id not in _sessions:
        raise KeyError(f"Unknown session: {session_id}")

    # Append function responses into the conversation
    function_response_parts: list[dict[str, Any]] = []
    for tr in tool_results:
        payload: dict[str, Any] = (
            {"result": tr.result} if tr.success else {"error": tr.error or "unknown error"}
        )
        # Use tool_name for the Gemini function response name; fall back to call_id
        fn_name = tr.tool_name or tr.call_id or "unknown"
        function_response_parts.append(
            {"functionResponse": {"name": fn_name, "response": payload}}
        )

    _sessions[session_id].append(
        {"role": "function", "parts": function_response_parts}
    )

    logger.info(
        "Continuing session %s with %d tool results",
        session_id,
        len(tool_results),
    )

    return _call_gemini(session_id, gemini_api_key, http_client)


# ---------------------------------------------------------------------------
# Core Gemini caller + agentic loop
# ---------------------------------------------------------------------------


def _call_gemini(
    session_id: str,
    api_key: str,
    http_client: HTTPClient,
    _depth: int = 0,
) -> AgentExecuteResponse:
    """Make a single Gemini generateContent call and process the result.

    If only backend tools are requested, they are executed inline and the
    results are fed back (recursive call).  Frontend tool calls are returned
    to the caller.  Recursion is capped at ``_MAX_TURNS``.
    """
    if _depth >= _MAX_TURNS:
        logger.warning(
            "Session %s hit max turns (%d) — forcing completion",
            session_id,
            _MAX_TURNS,
        )
        return AgentExecuteResponse(
            message="I've reached the maximum number of steps. Here's what I've done so far.",
            done=True,
        )

    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{_GEMINI_MODEL}:generateContent?key={api_key}"
    )

    payload: dict[str, Any] = {
        "contents": _sessions[session_id],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "tools": [{"functionDeclarations": tools_to_gemini_declarations()}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 4096},
    }

    # -- HTTP call -------------------------------------------------------
    try:
        response = http_client.post(
            gemini_url,
            headers={"Content-Type": "application/json"},
            json_payload=payload,
            timeout=60,
        )
    except HttpTimeoutError:
        logger.error("Gemini API timed out for session %s", session_id)
        return AgentExecuteResponse(
            message="The AI service timed out. Please try again.",
            done=True,
        )
    except Exception:
        logger.exception("Gemini API request failed for session %s", session_id)
        return AgentExecuteResponse(
            message="Failed to reach the AI service. Please check your connection and try again.",
            done=True,
        )

    if response.status_code != 200:
        logger.error(
            "Gemini API error %d for session %s: %s",
            response.status_code,
            session_id,
            response.text[:500],
        )
        return AgentExecuteResponse(
            message=f"AI service returned an error (HTTP {response.status_code}). Please try again.",
            done=True,
        )

    # -- Parse response --------------------------------------------------
    try:
        body = response.json()
        parts: list[dict[str, Any]] = body["candidates"][0]["content"]["parts"]  # type: ignore[index]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error(
            "Malformed Gemini response for session %s: %s",
            session_id,
            exc,
        )
        return AgentExecuteResponse(
            message="Received an unexpected response from the AI service.",
            done=True,
        )

    # Append the model turn to history
    _sessions[session_id].append(
        {"role": "model", "parts": parts}
    )

    # -- Separate text from function calls --------------------------------
    text_fragments: list[str] = []
    frontend_tool_calls: list[ToolCall] = []
    backend_tool_calls: list[ToolCall] = []

    for part in parts:
        if "text" in part:
            text_fragments.append(part["text"])
        elif "functionCall" in part:
            fc = part["functionCall"]
            tool_name: str = fc.get("name", "")
            arguments: dict[str, Any] = fc.get("args", {})

            tool_def = TOOLS_BY_NAME.get(tool_name)
            if tool_def is None:
                logger.warning(
                    "Session %s: Gemini called unknown tool '%s' — skipping",
                    session_id,
                    tool_name,
                )
                continue

            tc = ToolCall(
                tool_name=tool_name,
                arguments=arguments,
                call_id=tool_name,
            )

            if tool_def.execution_target == ExecutionTarget.BACKEND:
                backend_tool_calls.append(tc)
            else:
                frontend_tool_calls.append(tc)

    combined_text = "\n".join(text_fragments).strip()

    # -- No tool calls at all → we're done --------------------------------
    if not frontend_tool_calls and not backend_tool_calls:
        logger.info("Session %s: agent finished (no tool calls)", session_id)
        return AgentExecuteResponse(
            message=combined_text,
            done=True,
        )

    # -- Execute backend tools inline ------------------------------------
    if backend_tool_calls:
        logger.info(
            "Session %s: executing %d backend tool(s) inline",
            session_id,
            len(backend_tool_calls),
        )
        backend_results = [
            _execute_backend_tool(tc) for tc in backend_tool_calls
        ]

        # Feed results back into conversation
        fn_response_parts: list[dict[str, Any]] = []
        for tr in backend_results:
            payload_inner: dict[str, Any] = (
                {"result": tr.result}
                if tr.success
                else {"error": tr.error or "unknown error"}
            )
            fn_response_parts.append(
                {"functionResponse": {"name": tr.call_id, "response": payload_inner}}
            )

        _sessions[session_id].append(
            {"role": "function", "parts": fn_response_parts}
        )

    # -- If there are frontend tool calls, return them to the caller ------
    if frontend_tool_calls:
        logger.info(
            "Session %s: returning %d frontend tool call(s)",
            session_id,
            len(frontend_tool_calls),
        )
        return AgentExecuteResponse(
            plan=combined_text,
            tool_calls=frontend_tool_calls,
            message=combined_text,
            done=False,
        )

    # -- Only backend tools were called — recurse to continue the loop ----
    return _call_gemini(session_id, api_key, http_client, _depth=_depth + 1)


# ---------------------------------------------------------------------------
# Backend tool executor
# ---------------------------------------------------------------------------


def _execute_backend_tool(tool_call: ToolCall) -> ToolResult:
    """Execute a backend-side tool and return the result."""
    logger.info("Executing backend tool: %s(%s)", tool_call.tool_name, tool_call.arguments)

    try:
        if tool_call.tool_name == "get_video_metadata":
            return _handle_get_video_metadata(tool_call)
        else:
            return ToolResult(
                call_id=tool_call.call_id,
                success=False,
                error=f"Unknown backend tool: {tool_call.tool_name}",
            )
    except Exception as exc:
        logger.exception(
            "Backend tool '%s' raised an exception", tool_call.tool_name
        )
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=str(exc),
        )


def _handle_get_video_metadata(tool_call: ToolCall) -> ToolResult:
    """Handle the ``get_video_metadata`` backend tool."""
    asset_id = tool_call.arguments.get("asset_id", "")
    if not asset_id:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: asset_id",
        )

    meta = video_analyzer.get_metadata(asset_id)
    if meta is None:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error=f"No metadata available for asset '{asset_id}'. "
            "The video may not have been analyzed yet.",
        )

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result=meta.model_dump(mode="json"),
    )


# ---------------------------------------------------------------------------
# Context formatters
# ---------------------------------------------------------------------------


def _format_timeline_context(state: TimelineState) -> str:
    """Format a TimelineState into a human-readable string for the LLM."""
    lines: list[str] = [
        f"**Timeline**: {state.track_count} tracks, "
        f"total duration {state.total_duration:.2f}s, "
        f"playhead at {state.playhead_time:.2f}s",
    ]

    if not state.clips:
        lines.append("  (no clips on timeline)")
        return "\n".join(lines)

    lines.append(f"  {len(state.clips)} clip(s):")
    for clip in state.clips:
        linked_str = ""
        if clip.linked_clip_ids:
            linked_str = f"  linked={clip.linked_clip_ids}"
        lines.append(
            f"  - clip_id={clip.id}  asset={clip.asset_id}  "
            f"type={clip.type}  track={clip.track_index}  "
            f"start={clip.start_time:.2f}s  dur={clip.duration:.2f}s  "
            f"trim_start={clip.trim_start:.2f}  trim_end={clip.trim_end:.2f}  "
            f"speed={clip.speed:.2f}x{linked_str}"
        )

    return "\n".join(lines)


def _format_video_metadata(meta: VideoMetadata) -> str:
    """Format VideoMetadata into a human-readable string for the LLM."""
    lines: list[str] = [
        f"**Video Metadata for asset {meta.asset_id}**:",
        f"  duration={meta.duration:.2f}s  "
        f"resolution={meta.resolution[0]}x{meta.resolution[1]}  "
        f"fps={meta.fps:.1f}  status={meta.analysis_status.value}",
    ]

    if meta.summary:
        lines.append(f"  Summary: {meta.summary}")

    if meta.scenes:
        lines.append(f"  {len(meta.scenes)} scene(s):")
        for i, scene in enumerate(meta.scenes, 1):
            lines.append(
                f"    Scene {i}: {scene.start_time:.2f}s–{scene.end_time:.2f}s  "
                f"importance={scene.importance:.2f}  shot={scene.shot_type}  "
                f"desc=\"{scene.description}\""
            )
            if scene.actions:
                lines.append(f"      actions: {', '.join(scene.actions)}")

    if meta.dialogue:
        lines.append(f"  {len(meta.dialogue)} dialogue line(s):")
        for dl in meta.dialogue:
            speaker = f"[{dl.speaker}] " if dl.speaker else ""
            lines.append(
                f"    {dl.start_time:.2f}s–{dl.end_time:.2f}s: "
                f"{speaker}\"{dl.text}\""
            )

    return "\n".join(lines)
