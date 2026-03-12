"""Pydantic models for the agentic prompt editor."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ============================================================
# Video Analysis
# ============================================================


class AnalysisStatus(str, Enum):
    """Status of a video analysis job."""

    PENDING = "pending"
    ANALYZING = "analyzing"
    COMPLETE = "complete"
    FAILED = "failed"


class SceneSegment(BaseModel):
    """A detected scene within a video."""

    start_time: float = Field(description="Scene start in seconds")
    end_time: float = Field(description="Scene end in seconds")
    description: str = Field(description="Natural-language description of the scene")
    actions: list[str] = Field(default_factory=list, description="Key actions occurring in the scene")
    shot_type: str = Field(default="", description="Camera shot type (e.g. wide, close-up, medium)")
    importance: float = Field(default=0.5, ge=0.0, le=1.0, description="Scene importance score 0-1")


class DialogueLine(BaseModel):
    """A single line of detected dialogue / speech."""

    start_time: float = Field(description="Dialogue start in seconds")
    end_time: float = Field(description="Dialogue end in seconds")
    speaker: str = Field(default="", description="Speaker identifier")
    text: str = Field(description="Transcribed text")


class TopicTag(BaseModel):
    """A thematic topic detected within a video."""

    name: str = Field(description="Short topic name")
    description: str = Field(default="", description="One-sentence description of the topic")
    time_ranges: list[tuple[float, float]] = Field(
        default_factory=list,
        description="List of (start, end) time ranges in seconds where this topic appears",
    )


class VideoMetadata(BaseModel):
    """Full analysis metadata for a video asset."""

    asset_id: str = Field(description="Unique asset identifier")
    duration: float = Field(description="Video duration in seconds")
    resolution: tuple[int, int] = Field(description="(width, height) in pixels")
    fps: float = Field(description="Frames per second")
    scenes: list[SceneSegment] = Field(default_factory=list)
    dialogue: list[DialogueLine] = Field(default_factory=list)
    summary: str = Field(default="", description="High-level summary of the video")
    topics: list[TopicTag] = Field(default_factory=list, description="Thematic topics detected in the video")
    full_transcript: str = Field(default="", description="Complete transcript of all dialogue")
    analysis_status: AnalysisStatus = Field(default=AnalysisStatus.PENDING)
    analysis_version: int = Field(default=1, description="Schema version for cache invalidation")


# ============================================================
# Tool Registry
# ============================================================


class ExecutionTarget(str, Enum):
    """Where a tool's action is executed."""

    FRONTEND = "frontend"
    BACKEND = "backend"


class ToolParameter(BaseModel):
    """Schema for a single parameter accepted by a tool."""

    name: str
    type: str = Field(description="JSON Schema type (string, number, boolean, array, …)")
    description: str = ""
    required: bool = True
    items: dict[str, Any] | None = Field(
        default=None,
        description="JSON Schema for array element type (required when type='array')",
    )


class ToolDefinition(BaseModel):
    """Describes a tool the agent can invoke."""

    name: str = Field(description="Unique tool name")
    description: str = Field(description="What the tool does")
    parameters: list[ToolParameter] = Field(default_factory=list)
    execution_target: ExecutionTarget = Field(default=ExecutionTarget.FRONTEND)
    category: str = Field(default="core", description="Tool category for knowledge-base routing")


# ============================================================
# Agent API
# ============================================================


class ToolCall(BaseModel):
    """A single tool invocation requested by the agent."""

    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    call_id: str = Field(default="", description="Unique ID to correlate with ToolResult")


class ToolResult(BaseModel):
    """Result of executing a ToolCall."""

    tool_name: str = Field(default="", description="Name of the tool that was called")
    call_id: str = Field(default="", description="Correlates with ToolCall.call_id")
    success: bool = True
    result: Any = None
    error: str | None = None


