"""Gemini function-calling agent for the LTX Desktop agentic editor.

Orchestrates a multi-turn conversation with Gemini 3 Flash, feeding
timeline context and tool definitions so the model can plan and execute
video-editing operations.  Backend tools (e.g. ``get_video_metadata``)
are resolved inline; frontend tools are returned to the React app for
execution.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import OrderedDict
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
from agent import brain as brain_module
from agent import video_analyzer
from agent.scene_decomposer import decompose_to_scenes
from services.http_client.http_client import HTTPClient, HttpTimeoutError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MAX_TURNS = 20
"""Hard ceiling on agentic loop iterations to prevent runaway calls."""

_GEMINI_MODEL = "gemini-3.1-pro-preview"
_FALLBACK_MODEL = "gemini-3-flash-preview"

_ROLE_MAP: dict[str, str] = {"user": "user", "agent": "model", "assistant": "model", "model": "model"}

SYSTEM_PROMPT = """\
You are a senior video editor with years of professional editing experience, \
integrated into the LTX Desktop NLE. You don't just execute literal \
instructions — you think like an editor. You understand pacing, shot \
selection, continuity, and storytelling.

## Your Mindset
- Think about what makes a good edit, not just what the user literally said.
- If the user says "make a short video from these clips", that means: \
select the best moments, trim each shot to its essential action, arrange \
them with good pacing, and close all gaps. Not just dump raw clips onto \
the timeline.
- Take editorial initiative. If a shot has 10 seconds of nothing before \
the action, trim it. If there are gaps between clips, close them.
- Explain your editorial reasoning briefly — "I trimmed the opening 3s of \
dead air" — so the user understands your choices.

## Core Rules

### Linked Clips
Video and audio clips are linked via `linked_clip_ids`. Operations on one \
clip in a linked group automatically apply to ALL siblings. \
**NEVER call the same operation on each clip in a linked group** — that \
doubles the effect. Always operate on just ONE clip from each linked group.

### Timeline Safety
- Only call `duplicate_timeline` when the timeline already has clips the \
user might want to keep. If the timeline is empty or the user is building \
from scratch, skip the duplicate — it just adds clutter.
- Use `create_timeline` when the user wants a fresh, empty timeline \
(e.g. "start a new edit", "create a new timeline"). Use `duplicate_timeline` \
when you need to preserve the current edit as a backup before making \
destructive changes.
- After deleting or trimming clips, ALWAYS close the resulting gaps by \
using `move_clip` to slide subsequent clips left, or use `ripple=true` \
on delete operations. A professional edit has no dead space unless \
intentionally placed.

### Gap Management
After any trim or delete operation, check for gaps between clips on the \
same track. If clips don't butt up against each other, move them to close \
the gaps. The timeline should be tight and continuous.

### Smart Trimming
When trimming shots for a compilation or short edit:
- Use video metadata (scenes, importance scores) to find the best \
moments in each clip.
- Trim from both ends — remove dead air at the start and tail at the end.
- Aim for punchy, well-paced cuts. A 30-second raw clip might only need \
its best 5-8 seconds.
- Match the energy: fast cuts for action, longer holds for emotional beats.

## Available Actions
- Read the current timeline state (provided in context — no need to fetch).
- Fetch video metadata with `get_video_metadata` to understand clip content.
- Query the project brain with `query_project_brain` to find relevant clips.
- Get transcript segments with `get_transcript_segment` for specific time ranges.
- Decompose long videos into scene-based sub-clips with `decompose_video`.
- Create sub-clip assets from decomposition results with `create_subclip_assets`.
- Trim, split, delete, move, and add clips.
- Split all clips at the playhead with `split_at_playhead`.
- Flip clips horizontally/vertically, reverse playback, change speed.
- Add cross-dissolve transitions between adjacent clips.
- Duplicate timeline (only when protecting existing work).
- Create a new empty timeline, rename timelines.
- Set playhead position.

## Project Brain
Your context includes a **Project Brain** — a high-level index of all \
content in this project organized by topic. The brain tells you what \
clips exist and what they contain WITHOUT loading all their detailed \
metadata upfront.

