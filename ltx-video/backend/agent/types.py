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


class VideoMetadata(BaseModel):
    """Full analysis metadata for a video asset."""

    asset_id: str = Field(description="Unique asset identifier")
    duration: float = Field(description="Video duration in seconds")
    resolution: tuple[int, int] = Field(description="(width, height) in pixels")
    fps: float = Field(description="Frames per second")
    scenes: list[SceneSegment] = Field(default_factory=list)
    dialogue: list[DialogueLine] = Field(default_factory=list)
    summary: str = Field(default="", description="High-level summary of the video")
    analysis_status: AnalysisStatus = Field(default=AnalysisStatus.PENDING)


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
    type: str = Field(description="JSON Schema type (string, number, boolean, …)")
    description: str = ""
    required: bool = True
    default: Any = None
    enum: list[str] | None = None


class ToolDefinition(BaseModel):
    """Describes a tool the agent can invoke."""

    name: str = Field(description="Unique tool name")
    description: str = Field(description="What the tool does")
    parameters: list[ToolParameter] = Field(default_factory=list)
    execution_target: ExecutionTarget = Field(default=ExecutionTarget.FRONTEND)
    category: str = Field(default="general", description="Logical grouping for tools")


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

    call_id: str
    success: bool = True
    result: Any = None
    error: str | None = None


class TimelineClipInfo(BaseModel):
    """Minimal clip information for agent context."""

    id: str
    asset_id: str
    type: str = Field(description="Clip type (video, audio, image, …)")
    start_time: float = Field(description="Position on timeline in seconds")
    duration: float
    trim_start: float = 0.0
    trim_end: float = 0.0
    track_index: int = 0
    speed: float = 1.0


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


class AgentExecuteRequest(BaseModel):
    """Initial request from the frontend to the agent."""

    prompt: str = Field(description="User's natural-language instruction")
    timeline_state: TimelineState | None = None
    conversation_history: list[AgentMessage] = Field(default_factory=list)


class AgentExecuteResponse(BaseModel):
    """Response from the agent after planning / execution."""

    plan: str = Field(default="", description="Human-readable plan description")
    tool_calls: list[ToolCall] = Field(default_factory=list)
    message: str = Field(default="", description="Message to display to the user")
    done: bool = Field(default=False, description="True when the agent has finished all steps")


class AgentContinueRequest(BaseModel):
    """Follow-up request carrying tool results back to the agent."""

    tool_results: list[ToolResult] = Field(default_factory=list)
    conversation_history: list[AgentMessage] = Field(default_factory=list)
    session_id: str = Field(default="", description="Identifies the ongoing agent session")


class AnalyzeVideoRequest(BaseModel):
    """Request to start video analysis."""

    asset_id: str
    file_path: str
    duration: float | None = None


class AnalyzeVideoResponse(BaseModel):
    """Response from video analysis endpoint."""

    status: AnalysisStatus
    metadata: VideoMetadata | None = None
