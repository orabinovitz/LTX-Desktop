# Agentic Prompt Editor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an LLM-powered prompt box (Cmd+Space) to LTX Desktop that lets users edit video via natural language, starting with intelligent video shortening.

**Architecture:** Hybrid — Gemini function calling in Python backend plans edits, React frontend executes tool calls against existing timeline hooks. MCP-inspired tool registry with two layers (atomic + composite). Background video analysis pipeline generates smart metadata per asset.

**Tech Stack:** React 18 + TypeScript (frontend), Python 3.12 + FastAPI + Gemini 2.0 Flash (backend), Electron IPC bridge

**Design Doc:** `docs/plans/2026-02-25-agentic-prompt-editor-design.md`

---

## Task 1: Backend — Agent Types (Pydantic Models)

**Files:**
- Create: `backend/agent/__init__.py`
- Create: `backend/agent/types.py`

**Step 1: Create the agent module and type definitions**

Create `backend/agent/__init__.py` (empty file).

Create `backend/agent/types.py`:

```python
"""Pydantic models for the agentic prompt editor."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# --- Video Analysis Types ---

class SceneSegment(BaseModel):
    start_time: float = Field(description="Start timecode in seconds")
    end_time: float = Field(description="End timecode in seconds")
    description: str = Field(description="What happens in this scene")
    actions: list[str] = Field(default_factory=list, description="Key actions")
    shot_type: str = Field(default="unknown", description="wide/medium/close-up/etc")
    importance: float = Field(default=0.5, ge=0.0, le=1.0, description="0-1 importance rating")


class DialogueLine(BaseModel):
    start_time: float
    end_time: float
    speaker: str = "Unknown"
    text: str


class AnalysisStatus(str, Enum):
    PENDING = "pending"
    ANALYZING = "analyzing"
    COMPLETE = "complete"
    FAILED = "failed"


class VideoMetadata(BaseModel):
    asset_id: str
    duration: float = 0.0
    resolution: tuple[int, int] = (0, 0)
    fps: float = 0.0
    scenes: list[SceneSegment] = Field(default_factory=list)
    dialogue: list[DialogueLine] = Field(default_factory=list)
    summary: str = ""
    analysis_status: AnalysisStatus = AnalysisStatus.PENDING


# --- Tool Registry Types ---

class ExecutionTarget(str, Enum):
    FRONTEND = "frontend"
    BACKEND = "backend"


class ToolParameter(BaseModel):
    type: str
    description: str = ""
    enum: list[str] | None = None


class ToolDefinition(BaseModel):
    name: str
    description: str
    parameters: dict[str, ToolParameter] = Field(default_factory=dict)
    execution_target: ExecutionTarget = ExecutionTarget.FRONTEND


# --- Agent Request/Response Types ---

class ToolCall(BaseModel):
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    tool_name: str
    success: bool
    result: Any = None
    error: str | None = None


class TimelineClipInfo(BaseModel):
    """Minimal clip info sent from frontend to backend for agent context."""
    id: str
    asset_id: str | None = None
    type: str
    start_time: float
    duration: float
    trim_start: float = 0.0
    trim_end: float = 0.0
    track_index: int = 0
    speed: float = 1.0


class TimelineState(BaseModel):
    clips: list[TimelineClipInfo] = Field(default_factory=list)
    track_count: int = 1
    total_duration: float = 0.0
    playhead_time: float = 0.0


class AgentMessage(BaseModel):
    role: str  # "user" or "agent"
    content: str


class AgentExecuteRequest(BaseModel):
    prompt: str
    timeline_state: TimelineState
    conversation_history: list[AgentMessage] = Field(default_factory=list)


class AgentExecuteResponse(BaseModel):
    plan: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    message: str = ""
    done: bool = False


class AgentContinueRequest(BaseModel):
    """Send tool execution results back to continue the agentic loop."""
    tool_results: list[ToolResult]
    conversation_history: list[AgentMessage] = Field(default_factory=list)
    session_id: str


class AnalyzeVideoRequest(BaseModel):
    asset_id: str
    file_path: str
    duration: float | None = None


class AnalyzeVideoResponse(BaseModel):
    status: str
    metadata: VideoMetadata | None = None
```

**Step 2: Commit**

```bash
git add backend/agent/__init__.py backend/agent/types.py
git commit -m "feat(agent): add Pydantic models for agentic prompt editor"
```

---

## Task 2: Backend — Tool Registry

**Files:**
- Create: `backend/agent/tool_registry.py`

**Step 1: Create the tool registry**