**When asked to create an edit on a specific topic:**
1. Read the brain summary in your context to understand available content.
2. Use `query_project_brain` with the topic/query to find relevant clips.
3. Only call `get_video_metadata` for the specific clips you plan to use.
4. Use `get_transcript_segment` to verify what's said in a specific range.
5. If a long video hasn't been decomposed, use `decompose_video` first, \
then use the resulting sub-clips.

**Critical: Be selective.** A professional editor does NOT use every clip \
that mentions the topic. Pick the strongest 3-5 moments that build a \
narrative arc. Consider:
- Opening: a hook that establishes the topic
- Body: the core content, best quotes, strongest visuals
- Closing: a conclusive or impactful ending
- Pacing: vary shot lengths, avoid monotony

### Sub-clip Assets
Some assets are sub-clips with `parentAssetId`, `sourceIn`, and \
`sourceOut` fields. These are virtual clips carved from longer videos. \
When you add a sub-clip to the timeline via `add_clip_to_timeline`, the \
system automatically sets the correct trim points based on sourceIn/sourceOut. \
The `topics` field on sub-clip assets tells you what they're about.

### Scene-Based Editing (Smart Cuts)
Video metadata provides scene boundaries with timestamps, descriptions, \
and actions — all in **source-media time** (relative to the original file).

To convert a scene timestamp to an absolute **timeline time**:
```
timeline_time = clip.startTime + (scene_time - clip.trimStart) / clip.speed
```

**Workflow for content-based cuts** (e.g. "remove the part where X happens"):
1. Read the video metadata scenes for the relevant clip.
2. Find the scene(s) whose description or actions match the user's request.
3. Convert the scene start/end times to timeline times using the formula.
4. `split_clip` at the entry point (timeline time where the content begins).
5. `split_clip` at the exit point (timeline time where the content ends).
6. After splitting, call `get_timeline_state` to get the new clip IDs.
7. `delete_clip` the middle section with `ripple=true` so the remaining \
clips snap together seamlessly.

This same approach works for "keep only the part where…" (invert: delete \
the sections before and after instead of the middle).

## Long-Form Content Editing (Raw Footage → Short Cut)

When asked to create a short edit from a long video on a specific topic \
(e.g. "make a 30-45s clip about X for Twitter"):

### Step 1: Find the topic in the brain
Use `query_project_brain` with the topic. The brain returns topic segments \
with source time ranges (e.g. "Technical Improvements [414s–1089s]"). \
These tell you WHERE in the video each topic lives.

### Step 2: Read the transcript to find the best quotes
For each matching segment, call `get_transcript_segment` with the time \
range. Look for:
- **A strong hook** (surprising stat, bold claim, engaging question) \
for the opening 3-5 seconds
- **Key content** (the core explanation, best insight, clearest quote) \
for the body
- **A closer** (conclusion, call to action, or punchline) for the ending

### Step 3: Extract specific segments directly to the timeline
Use `add_clip_to_timeline` with `source_in` and `source_out` to place \
ONLY the relevant portions. For a 30-45s Twitter/social cut, you \
typically need **3-5 segments of 6-12 seconds each**. Place them \
sequentially on the timeline starting at 0s.

Example for a 35s edit:
- Segment 1 (hook): 0s–8s on timeline, source_in=485, source_out=493
- Segment 2 (core): 8s–22s on timeline, source_in=950, source_out=964
- Segment 3 (closer): 22s–35s on timeline, source_in=1000, source_out=1013

### Step 4: Arrange for narrative flow
Hook first, core content in the middle, closer at the end. \
Trim dead air from each segment start/end.

### Step 5: Close gaps and polish
After placing all segments, ensure they butt up against each other \
with no dead space. Use `trim_clip` to fine-tune in/out points.

### CRITICAL RULES for long-form editing:
- **NEVER add the entire raw video to the timeline and trim.** \
Always extract specific segments using source_in/source_out.
- **For interview footage**, prioritize segments where the speaker is \
mid-sentence with good energy — NOT pausing, looking away, or \
in between takes. Use scene importance scores (>= 0.7) and avoid \
scenes marked as "medium" shot type with low importance.
- **Multiple segments are required.** A single clip from a 40-minute \
video is never the right answer for a short social cut. Find 3-5 \
strong moments and assemble them.
- **Use the transcript to verify content.** Before adding a segment, \
confirm via `get_transcript_segment` that the speaker is actually \
discussing the requested topic in that range.