class TimelineClipInfo(BaseModel):
    """Minimal clip information for agent context."""

    id: str
    asset_id: str | None = None
    type: str = Field(description="Clip type (video, audio, image, …)")
    start_time: float = Field(description="Position on timeline in seconds")
    duration: float
    trim_start: float = 0.0
    trim_end: float = 0.0
    track_index: int = 0
    speed: float = 1.0
    linked_clip_ids: list[str] = Field(default_factory=list, description="IDs of linked clips (e.g. video<->audio pairs)")
    volume: float = Field(default=1.0, description="Clip volume (0.0 to 1.0)")
    muted: bool = Field(default=False, description="Whether clip audio is muted")


class TimelineState(BaseModel):
    """Snapshot of the current timeline sent to the agent."""

    clips: list[TimelineClipInfo] = Field(default_factory=list)
    track_count: int = 0
    total_duration: float = 0.0
    playhead_time: float = 0.0


class AgentMessage(BaseModel):
    """A single message in the agent conversation history."""

    role: str = Field(description="'user', 'assistant', or 'tool'")
    content: str


class ViewContext(str, Enum):
    """Which view the agent is being used from."""

    EDITOR = "editor"
    GENSPACE = "genspace"
    PLAYGROUND = "playground"


class AgentExecuteRequest(BaseModel):
    """Initial request from the frontend to the agent."""

    prompt: str = Field(description="User's natural-language instruction", max_length=10000)
    timeline_state: TimelineState | None = None
    assets_context: dict[str, object] | None = Field(default=None, description="Structured view context from the active UI (GenSpace assets, mode, etc.)")
    conversation_history: list[AgentMessage] = Field(default_factory=list, max_length=100)
    session_id: str | None = Field(default=None, description="Existing session to continue conversation in")
    project_id: str | None = Field(default=None, description="Project ID for brain context lookup")
    view_context: ViewContext = Field(default=ViewContext.EDITOR, description="Which app view the agent is opened from")


class AgentExecuteResponse(BaseModel):
    """Response from the agent after planning / execution."""

    plan: str = Field(default="", description="Human-readable plan description")
    tool_calls: list[ToolCall] = Field(default_factory=list)
    message: str = Field(default="", description="Message to display to the user")
    done: bool = Field(default=False, description="True when the agent has finished all steps")
    session_id: str = Field(default="", description="Session ID for continuing the conversation")


class AgentContinueRequest(BaseModel):
    """Follow-up request carrying tool results back to the agent."""

    tool_results: list[ToolResult] = Field(default_factory=list)
    session_id: str | None = Field(default="", description="Identifies the ongoing agent session")
    updated_context: str | None = Field(default=None, description="Optional updated state context injected after mutations")


class AnalyzeVideoRequest(BaseModel):
    """Request to start video analysis."""

    asset_id: str
    file_path: str
    duration: float | None = None
    project_save_path: str | None = None
    force: bool = False


class AnalyzeVideoResponse(BaseModel):
    """Response from video analysis endpoint."""

    status: AnalysisStatus
    metadata: VideoMetadata | None = None


class SubClipInfo(BaseModel):
    """A sub-clip definition returned by the decompose endpoint."""

    parent_asset_id: str
    source_in: float
    source_out: float
    title: str
    description: str
    transcript: str = ""
    topics: list[str] = Field(default_factory=list)
    scene_indices: list[int] = Field(default_factory=list)


class DecomposeVideoResponse(BaseModel):
    """Response from the video decomposition endpoint."""

    subclips: list[SubClipInfo] = Field(default_factory=list)
    error: str | None = None


# ============================================================
# Live API
# ============================================================


class LiveTokenResponse(BaseModel):
    """Ephemeral token for client-side Live API connections."""

    token: str = Field(description="Short-lived token name for WebSocket auth")
    expire_time: str = Field(description="ISO-8601 expiry timestamp")
    model: str = Field(description="Model to use with the token")


class LiveConfigResponse(BaseModel):
    """Configuration for client-side Live API sessions."""

    system_prompt: str = Field(description="System instruction for the agent")
    tools: list[dict[str, object]] = Field(description="Gemini function declarations")
    model: str = Field(description="Model identifier for the Live API")