```python
"""MCP-inspired tool registry for the agentic prompt editor.

Defines all tools the LLM agent can call, with schemas that convert
to Gemini function declarations.
"""

from __future__ import annotations

from .types import ExecutionTarget, ToolDefinition, ToolParameter


def _p(type_: str, desc: str, **kwargs: object) -> ToolParameter:
    return ToolParameter(type=type_, description=desc, **kwargs)


# === Atomic Tools (frontend execution — map to React hooks) ===

GET_TIMELINE_STATE = ToolDefinition(
    name="get_timeline_state",
    description=(
        "Get the current timeline state including all clips with their "
        "positions, durations, trim points, track assignments, and the "
        "playhead position. Use this to understand what's on the timeline."
    ),
    parameters={},
    execution_target=ExecutionTarget.FRONTEND,
)

TRIM_CLIP = ToolDefinition(
    name="trim_clip",
    description=(
        "Trim a clip by adjusting how much of the source is shown. "
        "trim_start_delta trims from the beginning (positive = shorter), "
        "trim_end_delta trims from the end (positive = shorter). "
        "The clip's position on the timeline does not change."
    ),
    parameters={
        "clip_id": _p("string", "ID of the clip to trim"),
        "trim_start_delta": _p("number", "Seconds to trim from start (positive = remove from start)"),
        "trim_end_delta": _p("number", "Seconds to trim from end (positive = remove from end)"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

SPLIT_CLIP = ToolDefinition(
    name="split_clip",
    description=(
        "Split a clip into two separate clips at a specific timecode. "
        "Creates two clips: one before and one after the split point. "
        "Both clips maintain their track position."
    ),
    parameters={
        "clip_id": _p("string", "ID of the clip to split"),
        "time": _p("number", "Timecode in seconds where to split"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

DELETE_CLIP = ToolDefinition(
    name="delete_clip",
    description=(
        "Delete a clip from the timeline. If ripple is true, subsequent "
        "clips on the same track slide left to fill the gap."
    ),
    parameters={
        "clip_id": _p("string", "ID of the clip to delete"),
        "ripple": _p("boolean", "If true, close the gap left by deletion"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

MOVE_CLIP = ToolDefinition(
    name="move_clip",
    description=(
        "Move a clip to a new position on the timeline. "
        "Can change both the start time and the track."
    ),
    parameters={
        "clip_id": _p("string", "ID of the clip to move"),
        "new_start_time": _p("number", "New start time in seconds"),
        "new_track_index": _p("integer", "Target track index (0-based, 0 = top)"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

ADD_CLIP = ToolDefinition(
    name="add_clip_to_timeline",
    description=(
        "Add an asset from the project bin to the timeline at a specific "
        "position. Optionally set in/out points to use only part of the source."
    ),
    parameters={
        "asset_id": _p("string", "ID of the asset to add"),
        "track_index": _p("integer", "Track index (0-based)"),
        "start_time": _p("number", "Start time on timeline in seconds"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

SET_PLAYHEAD = ToolDefinition(
    name="set_playhead",
    description="Move the playhead to a specific timecode.",
    parameters={
        "time": _p("number", "Target timecode in seconds"),
    },
    execution_target=ExecutionTarget.FRONTEND,
)

DUPLICATE_TIMELINE = ToolDefinition(
    name="duplicate_timeline",
    description=(
        "Create a snapshot/copy of the current timeline before making edits. "
        "This lets the user compare or revert. Always call this before "
        "making destructive edits."
    ),
    parameters={},
    execution_target=ExecutionTarget.FRONTEND,
)

GET_PROJECT_ASSETS = ToolDefinition(
    name="get_project_assets",
    description=(
        "List all assets in the project bin with their type, duration, "
        "and ID. Use this to understand what media is available."
    ),
    parameters={},
    execution_target=ExecutionTarget.FRONTEND,
)

# === Resource Tools (backend execution) ===

GET_VIDEO_METADATA = ToolDefinition(
    name="get_video_metadata",
    description=(
        "Get smart analysis of a video asset: scene-by-scene descriptions "
        "with timecodes, importance ratings, dialogue transcript, shot types. "
        "Use this to understand what happens in the video content."
    ),
    parameters={
        "asset_id": _p("string", "ID of the video asset to analyze"),
    },
    execution_target=ExecutionTarget.BACKEND,
)


# === All tools for registry ===

ALL_TOOLS: list[ToolDefinition] = [
    GET_TIMELINE_STATE,
    TRIM_CLIP,
    SPLIT_CLIP,
    DELETE_CLIP,
    MOVE_CLIP,
    ADD_CLIP,
    SET_PLAYHEAD,
    DUPLICATE_TIMELINE,
    GET_PROJECT_ASSETS,
    GET_VIDEO_METADATA,
]


def tools_to_gemini_declarations() -> list[dict]:
    """Convert tool registry to Gemini function calling format."""
    declarations = []
    for tool in ALL_TOOLS:
        properties = {}
        required = []
        for param_name, param in tool.parameters.items():
            prop: dict = {"type": param.type, "description": param.description}
            if param.enum:
                prop["enum"] = param.enum
            properties[param_name] = prop
            required.append(param_name)

        decl: dict = {
            "name": tool.name,
            "description": tool.description,
        }
        if properties:
            decl["parameters"] = {
                "type": "object",
                "properties": properties,
                "required": required,
            }
        declarations.append(decl)
    return declarations
```

**Step 2: Commit**

```bash
git add backend/agent/tool_registry.py
git commit -m "feat(agent): add MCP-inspired tool registry with Gemini schema conversion"
```

---

## Task 3: Backend — Video Analyzer

**Files:**
- Create: `backend/agent/video_analyzer.py`

**Step 1: Create the video analyzer**

This module handles background video analysis using Gemini Vision.