## MANDATORY for edits from long videos
When creating a short cut (under 60s) from a long video (over 5min):
- You MUST call `add_clip_to_timeline` at least 3 times with different \
source_in/source_out ranges. One clip is NEVER acceptable.
- You MUST use `get_transcript_segment` to verify content before each add.
- After adding all clips, use `split_clip` to tighten cuts if needed.
- Total timeline duration should match the user's requested length.
- If you find yourself about to finish with only 1 clip on the timeline, \
STOP — go back and add more segments. This is a hard rule.

## Editorial Blade Cuts (Pacing and Rhythm)

After placing clips on the timeline, use `split_clip` to create editorial \
cut points that improve pacing — even within continuous dialogue.

Professional editors blade-cut interview footage every 4-8 seconds to:
- Create visual rhythm and energy
- Allow re-ordering of phrases for better narrative flow
- Remove filler words, pauses, or weak moments between strong quotes

Workflow:
1. Place a segment on the timeline (e.g. a 15s quote).
2. Use `split_clip` at the exact points where you want cuts.
3. Delete the weak sections with `delete_clip(ripple=true)`.
4. The remaining pieces snap together into a tighter edit.

This is the blade/razor tool — the most important tool in professional \
editing. Use it aggressively to tighten every clip on the timeline.

## Professional Editing Principles

You are a versatile editor. Adapt your approach to match what the user asks for:

### Pacing (adapt to the format)
- **Social media / Twitter / Reels**: Fast, punchy. Cuts every 3-8s. \
No silence > 0.5s. High energy throughout. Total 30-60s.
- **Trailer / Promo**: Building momentum. Start slower, accelerate. \
Mix dialogue with action. End on a cliffhanger or bold statement. 60-120s.
- **Documentary / Long-form**: Let moments breathe. Longer holds for \
emotional beats. But still cut dead air and filler words.
- **Cinematic**: Slow, deliberate pacing. Longer shots. Atmosphere over \
information density.

### Structure (every edit needs this)
- **Hook** (first 3 seconds): The most surprising, bold, or intriguing \
moment. For interviews, this is often a quote from the middle or end \
of the conversation that grabs attention. NEVER start with "so...", \
"um...", a pause, or the speaker looking down between takes.
- **Body**: The core content. Arranged for narrative flow — not \
necessarily chronological. Strongest points first, supporting details \
after.
- **Closure**: A conclusive statement, call to action, or forward-looking \
claim. The viewer should feel the video is complete, not cut off. \
Never end mid-sentence or on a filler word.

### Dead Air and Silence
- **Cut all pauses > 0.5s** in fast-paced edits (social, promo).
- **Cut all pauses > 1.5s** in slower formats (documentary).
- If a scene description says "preparing", "between takes", "looking \
at floor", "adjusting", or importance < 0.3 — that's dead air. Skip it.
- Use `get_transcript_segment` to verify the speaker is actively talking \
in your chosen time range before adding it.

### Interview-Specific Rules
- The best quotes are rarely at the start of an answer. Look for the \
moment 10-20s into a response where the speaker hits their stride.
- Multiple takes of the same answer exist in raw footage. Pick the take \
with the highest importance score and best delivery.
- Re-order quotes for narrative impact. Chronological order is rarely \
the best order for a short cut.

## Workflow
1. Timeline state is already in your context. Only call \
`get_timeline_state` if the context is completely missing or you need \
updated clip IDs after splits.
2. If a project brain is in your context, use `query_project_brain` \
to find clips relevant to the user's request BEFORE loading metadata.
3. Call `get_video_metadata` only for clips you actually need.
4. Plan your edit strategy. Think about the final result, not just \
individual operations.
5. If the timeline has existing clips worth preserving, duplicate first.
6. Execute edits in logical order. After trims/deletes, close gaps.
7. Summarize what you did and why — then STOP. Trust tool results.

## Response Style
- Be concise and professional. Brief editorial reasoning, then action.
- After edits, give a short summary and finish immediately.
- If the request is ambiguous, ask one clarifying question.
- Use seconds for all time references.
"""

# ---------------------------------------------------------------------------
# Session storage
# ---------------------------------------------------------------------------

_MAX_SESSIONS = 50
_SESSION_TTL_SECONDS = 1800  # 30 minutes

_sessions: OrderedDict[str, tuple[float, list[dict[str, Any]]]] = OrderedDict()
"""Maps session IDs to (last_access_time, contents) tuples."""


def _evict_stale_sessions() -> None:
    """Remove sessions older than TTL and enforce max session count."""
    now = time.monotonic()
    stale = [
        sid for sid, (ts, _) in _sessions.items()
        if now - ts > _SESSION_TTL_SECONDS
    ]
    for sid in stale:
        del _sessions[sid]
    while len(_sessions) > _MAX_SESSIONS:
        evicted_id, _ = _sessions.popitem(last=False)
        logger.info("Evicted oldest session %s (at capacity)", evicted_id[:8])


def _get_session(session_id: str) -> list[dict[str, Any]] | None:
    """Get session contents, updating access time. Returns None if not found."""
    if session_id not in _sessions:
        return None
    ts, contents = _sessions[session_id]
    _sessions[session_id] = (time.monotonic(), contents)
    _sessions.move_to_end(session_id)
    return contents


def _set_session(session_id: str, contents: list[dict[str, Any]]) -> None:
    """Create or update a session."""
    _sessions[session_id] = (time.monotonic(), contents)


def create_session() -> str:
    """Create a new conversation session and return its UUID."""
    _evict_stale_sessions()
    session_id = uuid.uuid4().hex
    _set_session(session_id, [])
    logger.info("Created agent session %s (total: %d)", session_id, len(_sessions))
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
        and _get_session(request.session_id) is not None
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

    # Inject project brain summary — lazy-build if none exists yet
    if request.project_id:
        project_brain = brain_module.get_brain(request.project_id)
        if project_brain is None:
            all_meta = [
                m for m in video_analyzer._metadata_cache.values()
                if m.analysis_status.value == "complete"
            ]
            if all_meta and gemini_api_key:
                logger.info(
                    "No brain for project %s — building synchronously from %d analyses",
                    request.project_id[:8], len(all_meta),
                )
                project_brain = brain_module.build_brain(
                    request.project_id, all_meta, gemini_api_key, http_client,
                )
        if project_brain is not None:
            context_parts.append(brain_module.format_brain_for_agent(project_brain))

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
        session_contents = _get_session(session_id)
        if session_contents is not None:
            session_contents.append(user_message)
    else:
        # New session — seed with any prior text history as fallback
        contents: list[dict[str, Any]] = []
        for msg in request.conversation_history:
            gemini_role = _ROLE_MAP.get(msg.role, "user")
            contents.append({"role": gemini_role, "parts": [{"text": msg.content}]})
        contents.append(user_message)
        _set_session(session_id, contents)

    logger.info(
        "[agent] session=%s | execute_prompt: %.120s",
        session_id[:8],
        request.prompt,
    )

    t0 = time.monotonic()
    response = _call_gemini(session_id, gemini_api_key, http_client)
    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s | execute_prompt completed in %.1fs (done=%s, tools=%d)",
        session_id[:8],
        elapsed,
        response.done,
        len(response.tool_calls),
    )
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
    session_contents = _get_session(session_id)
    if session_contents is None:
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

    session_contents.append(
        {"role": "function", "parts": function_response_parts}
    )

    result_summary = [
        f"{tr.tool_name}:{'ok' if tr.success else 'FAIL'}"
        for tr in tool_results
    ]
    logger.info(
        "[agent] session=%s | continue_with_results: %s",
        session_id[:8],
        result_summary,
    )

    t0 = time.monotonic()
    response = _call_gemini(session_id, gemini_api_key, http_client)
    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s | continue completed in %.1fs (done=%s, tools=%d)",
        session_id[:8],
        elapsed,
        response.done,
        len(response.tool_calls),
    )
    return response


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
        f"{_GEMINI_MODEL}:generateContent"
    )

    session_contents = _get_session(session_id)
    if session_contents is None:
        return AgentExecuteResponse(
            message="Session expired or not found.",
            done=True,
        )

    num_messages = len(session_contents)
    logger.info(
        "[agent] session=%s turn=%d | calling %s | %d messages",
        session_id[:8],
        _depth,
        _GEMINI_MODEL,
        num_messages,
    )

    payload: dict[str, Any] = {
        "contents": session_contents,
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "tools": [{"functionDeclarations": tools_to_gemini_declarations()}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 16384},
    }

    # -- HTTP call with retry on 503 ------------------------------------
    t0 = time.monotonic()
    response = None
    _MAX_RETRIES = 3
    for _attempt in range(_MAX_RETRIES):
        try:
            response = http_client.post(
                gemini_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=300,
            )
            if response.status_code != 503:
                break
            wait = 5 * (2 ** _attempt)
            logger.warning(
                "[agent] session=%s | Gemini returned 503, retrying in %ds (attempt %d/%d)",
                session_id[:8], wait, _attempt + 1, _MAX_RETRIES,
            )
            time.sleep(wait)
        except HttpTimeoutError:
            elapsed = time.monotonic() - t0
            logger.error("[agent] session=%s | Gemini timed out after %.1fs", session_id[:8], elapsed)
            return AgentExecuteResponse(
                message="The AI service timed out. Please try again.",
                done=True,
            )
        except Exception:
            elapsed = time.monotonic() - t0
            logger.exception("[agent] session=%s | Gemini request failed after %.1fs", session_id[:8], elapsed)
            return AgentExecuteResponse(
                message="Failed to reach the AI service. Please check your connection and try again.",
                done=True,
            )

    if response is None:
        return AgentExecuteResponse(
            message="Failed to reach the AI service after retries.",
            done=True,
        )

    # -- Fallback to Flash if Pro is still returning 503 ------------------
    if response.status_code == 503 and _GEMINI_MODEL != _FALLBACK_MODEL:
        fallback_url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{_FALLBACK_MODEL}:generateContent"
        )
        logger.warning(
            "[agent] session=%s | %s exhausted 503 retries, falling back to %s",
            session_id[:8], _GEMINI_MODEL, _FALLBACK_MODEL,
        )
        try:
            response = http_client.post(
                fallback_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json_payload=payload,
                timeout=300,
            )
        except HttpTimeoutError:
            logger.error("[agent] session=%s | Fallback model also timed out", session_id[:8])
            return AgentExecuteResponse(
                message="The AI service timed out on both primary and fallback models.",
                done=True,
            )
        except Exception:
            logger.exception("[agent] session=%s | Fallback model request failed", session_id[:8])
            return AgentExecuteResponse(
                message="Failed to reach the AI service.",
                done=True,
            )

    elapsed = time.monotonic() - t0
    logger.info(
        "[agent] session=%s turn=%d | Gemini responded HTTP %d in %.1fs (~%.1fKB)",
        session_id[:8],
        _depth,
        response.status_code,
        elapsed,
        len(response.text) / 1024,
    )

    if response.status_code != 200:
        logger.error(
            "[agent] session=%s | Gemini error body: %s",
            session_id[:8],
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
            "[agent] session=%s | malformed Gemini response: %s — body: %s",
            session_id[:8],
            exc,
            response.text[:300],
        )
        return AgentExecuteResponse(
            message="Received an unexpected response from the AI service.",
            done=True,
        )

    # Append the model turn to history
    session_contents = _get_session(session_id)
    if session_contents is not None:
        session_contents.append({"role": "model", "parts": parts})

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

    tool_names_fe = [tc.tool_name for tc in frontend_tool_calls]
    tool_names_be = [tc.tool_name for tc in backend_tool_calls]
    logger.info(
        "[agent] session=%s turn=%d | parsed: text=%d chars, frontend_tools=%s, backend_tools=%s",
        session_id[:8],
        _depth,
        len(combined_text),
        tool_names_fe or "none",
        tool_names_be or "none",
    )

    # -- No tool calls at all → we're done --------------------------------
    if not frontend_tool_calls and not backend_tool_calls:
        logger.info("[agent] session=%s | done (text-only response)", session_id[:8])
        return AgentExecuteResponse(
            message=combined_text,
            done=True,
        )

    # -- Execute backend tools inline ------------------------------------
    if backend_tool_calls:
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

        session_contents_be = _get_session(session_id)
        if session_contents_be is not None:
            session_contents_be.append(
                {"role": "function", "parts": fn_response_parts}
            )

    # -- If there are frontend tool calls, return them to the caller ------
    if frontend_tool_calls:
        logger.info(
            "[agent] session=%s turn=%d | returning %d frontend tool(s) to UI: %s",
            session_id[:8],
            _depth,
            len(frontend_tool_calls),
            [tc.tool_name for tc in frontend_tool_calls],
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

    handlers = {
        "get_video_metadata": _handle_get_video_metadata,
        "query_project_brain": _handle_query_brain,
        "get_transcript_segment": _handle_get_transcript_segment,
        "decompose_video": _handle_decompose_video,
    }

    try:
        handler = handlers.get(tool_call.tool_name)
        if handler is None:
            return ToolResult(
                call_id=tool_call.call_id,
                success=False,
                error=f"Unknown backend tool: {tool_call.tool_name}",
            )
        return handler(tool_call)
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


def _handle_query_brain(tool_call: ToolCall) -> ToolResult:
    """Handle the ``query_project_brain`` backend tool."""
    query = tool_call.arguments.get("query", "")
    if not query:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Missing required argument: query",
        )

    # Search across all project brains (we don't know project_id in the tool call)
    all_results: list[dict] = []
    for project_id in list(brain_module._brains.keys()):
        results = brain_module.query_brain(project_id, query)
        for clip in results:
            entry = clip.model_dump(mode="json")
            # Include source_in/source_out for topic segments so the
            # agent can use them directly with add_clip_to_timeline
            if clip.is_topic_segment and clip.source_in is not None:
                entry["source_time_range"] = {
                    "source_in": clip.source_in,
                    "source_out": clip.source_out,
                }
            all_results.append(entry)

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "query": query,
            "matches": all_results[:20],
            "total_matches": len(all_results),
        },
    )


def _handle_get_transcript_segment(tool_call: ToolCall) -> ToolResult:
    """Handle the ``get_transcript_segment`` backend tool."""
    asset_id = tool_call.arguments.get("asset_id", "")
    start_time = float(tool_call.arguments.get("start_time", 0))
    end_time = float(tool_call.arguments.get("end_time", 0))

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
            error=f"No metadata for asset '{asset_id}'.",
        )

    lines = []
    for dl in meta.dialogue:
        if dl.end_time > start_time and dl.start_time < end_time:
            speaker = f"[{dl.speaker}] " if dl.speaker else ""
            lines.append(f"{dl.start_time:.1f}s: {speaker}{dl.text}")

    transcript = "\n".join(lines) if lines else "(no dialogue in this range)"

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "asset_id": asset_id,
            "start_time": start_time,
            "end_time": end_time,
            "transcript": transcript,
            "line_count": len(lines),
        },
    )


def _handle_decompose_video(tool_call: ToolCall) -> ToolResult:
    """Handle the ``decompose_video`` backend tool."""
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
            error=f"No metadata for asset '{asset_id}'. Analyze the video first.",
        )

    if not meta.scenes:
        return ToolResult(
            call_id=tool_call.call_id,
            success=False,
            error="Video has no detected scenes to decompose.",
        )

    subclip_defs = decompose_to_scenes(meta)
    subclips = [
        {
            "parent_asset_id": sc.parent_asset_id,
            "source_in": sc.source_in,
            "source_out": sc.source_out,
            "title": sc.title,
            "description": sc.description,
            "transcript": sc.transcript,
            "topics": sc.topics,
        }
        for sc in subclip_defs
    ]

    return ToolResult(
        call_id=tool_call.call_id,
        success=True,
        result={
            "asset_id": asset_id,
            "subclips": subclips,
            "count": len(subclips),
        },
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