```python
"""Video understanding pipeline using Gemini Vision.

Analyzes video files to extract scene descriptions, actions,
dialogue, and importance ratings at each timecode.
"""

from __future__ import annotations

import base64
import json
import logging
import subprocess
import threading
from pathlib import Path
from typing import Any

from .types import (
    AnalysisStatus,
    DialogueLine,
    SceneSegment,
    VideoMetadata,
)

logger = logging.getLogger(__name__)

# In-memory cache of analyzed videos (keyed by asset_id)
_metadata_cache: dict[str, VideoMetadata] = {}
_cache_lock = threading.Lock()

ANALYSIS_PROMPT = """\
Analyze this video thoroughly. Return a JSON object with this exact structure:

{
  "summary": "One paragraph describing the overall video content",
  "scenes": [
    {
      "start_time": 0.0,
      "end_time": 5.2,
      "description": "What happens in this scene",
      "actions": ["action1", "action2"],
      "shot_type": "wide|medium|close-up|aerial|pov|tracking",
      "importance": 0.8
    }
  ],
  "dialogue": [
    {
      "start_time": 1.0,
      "end_time": 3.5,
      "speaker": "Speaker 1",
      "text": "What they said"
    }
  ]
}

Rules:
- Break the video into distinct scenes/segments (at least every 5-10 seconds)
- importance is 0.0 to 1.0 where 1.0 = most compelling/essential content
- Include ALL dialogue with accurate timecodes
- If no dialogue, return empty dialogue array
- shot_type should be one of: wide, medium, close-up, aerial, pov, tracking, static
- Return ONLY valid JSON, no markdown or explanation
"""


def get_metadata(asset_id: str) -> VideoMetadata | None:
    """Get cached metadata for an asset. Returns None if not yet analyzed."""
    with _cache_lock:
        return _metadata_cache.get(asset_id)


def get_structural_metadata(file_path: str) -> dict[str, Any]:
    """Extract duration, resolution, fps using ffprobe (fast, local)."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format", "-show_streams",
                file_path,
            ],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        video_stream = next(
            (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
            {},
        )
        return {
            "duration": float(data.get("format", {}).get("duration", 0)),
            "width": int(video_stream.get("width", 0)),
            "height": int(video_stream.get("height", 0)),
            "fps": _parse_fps(video_stream.get("r_frame_rate", "0/1")),
        }
    except Exception:
        logger.exception("ffprobe failed for %s", file_path)
        return {"duration": 0, "width": 0, "height": 0, "fps": 0}


def _parse_fps(rate_str: str) -> float:
    try:
        num, den = rate_str.split("/")
        return round(int(num) / int(den), 2) if int(den) > 0 else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


def analyze_video_background(
    asset_id: str,
    file_path: str,
    gemini_api_key: str,
    http_client: Any,
) -> None:
    """Start background video analysis. Non-blocking — runs in a thread."""
    # Set status to analyzing
    with _cache_lock:
        _metadata_cache[asset_id] = VideoMetadata(
            asset_id=asset_id,
            analysis_status=AnalysisStatus.ANALYZING,
        )

    thread = threading.Thread(
        target=_run_analysis,
        args=(asset_id, file_path, gemini_api_key, http_client),
        daemon=True,
    )
    thread.start()


def _run_analysis(
    asset_id: str,
    file_path: str,
    gemini_api_key: str,
    http_client: Any,
) -> None:
    """Run the full analysis pipeline in a background thread."""
    try:
        # Phase 1: structural metadata (local, fast)
        structural = get_structural_metadata(file_path)

        # Phase 2: Gemini vision analysis
        gemini_result = _call_gemini_video(file_path, gemini_api_key, http_client)

        # Build final metadata
        metadata = VideoMetadata(
            asset_id=asset_id,
            duration=structural["duration"],
            resolution=(structural["width"], structural["height"]),
            fps=structural["fps"],
            scenes=[SceneSegment(**s) for s in gemini_result.get("scenes", [])],
            dialogue=[DialogueLine(**d) for d in gemini_result.get("dialogue", [])],
            summary=gemini_result.get("summary", ""),
            analysis_status=AnalysisStatus.COMPLETE,
        )

        with _cache_lock:
            _metadata_cache[asset_id] = metadata

        logger.info("Video analysis complete for asset %s", asset_id)

    except Exception:
        logger.exception("Video analysis failed for asset %s", asset_id)
        with _cache_lock:
            existing = _metadata_cache.get(asset_id, VideoMetadata(asset_id=asset_id))
            existing.analysis_status = AnalysisStatus.FAILED
            _metadata_cache[asset_id] = existing


def _call_gemini_video(
    file_path: str,
    api_key: str,
    http_client: Any,
) -> dict:
    """Call Gemini 2.0 Flash with video file for content analysis."""
    # Read and encode video file
    video_bytes = Path(file_path).read_bytes()
    video_b64 = base64.b64encode(video_bytes).decode("utf-8")

    # Determine MIME type
    suffix = Path(file_path).suffix.lower()
    mime_map = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
    mime_type = mime_map.get(suffix, "video/mp4")

    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={api_key}"
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": mime_type, "data": video_b64}},
                    {"text": ANALYSIS_PROMPT},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    response = http_client.post(
        gemini_url,
        headers={"Content-Type": "application/json"},
        json_payload=payload,
        timeout=120,  # video analysis can take longer
    )

    if response.status_code != 200:
        raise RuntimeError(f"Gemini API error {response.status_code}: {response.text}")

    # Parse response — Gemini returns JSON directly with responseMimeType
    resp_data = response.json()
    text = resp_data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)
```

**Step 2: Commit**

```bash
git add backend/agent/video_analyzer.py
git commit -m "feat(agent): add video understanding pipeline with Gemini Vision"
```

---

## Task 4: Backend — Gemini Agent (Function Calling Loop)

**Files:**
- Create: `backend/agent/gemini_agent.py`

**Step 1: Create the agent with function calling**

```python
"""Gemini-powered agent with function calling for video editing.

Manages the agentic loop: receives user prompt, calls Gemini with
tool definitions, returns tool calls for frontend execution, and
continues the loop with tool results.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from .tool_registry import ALL_TOOLS, tools_to_gemini_declarations
from .types import (
    AgentExecuteRequest,
    AgentExecuteResponse,
    AgentMessage,
    ExecutionTarget,
    ToolCall,
    ToolResult,
    VideoMetadata,
)
from . import video_analyzer

logger = logging.getLogger(__name__)

MAX_AGENT_TURNS = 10

SYSTEM_PROMPT = """\
You are an expert video editor assistant integrated into LTX Desktop, a professional \
video editing application. You help users edit their videos through natural language commands.

## Your Capabilities
You can control the video editor timeline by calling tools. You have access to:
- Timeline inspection (see all clips, their positions, durations)
- Clip manipulation (trim, split, delete, move, add)
- Video content understanding (scene descriptions, dialogue, importance ratings)
- Timeline duplication (for non-destructive editing)

## Editing Principles
1. ALWAYS call duplicate_timeline before making destructive edits (splits, deletes, trims)
2. When shortening video, prioritize keeping high-importance scenes
3. Prefer clean cuts at scene boundaries when possible
4. Maintain continuity — don't create jarring jumps
5. When removing content, use ripple delete to close gaps

## Workflow
1. First, call get_timeline_state to understand the current timeline
2. If you need content understanding, call get_video_metadata for relevant assets
3. Plan your edits based on the data
4. Call duplicate_timeline to create a safe copy
5. Execute edits (split, trim, delete, move)
6. Explain what you did and why

## Response Style
- Be concise — explain your plan in 2-3 sentences
- List the key decisions (what to keep, what to cut, and why)
- After editing, summarize the result
"""


# In-memory session storage for multi-turn conversations
_sessions: dict[str, list[dict]] = {}


def create_session() -> str:
    session_id = str(uuid.uuid4())
    _sessions[session_id] = []
    return session_id


def execute_prompt(
    request: AgentExecuteRequest,
    gemini_api_key: str,
    http_client: Any,
) -> tuple[str, AgentExecuteResponse]:
    """Execute an agent prompt. Returns (session_id, response)."""
    session_id = create_session()

    # Build context from timeline state
    context_parts = [
        f"Current timeline: {len(request.timeline_state.clips)} clips, "
        f"total duration: {request.timeline_state.total_duration:.1f}s, "
        f"playhead at: {request.timeline_state.playhead_time:.1f}s",
        "",
        "Clips on timeline:",
    ]
    for clip in request.timeline_state.clips:
        context_parts.append(
            f"  - [{clip.id[:8]}] {clip.type} on track {clip.track_index}: "
            f"{clip.start_time:.1f}s-{clip.start_time + clip.duration:.1f}s "
            f"(duration: {clip.duration:.1f}s, asset: {clip.asset_id or 'none'})"
        )

    # Add video metadata if available
    asset_ids = {c.asset_id for c in request.timeline_state.clips if c.asset_id}
    for aid in asset_ids:
        meta = video_analyzer.get_metadata(aid)
        if meta and meta.scenes:
            context_parts.append(f"\nVideo analysis for asset {aid}:")
            context_parts.append(f"  Summary: {meta.summary}")
            for scene in meta.scenes:
                context_parts.append(
                    f"  [{scene.start_time:.1f}-{scene.end_time:.1f}s] "
                    f"{scene.description} (importance: {scene.importance:.1f})"
                )
            if meta.dialogue:
                context_parts.append("  Dialogue:")
                for line in meta.dialogue:
                    context_parts.append(
                        f"    [{line.start_time:.1f}-{line.end_time:.1f}s] "
                        f"{line.speaker}: {line.text}"
                    )

    full_prompt = "\n".join(context_parts) + f"\n\nUser request: {request.prompt}"

    # Build conversation history for Gemini
    contents: list[dict] = []
    for msg in request.conversation_history:
        role = "user" if msg.role == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg.content}]})
    contents.append({"role": "user", "parts": [{"text": full_prompt}]})

    # Store in session
    _sessions[session_id] = contents

    return session_id, _call_gemini(session_id, gemini_api_key, http_client)


def continue_with_results(
    session_id: str,
    tool_results: list[ToolResult],
    gemini_api_key: str,
    http_client: Any,
) -> AgentExecuteResponse:
    """Continue the agentic loop by feeding tool results back to Gemini."""
    if session_id not in _sessions:
        return AgentExecuteResponse(
            message="Session expired or not found.",
            done=True,
        )

    # Format tool results as function response parts
    result_parts = []
    for tr in tool_results:
        result_parts.append({
            "functionResponse": {
                "name": tr.tool_name,
                "response": {
                    "success": tr.success,
                    "result": tr.result if tr.success else None,
                    "error": tr.error,
                },
            }
        })

    _sessions[session_id].append({"role": "function", "parts": result_parts})

    return _call_gemini(session_id, gemini_api_key, http_client)


def _call_gemini(
    session_id: str,
    api_key: str,
    http_client: Any,
) -> AgentExecuteResponse:
    """Make a Gemini API call with function calling support."""
    gemini_url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={api_key}"
    )

    payload: dict[str, Any] = {
        "contents": _sessions[session_id],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "tools": [{"functionDeclarations": tools_to_gemini_declarations()}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
        },
    }

    response = http_client.post(
        gemini_url,
        headers={"Content-Type": "application/json"},
        json_payload=payload,
        timeout=60,
    )

    if response.status_code != 200:
        logger.error("Gemini API error: %s %s", response.status_code, response.text)
        return AgentExecuteResponse(
            message=f"Gemini API error: {response.status_code}",
            done=True,
        )

    resp_data = response.json()
    candidate = resp_data["candidates"][0]
    parts = candidate["content"]["parts"]

    # Store model response in session
    _sessions[session_id].append({"role": "model", "parts": parts})

    # Parse response — may contain text, function calls, or both
    text_parts = []
    tool_calls = []

    for part in parts:
        if "text" in part:
            text_parts.append(part["text"])
        if "functionCall" in part:
            fc = part["functionCall"]
            tool_calls.append(ToolCall(
                tool_name=fc["name"],
                arguments=fc.get("args", {}),
            ))

    plan = "\n".join(text_parts)
    done = len(tool_calls) == 0  # No more tool calls = agent is done

    # Separate frontend vs backend tool calls
    frontend_calls = []
    backend_results = []

    for tc in tool_calls:
        tool_def = next((t for t in ALL_TOOLS if t.name == tc.tool_name), None)
        if tool_def and tool_def.execution_target == ExecutionTarget.BACKEND:
            # Execute backend tools immediately
            result = _execute_backend_tool(tc)
            backend_results.append(result)
        else:
            frontend_calls.append(tc)

    # If we had backend-only tools, feed results back and continue
    if backend_results and not frontend_calls:
        return continue_with_results(session_id, backend_results, api_key, http_client)

    return AgentExecuteResponse(
        plan=plan,
        tool_calls=frontend_calls,
        message=plan if done else "",
        done=done,
    )


def _execute_backend_tool(tool_call: ToolCall) -> ToolResult:
    """Execute a backend-side tool (e.g., get_video_metadata)."""
    if tool_call.tool_name == "get_video_metadata":
        asset_id = tool_call.arguments.get("asset_id", "")
        metadata = video_analyzer.get_metadata(asset_id)
        if metadata:
            return ToolResult(
                tool_name=tool_call.tool_name,
                success=True,
                result=metadata.model_dump(),
            )
        return ToolResult(
            tool_name=tool_call.tool_name,
            success=False,
            error=f"No metadata available for asset {asset_id}",
        )

    return ToolResult(
        tool_name=tool_call.tool_name,
        success=False,
        error=f"Unknown backend tool: {tool_call.tool_name}",
    )
```

**Step 2: Commit**

```bash
git add backend/agent/gemini_agent.py
git commit -m "feat(agent): add Gemini function calling agent with agentic loop"
```

---

## Task 5: Backend — Agent Handler & Routes

**Files:**
- Create: `backend/handlers/agent_handler.py`
- Create: `backend/_routes/agent.py`
- Modify: `backend/app_handler.py` (add agent handler)
- Modify: `backend/app_factory.py` (include agent router)

**Step 1: Create the agent handler**

```python
"""Handler for agent operations — video analysis and prompt execution."""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

from agent import gemini_agent, video_analyzer
from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    VideoMetadata,
)

if TYPE_CHECKING:
    from state.app_state_types import AppState
    from services.http_client import HTTPClient

logger = logging.getLogger(__name__)


class AgentHandler:
    def __init__(
        self,
        state: AppState,
        lock: threading.RLock,
        http: HTTPClient,
    ) -> None:
        self._state = state
        self._lock = lock
        self._http = http

    def execute(self, request: AgentExecuteRequest) -> AgentExecuteResponse:
        """Execute an agent prompt — start a new agentic session."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AgentExecuteResponse(
                message="Gemini API key not configured. Set it in Settings.",
                done=True,
            )

        session_id, response = gemini_agent.execute_prompt(
            request=request,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        # Attach session_id to response message for frontend to track
        response.message = response.message or ""
        response.plan = response.plan or ""
        # We need to pass session_id back — add it to the response
        # Using a simple approach: include in message metadata
        return AgentExecuteResponse(
            plan=response.plan,
            tool_calls=response.tool_calls,
            message=f"SESSION:{session_id}" if not response.done else response.message,
            done=response.done,
        )

    def continue_session(self, request: AgentContinueRequest) -> AgentExecuteResponse:
        """Continue an agentic session with tool execution results."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AgentExecuteResponse(
                message="Gemini API key not configured.",
                done=True,
            )

        return gemini_agent.continue_with_results(
            session_id=request.session_id,
            tool_results=request.tool_results,
            gemini_api_key=api_key,
            http_client=self._http,
        )

    def analyze_video(self, request: AnalyzeVideoRequest) -> AnalyzeVideoResponse:
        """Start background video analysis."""
        api_key = self._state.app_settings.gemini_api_key
        if not api_key:
            return AnalyzeVideoResponse(status="error: no API key")

        video_analyzer.analyze_video_background(
            asset_id=request.asset_id,
            file_path=request.file_path,
            gemini_api_key=api_key,
            http_client=self._http,
        )
        return AnalyzeVideoResponse(status="analyzing")

    def get_video_metadata(self, asset_id: str) -> VideoMetadata | None:
        """Get cached video metadata."""
        return video_analyzer.get_metadata(asset_id)
```

**Step 2: Create the agent routes**

```python
"""FastAPI routes for the agentic prompt editor."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from agent.types import (
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
)
from app_handler import AppHandler
from dependency import get_state_service

router = APIRouter(prefix="/api", tags=["agent"])


@router.post("/agent/execute", response_model=AgentExecuteResponse)
def route_agent_execute(
    req: AgentExecuteRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.execute(req)


@router.post("/agent/continue", response_model=AgentExecuteResponse)
def route_agent_continue(
    req: AgentContinueRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.continue_session(req)


@router.post("/agent/analyze-video", response_model=AnalyzeVideoResponse)
def route_analyze_video(
    req: AnalyzeVideoRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AnalyzeVideoResponse:
    return handler.agent.analyze_video(req)


@router.get("/agent/video-metadata/{asset_id}")
def route_get_video_metadata(
    asset_id: str,
    handler: AppHandler = Depends(get_state_service),
):
    metadata = handler.agent.get_video_metadata(asset_id)
    if metadata is None:
        return {"status": "not_found"}
    return metadata.model_dump()
```

**Step 3: Register agent handler in AppHandler**

Modify `backend/app_handler.py` — add import and handler registration.

After the existing handler imports (around line 10-20), add:
```python
from handlers.agent_handler import AgentHandler
```

In the `__init__` method, after `self.prompt = PromptHandler(...)` (around line 130-140), add:
```python
self.agent = AgentHandler(
    state=self.state,
    lock=self._lock,
    http=http,
)
```

**Step 4: Register agent router in app_factory.py**

Modify `backend/app_factory.py` — add import and include router.

After the existing router imports (around line 13-20), add:
```python
from _routes.agent import router as agent_router
```

After the last `app.include_router(...)` call (around line 76), add:
```python
app.include_router(agent_router)
```

**Step 5: Commit**

```bash
git add backend/handlers/agent_handler.py backend/_routes/agent.py backend/app_handler.py backend/app_factory.py
git commit -m "feat(agent): add agent handler, routes, and wire into FastAPI DI"
```

---

## Task 6: Frontend — Keyboard Shortcut Registration

**Files:**
- Modify: `src/lib/keyboard-shortcuts.ts` (add `agent.prompt` action + key binding)

**Step 1: Add the action to ActionId union**

In `src/lib/keyboard-shortcuts.ts`, find the `ActionId` type union (line 5-56). Add at the end before the closing:

```typescript
| 'agent.prompt'
```

**Step 2: Add to ACTION_REGISTRY**

In the ACTION_REGISTRY array (line 76-126), add:

```typescript
{ id: 'agent.prompt', label: 'Agent Prompt', category: 'Agent', description: 'Open AI editing prompt box' },
```

**Step 3: Add key binding to all presets**

In LTX_DEFAULT_LAYOUT (lines 148-197), add:
```typescript
'agent.prompt': [k(' ', { meta: true })],
```

In PREMIERE_LAYOUT (lines 202-251), add:
```typescript
'agent.prompt': [k(' ', { meta: true })],
```

In DAVINCI_LAYOUT (lines 256-305), add:
```typescript
'agent.prompt': [k(' ', { meta: true })],
```

In AVID_LAYOUT (lines 310-359), add:
```typescript
'agent.prompt': [k(' ', { meta: true })],
```

**Step 4: Commit**

```bash
git add src/lib/keyboard-shortcuts.ts
git commit -m "feat(agent): register Cmd+Space keyboard shortcut for agent prompt"
```

---

## Task 7: Frontend — Agent API Hook

**Files:**
- Create: `src/hooks/use-agent.ts`

**Step 1: Create the agent API hook**

This hook handles all HTTP communication with the backend agent endpoints.

```typescript
import { useCallback, useRef, useState } from 'react'
import type { TimelineClip, Asset } from '../types/project'

// --- Types matching backend Pydantic models ---

interface TimelineClipInfo {
  id: string
  asset_id: string | null
  type: string
  start_time: number
  duration: number
  trim_start: number
  trim_end: number
  track_index: number
  speed: number
}

interface TimelineState {
  clips: TimelineClipInfo[]
  track_count: number
  total_duration: number
  playhead_time: number
}

interface AgentMessage {
  role: 'user' | 'agent'
  content: string
}

export interface ToolCall {
  tool_name: string
  arguments: Record<string, unknown>
}

interface ToolResult {
  tool_name: string
  success: boolean
  result: unknown
  error: string | null
}

interface AgentResponse {
  plan: string
  tool_calls: ToolCall[]
  message: string
  done: boolean
}

export interface ChatMessage {
  role: 'user' | 'agent'
  content: string
  toolCalls?: ToolCall[]
  isExecuting?: boolean
}

// --- Helper to build timeline state from React state ---

function buildTimelineState(
  clips: TimelineClip[],
  trackCount: number,
  currentTime: number,
): TimelineState {
  const clipInfos: TimelineClipInfo[] = clips.map(c => ({
    id: c.id,
    asset_id: c.assetId,
    type: c.type,
    start_time: c.startTime,
    duration: c.duration,
    trim_start: c.trimStart,
    trim_end: c.trimEnd,
    track_index: c.trackIndex,
    speed: c.speed,
  }))

  const totalDuration = clips.reduce(
    (max, c) => Math.max(max, c.startTime + c.duration),
    0,
  )

  return {
    clips: clipInfos,
    track_count: trackCount,
    total_duration: totalDuration,
    playhead_time: currentTime,
  }
}

// --- Main hook ---

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const conversationRef = useRef<AgentMessage[]>([])

  const sendPrompt = useCallback(async (
    prompt: string,
    clips: TimelineClip[],
    trackCount: number,
    currentTime: number,
    executeTool: (toolCall: ToolCall) => Promise<ToolResult>,
  ) => {
    setIsProcessing(true)

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: prompt }])
    conversationRef.current.push({ role: 'user', content: prompt })

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const timelineState = buildTimelineState(clips, trackCount, currentTime)

      // Initial request
      const res = await fetch(`${backendUrl}/api/agent/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          timeline_state: timelineState,
          conversation_history: conversationRef.current,
        }),
      })

      if (!res.ok) throw new Error(`Agent API error: ${res.status}`)
      let response: AgentResponse = await res.json()

      // Extract session ID from first response
      if (response.message.startsWith('SESSION:')) {
        sessionIdRef.current = response.message.slice(8)
        response.message = ''
      }

      // Agentic loop
      let turns = 0
      while (!response.done && turns < 10) {
        turns++

        // Show plan if present
        if (response.plan) {
          setMessages(prev => [...prev, {
            role: 'agent',
            content: response.plan,
            toolCalls: response.tool_calls,
            isExecuting: true,
          }])
        }

        // Execute frontend tool calls
        const results: ToolResult[] = []
        for (const tc of response.tool_calls) {
          const result = await executeTool(tc)
          results.push(result)
        }

        // Continue the loop with results
        const contRes = await fetch(`${backendUrl}/api/agent/continue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_results: results,
            conversation_history: conversationRef.current,
            session_id: sessionIdRef.current,
          }),
        })

        if (!contRes.ok) throw new Error(`Agent continue error: ${contRes.status}`)
        response = await contRes.json()
      }

      // Final message
      const finalText = response.message || response.plan || 'Done.'
      setMessages(prev => {
        // Replace last "executing" message or add new
        const updated = [...prev]
        if (updated.length > 0 && updated[updated.length - 1].isExecuting) {
          updated[updated.length - 1] = {
            role: 'agent',
            content: finalText,
            isExecuting: false,
          }
        } else {
          updated.push({ role: 'agent', content: finalText })
        }
        return updated
      })
      conversationRef.current.push({ role: 'agent', content: finalText })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages(prev => [...prev, { role: 'agent', content: `Error: ${errorMsg}` }])
    } finally {
      setIsProcessing(false)
    }
  }, [])

  const clearChat = useCallback(() => {
    setMessages([])
    conversationRef.current = []
    sessionIdRef.current = null
  }, [])

  return { messages, isProcessing, sendPrompt, clearChat }
}
```

**Step 2: Commit**

```bash
git add src/hooks/use-agent.ts
git commit -m "feat(agent): add useAgent hook for backend agent API communication"
```

---

## Task 8: Frontend — Agent Tool Executor Hook

**Files:**
- Create: `src/views/editor/useAgentExecutor.ts`

**Step 1: Create the tool executor**

This hook maps agent tool calls to actual React hook calls (the bridge between LLM planning and timeline manipulation).

```typescript
import { useCallback, useRef } from 'react'
import type { TimelineClip, Track, Asset } from '../../types/project'
import type { ToolCall } from '../../hooks/use-agent'

interface ToolResult {
  tool_name: string
  success: boolean
  result: unknown
  error: string | null
}

interface AgentExecutorDeps {
  // State getters (refs for latest values)
  clipsRef: React.RefObject<TimelineClip[]>
  tracksRef: React.RefObject<Track[]>
  assetsRef: React.RefObject<Asset[]>
  currentTimeRef: React.RefObject<number>
  // Clip operations
  splitClipAtPlayhead: (clipId: string, atTime?: number) => void
  removeClip: (clipId: string) => void
  updateClip: (clipId: string, updates: Partial<TimelineClip>) => void
  addClipToTimeline: (asset: Asset, trackIndex?: number, startTime?: number) => void
  // State setters
  setCurrentTime: (time: number) => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
}

export function useAgentExecutor(deps: AgentExecutorDeps) {
  // Store a timeline snapshot for undo
  const snapshotRef = useRef<TimelineClip[] | null>(null)

  const executeTool = useCallback(async (toolCall: ToolCall): Promise<ToolResult> => {
    const { tool_name, arguments: args } = toolCall

    try {
      switch (tool_name) {
        case 'get_timeline_state': {
          const clips = deps.clipsRef.current || []
          const tracks = deps.tracksRef.current || []
          return {
            tool_name,
            success: true,
            result: {
              clips: clips.map(c => ({
                id: c.id,
                asset_id: c.assetId,
                type: c.type,
                start_time: c.startTime,
                duration: c.duration,
                trim_start: c.trimStart,
                trim_end: c.trimEnd,
                track_index: c.trackIndex,
                speed: c.speed,
              })),
              track_count: tracks.length,
              total_duration: clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0),
              playhead_time: deps.currentTimeRef.current || 0,
            },
            error: null,
          }
        }

        case 'trim_clip': {
          const clipId = args.clip_id as string
          const trimStartDelta = (args.trim_start_delta as number) || 0
          const trimEndDelta = (args.trim_end_delta as number) || 0
          const clips = deps.clipsRef.current || []
          const clip = clips.find(c => c.id === clipId)
          if (!clip) return { tool_name, success: false, result: null, error: `Clip ${clipId} not found` }

          deps.updateClip(clipId, {
            trimStart: clip.trimStart + trimStartDelta,
            trimEnd: clip.trimEnd + trimEndDelta,
            duration: clip.duration - trimStartDelta - trimEndDelta,
            startTime: clip.startTime + trimStartDelta,
          })
          return { tool_name, success: true, result: { clip_id: clipId }, error: null }
        }

        case 'split_clip': {
          const clipId = args.clip_id as string
          const time = args.time as number
          deps.splitClipAtPlayhead(clipId, time)
          return { tool_name, success: true, result: { clip_id: clipId, split_at: time }, error: null }
        }

        case 'delete_clip': {
          const clipId = args.clip_id as string
          const ripple = args.ripple as boolean
          if (ripple) {
            // Ripple delete: remove clip and shift subsequent clips
            const clips = deps.clipsRef.current || []
            const clip = clips.find(c => c.id === clipId)
            if (clip) {
              const gapDuration = clip.duration
              const trackIndex = clip.trackIndex
              const startTime = clip.startTime
              deps.removeClip(clipId)
              // Shift subsequent clips on same track
              const subsequent = (deps.clipsRef.current || []).filter(
                c => c.trackIndex === trackIndex && c.startTime >= startTime
              )
              for (const c of subsequent) {
                deps.updateClip(c.id, { startTime: c.startTime - gapDuration })
              }
            }
          } else {
            deps.removeClip(clipId)
          }
          return { tool_name, success: true, result: { clip_id: clipId }, error: null }
        }

        case 'move_clip': {
          const clipId = args.clip_id as string
          const newStartTime = args.new_start_time as number
          const newTrackIndex = args.new_track_index as number
          deps.updateClip(clipId, {
            startTime: newStartTime,
            trackIndex: newTrackIndex,
          })
          return { tool_name, success: true, result: { clip_id: clipId }, error: null }
        }

        case 'add_clip_to_timeline': {
          const assetId = args.asset_id as string
          const trackIndex = args.track_index as number
          const startTime = args.start_time as number
          const assets = deps.assetsRef.current || []
          const asset = assets.find(a => a.id === assetId)
          if (!asset) return { tool_name, success: false, result: null, error: `Asset ${assetId} not found` }
          deps.addClipToTimeline(asset, trackIndex, startTime)
          return { tool_name, success: true, result: { asset_id: assetId }, error: null }
        }

        case 'set_playhead': {
          const time = args.time as number
          deps.setCurrentTime(time)
          return { tool_name, success: true, result: { time }, error: null }
        }

        case 'duplicate_timeline': {
          // Snapshot current clips for potential undo
          snapshotRef.current = JSON.parse(JSON.stringify(deps.clipsRef.current || []))
          return {
            tool_name,
            success: true,
            result: { message: 'Timeline snapshot saved. Edits can be undone.' },
            error: null,
          }
        }

        case 'get_project_assets': {
          const assets = deps.assetsRef.current || []
          return {
            tool_name,
            success: true,
            result: assets.map(a => ({
              id: a.id,
              type: a.type,
              duration: a.duration || 0,
              path: a.path,
              prompt: a.prompt,
            })),
            error: null,
          }
        }

        default:
          return { tool_name, success: false, result: null, error: `Unknown tool: ${tool_name}` }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { tool_name, success: false, result: null, error: msg }
    }
  }, [deps])

  const restoreSnapshot = useCallback(() => {
    if (snapshotRef.current) {
      deps.setClips(snapshotRef.current)
      snapshotRef.current = null
      return true
    }
    return false
  }, [deps])

  return { executeTool, restoreSnapshot }
}
```

**Step 2: Commit**

```bash
git add src/views/editor/useAgentExecutor.ts
git commit -m "feat(agent): add tool executor hook mapping LLM calls to timeline operations"
```

---

## Task 9: Frontend — Agent Prompt Box UI Component

**Files:**
- Create: `src/views/editor/AgentPromptBox.tsx`

**Step 1: Create the prompt box component**

```tsx
import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2, Bot, Undo2 } from 'lucide-react'
import type { ChatMessage } from '../../hooks/use-agent'

interface AgentPromptBoxProps {
  isOpen: boolean
  onClose: () => void
  messages: ChatMessage[]
  isProcessing: boolean
  onSend: (prompt: string) => void
  onUndo: () => void
  canUndo: boolean
}

export function AgentPromptBox({
  isOpen,
  onClose,
  messages,
  isProcessing,
  onSend,
  onUndo,
  canUndo,
}: AgentPromptBoxProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isProcessing) return
    onSend(trimmed)
    setInput('')
  }

  return (
    <div
      className="fixed bottom-24 right-6 z-50 w-96 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl flex flex-col"
      style={{ maxHeight: '60vh' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-blue-400" />
          <span className="text-sm font-medium text-zinc-200">Agent</span>
        </div>
        <div className="flex items-center gap-1">
          {canUndo && (
            <button
              onClick={onUndo}
              className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
              title="Undo agent edits"
            >
              <Undo2 size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-[100px]">
        {messages.length === 0 && (
          <p className="text-zinc-500 text-sm text-center py-4">
            Describe what you'd like to do with your video...
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
            <div
              className={`inline-block px-3 py-2 rounded-lg max-w-[85%] ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-200'
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.isExecuting && (
                <div className="flex items-center gap-2 mt-2 text-blue-400 text-xs">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Executing...</span>
                </div>
              )}
            </div>
          </div>
        ))}
        {isProcessing && messages[messages.length - 1]?.role === 'user' && (
          <div className="text-left">
            <div className="inline-block px-3 py-2 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 size={12} className="animate-spin" />
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-zinc-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="e.g. Shorten this video to 15 seconds"
            disabled={isProcessing}
            className="flex-1 bg-zinc-800 text-zinc-200 text-sm rounded px-3 py-1.5 border border-zinc-600 focus:border-blue-500 focus:outline-none placeholder-zinc-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isProcessing || !input.trim()}
            className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        </div>
      </form>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/views/editor/AgentPromptBox.tsx
git commit -m "feat(agent): add floating prompt box UI component"
```

---

## Task 10: Frontend — Wire Everything into VideoEditor.tsx

**Files:**
- Modify: `src/views/VideoEditor.tsx`
- Modify: `src/views/editor/useEditorKeyboard.ts`

**Step 1: Add imports to VideoEditor.tsx**

At the top of `VideoEditor.tsx` (around line 20-61, with other imports), add:

```typescript
import { AgentPromptBox } from './editor/AgentPromptBox'
import { useAgent } from '../hooks/use-agent'
import { useAgentExecutor } from './editor/useAgentExecutor'
```

**Step 2: Add agent state to VideoEditor.tsx**

After the existing state declarations (around line 170-172), add:

```typescript
const [agentOpen, setAgentOpen] = useState(false)
```

**Step 3: Initialize agent hooks**

After the existing hook calls section (after `useClipOperations` around line 487), add:

```typescript
// Agent hooks
const { messages: agentMessages, isProcessing: agentProcessing, sendPrompt, clearChat } = useAgent()

const assetsRef = useRef(assets)
useEffect(() => { assetsRef.current = assets }, [assets])

const { executeTool, restoreSnapshot } = useAgentExecutor({
  clipsRef,
  tracksRef,
  assetsRef,
  currentTimeRef: playbackTimeRef,
  splitClipAtPlayhead,
  removeClip,
  updateClip,
  addClipToTimeline,
  setCurrentTime,
  setClips,
})

const handleAgentSend = useCallback((prompt: string) => {
  sendPrompt(prompt, clips, tracks.length, currentTime, executeTool)
}, [sendPrompt, clips, tracks.length, currentTime, executeTool])

const handleAgentUndo = useCallback(() => {
  restoreSnapshot()
}, [restoreSnapshot])
```

**Step 4: Add agent prompt toggle to keyboard handler**

In `useEditorKeyboard.ts`, in the switch statement (around line 105-398), add a new case. The exact location depends on where other cases are — add it before the default/closing:

```typescript
case 'agent.prompt':
  setters.setAgentOpen((prev: boolean) => !prev)
  break
```

This requires passing `setAgentOpen` through the setters object. In `VideoEditor.tsx` where `useEditorKeyboard` is called (around line 1067-1125), add `setAgentOpen` to the setters parameter.

**Step 5: Mount AgentPromptBox in the render**

In the return/render section of `VideoEditor.tsx` (around line 1628+), add the AgentPromptBox before the closing `</div>`:

```tsx
<AgentPromptBox
  isOpen={agentOpen}
  onClose={() => setAgentOpen(false)}
  messages={agentMessages}
  isProcessing={agentProcessing}
  onSend={handleAgentSend}
  onUndo={handleAgentUndo}
  canUndo={true}
/>
```

**Step 6: Commit**

```bash
git add src/views/VideoEditor.tsx src/views/editor/useEditorKeyboard.ts
git commit -m "feat(agent): wire agent prompt box into video editor with Cmd+Space shortcut"
```

---

## Task 11: Backend — Trigger Video Analysis on Asset Import

**Files:**
- Modify: Frontend code that handles asset import (need to add a call to `/api/agent/analyze-video` after each video import)

**Step 1: Add analysis trigger**

In `src/hooks/use-agent.ts`, add an export function:

```typescript
export async function triggerVideoAnalysis(assetId: string, filePath: string) {
  try {
    const backendUrl = await window.electronAPI.getBackendUrl()
    await fetch(`${backendUrl}/api/agent/analyze-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: assetId, file_path: filePath }),
    })
  } catch (err) {
    console.warn('Video analysis trigger failed:', err)
  }
}
```

**Step 2: Call it after asset import**

In `VideoEditor.tsx` or wherever assets are added to the project, after a video asset is created, call:

```typescript
import { triggerVideoAnalysis } from '../hooks/use-agent'

// After asset is created:
if (asset.type === 'video' && asset.path) {
  triggerVideoAnalysis(asset.id, asset.path)
}
```

The exact location depends on how assets are imported — look for where `handleImportFile` is called or where assets are pushed into state. This should be added in the asset creation flow in `useClipOperations.ts` or `VideoEditor.tsx`.

**Step 3: Commit**

```bash
git add src/hooks/use-agent.ts src/views/VideoEditor.tsx
git commit -m "feat(agent): trigger background video analysis on asset import"
```

---

## Task 12: Integration Testing — End-to-End Smoke Test

**Step 1: Start the app in dev mode**

```bash
cd ~/Projects/ltx-desktop/ltx-video && npm run electron:dev
```

**Step 2: Manual test checklist**

- [ ] App starts without errors
- [ ] Press Cmd+Space → agent prompt box appears
- [ ] Press Escape → prompt box closes
- [ ] Press Cmd+Space again → toggles open/closed
- [ ] Import a video file → check backend logs for analysis starting
- [ ] Type "shorten this video to 15 seconds" → verify:
  - [ ] Message appears in chat
  - [ ] "Thinking..." indicator shows
  - [ ] Agent responds with a plan
  - [ ] Tool calls execute (clips get modified)
  - [ ] Summary message appears when done
- [ ] Click undo button → timeline restores to pre-edit state

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix(agent): address integration testing issues"
```

---

## Summary

| Task | Component | Est. Complexity |
|------|-----------|----------------|
| 1 | Backend types (Pydantic) | Low |
| 2 | Tool registry | Medium |
| 3 | Video analyzer | Medium |
| 4 | Gemini agent loop | High |
| 5 | Handler + routes + DI wiring | Medium |
| 6 | Keyboard shortcut | Low |
| 7 | Frontend agent API hook | Medium |
| 8 | Frontend tool executor | High |
| 9 | Prompt box UI | Medium |
| 10 | Wire into VideoEditor | Medium |
| 11 | Analysis trigger on import | Low |
| 12 | Integration testing | Medium |

**Total: 12 tasks, ~2-3 hours of focused implementation**
