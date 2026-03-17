"""Pydantic models for the agentic prompt editor."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

MEMORY_WRITE_TOOLS: frozenset[str] = frozenset({
    "save_to_project_memory",
    "update_project_memory",
    "add_memory_note",
    "update_project_context",
})

DESTRUCTIVE_TOOLS: frozenset[str] = frozenset({
    "batch_delete_assets",
    "delete_asset",
    "delete_clip",
    "delete_track",
    "create_timeline",
})


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
    memory_updated: bool = Field(default=False, description="True when project memory was modified during this turn")
    requires_confirmation: bool = Field(default=False, description="True when the tool calls include destructive operations that should be confirmed by the user")


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
# Skill System
# ============================================================


class SkillDescriptor(BaseModel):
    """Lightweight summary of a skill, used for routing decisions.

    Kept small (~100 tokens) so the full catalog fits in the
    orchestrator's context window alongside the user prompt.
    """

    id: str = Field(description="Unique skill identifier (e.g. 'marketing-editor')")
    name: str = Field(description="Human-readable display name")
    description: str = Field(description="What this skill does and when to use it (~1-2 sentences)")
    tool_categories: list[str] = Field(default_factory=list, description="Tool categories this skill needs access to")
    trigger_keywords: list[str] = Field(default_factory=list, description="Keywords that suggest this skill is relevant")


class SkillContent(BaseModel):
    """Full skill definition loaded only when a sub-agent is about to execute."""

    descriptor: SkillDescriptor
    system_prompt: str = Field(description="Domain-specific system prompt for the sub-agent")
    tool_overrides: list[str] | None = Field(
        default=None,
        description="Specific tool names to include (overrides category-based selection)",
    )
    references: dict[str, str] = Field(
        default_factory=dict,
        description="Reference files: {filename: content}. Loaded from references/ subdirectory.",
    )
    enable_search: bool = Field(
        default=False,
        description="Enable Gemini Google Search grounding for this skill's sub-agent sessions.",
    )


# ============================================================
# Orchestration
# ============================================================


class TaskStatus(str, Enum):
    """Lifecycle state of a single task in the execution DAG."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskType(str, Enum):
    """Whether a task produces text or executes tools."""

    CREATIVE = "creative"
    EXECUTION = "execution"
    REVIEW = "review"


class TaskNode(BaseModel):
    """A single unit of work in the orchestration DAG."""

    id: str = Field(description="Unique task identifier within the DAG")
    description: str = Field(description="What this task accomplishes")
    skill_id: str | None = Field(default=None, description="Matched skill, or None for brain fallback")
    depends_on: list[str] = Field(default_factory=list, description="Task IDs that must complete first")
    status: TaskStatus = Field(default=TaskStatus.PENDING)
    task_type: TaskType = Field(default=TaskType.EXECUTION, description="Whether this task produces text or calls tools")
    tool_categories: list[str] = Field(default_factory=list, description="Which tool categories this task needs")
    context_requirements: list[str] = Field(
        default_factory=list,
        description="What context data this task needs (e.g. 'timeline_state', 'asset_metadata')",
    )
    result_summary: str = Field(default="", description="Compressed output from sub-agent after completion")
    error: str | None = Field(default=None, description="Error message if task failed")
    retry_count: int = Field(default=0, description="Number of times this task has been retried")


class TaskDAG(BaseModel):
    """Directed acyclic graph of tasks produced by the planner."""

    tasks: list[TaskNode] = Field(default_factory=list)
    original_prompt: str = Field(default="", description="The user's original request")
    target_duration_seconds: float | None = Field(
        default=None,
        description="Planner's estimated target duration for the final video in seconds",
    )

    def get_ready_tasks(self) -> list[TaskNode]:
        """Return tasks whose dependencies are all in a terminal state."""
        terminal = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}
        terminal_ids = {t.id for t in self.tasks if t.status in terminal}
        return [
            t for t in self.tasks
            if t.status == TaskStatus.PENDING
            and all(dep in terminal_ids for dep in t.depends_on)
        ]

    def is_complete(self) -> bool:
        """True when every task is completed, failed, or cancelled."""
        terminal = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}
        return all(t.status in terminal for t in self.tasks)

    def get_task(self, task_id: str) -> TaskNode | None:
        for t in self.tasks:
            if t.id == task_id:
                return t
        return None


class OrchestratorStatus(str, Enum):
    """High-level phase of an orchestration session."""

    PLANNING = "planning"
    EXECUTING = "executing"
    AWAITING_TOOL_RESULTS = "awaiting_tool_results"
    REVIEWING = "reviewing"
    DONE = "done"
    ERROR = "error"


class SubAgentContext(BaseModel):
    """Context payload assembled for a sub-agent execution."""

    task: TaskNode
    timeline_context: str | None = None
    assets_context: str | None = None
    prior_task_results: dict[str, str] = Field(
        default_factory=dict,
        description="Summaries from completed dependency tasks: {task_id: summary}",
    )
    project_id: str | None = None
    view_context: str = "editor"
    target_duration_seconds: float | None = Field(
        default=None,
        description="Target duration for the final video, propagated from the planner's estimate",
    )


class SubAgentResult(BaseModel):
    """Output from a sub-agent execution."""

    task_id: str
    success: bool = True
    tool_calls: list[ToolCall] = Field(default_factory=list, description="Frontend tool calls to execute")
    backend_tool_results: list[ToolResult] = Field(default_factory=list, description="Already-executed backend tool results")
    message: str = Field(default="", description="Summary for orchestrator")
    error: str | None = None
    sub_agent_contents: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Gemini conversation history for resuming the sub-agent session",
    )
    sub_agent_system_prompt: str = Field(default="", description="System prompt for resuming")
    sub_agent_tool_declarations: list[Any] = Field(default_factory=list, description="Tool declarations for resuming")
    sub_agent_enable_search: bool = Field(default=False, description="Whether Google Search grounding was enabled")


class OrchestrateRequest(BaseModel):
    """Request to start or continue an orchestrated multi-agent execution."""

    prompt: str = Field(description="User's natural-language instruction", max_length=10000)
    timeline_state: TimelineState | None = None
    assets_context: dict[str, object] | None = None
    conversation_history: list[AgentMessage] = Field(default_factory=list, max_length=100)
    session_id: str | None = None
    project_id: str | None = None
    view_context: ViewContext = Field(default=ViewContext.EDITOR)


class OrchestrateTaskInfo(BaseModel):
    """Serialized task info sent to the frontend for progress display."""

    id: str
    description: str
    skill_id: str | None = None
    skill_name: str | None = None
    depends_on: list[str] = Field(default_factory=list)
    status: str
    error: str | None = None


class OrchestrateResponse(BaseModel):
    """Response from the orchestrator to the frontend."""

    session_id: str = Field(default="")
    status: str = Field(default="planning", description="Current orchestrator phase")
    tasks: list[OrchestrateTaskInfo] = Field(default_factory=list, description="Full task list with statuses")
    current_task_id: str | None = Field(default=None, description="Task currently being executed")
    tool_calls: list[ToolCall] = Field(default_factory=list, description="Frontend tool calls to execute")
    message: str = Field(default="", description="Message to display to the user")
    done: bool = Field(default=False)
    memory_updated: bool = Field(default=False, description="True when project memory was modified during this turn")


class OrchestrateContinueRequest(BaseModel):
    """Follow-up request carrying tool results back to the orchestrator."""

    session_id: str
    tool_results: list[ToolResult] = Field(default_factory=list)
    updated_context: str | None = None


class SkipTaskRequest(BaseModel):
    """Request to skip (cancel) a pending task in an orchestration session."""

    session_id: str
    task_id: str


# ============================================================
# Clarification
# ============================================================


class ClarificationOption(BaseModel):
    """A single selectable option for a clarification question."""

    id: str = Field(description="Unique option identifier within the question")
    label: str = Field(description="Display text for this option")


class ClarificationQuestion(BaseModel):
    """A question the agent asks the user before executing a complex request."""

    id: str = Field(description="Unique question identifier")
    question: str = Field(description="The question text")
    options: list[ClarificationOption] = Field(description="Pre-determined answer options")
    allow_custom: bool = Field(default=True, description="Whether to show a free-text input for custom answers")


class ClarifyRequest(BaseModel):
    """Request to generate clarification questions for a complex prompt."""

    prompt: str = Field(description="User's natural-language instruction", max_length=10000)
    timeline_state: TimelineState | None = None
    assets_context: dict[str, object] | None = None
    project_id: str | None = None
    view_context: ViewContext = Field(default=ViewContext.EDITOR)


class ClarifyResponse(BaseModel):
    """Response containing clarification questions (or none if prompt is clear)."""

    needs_clarification: bool = Field(default=False)
    questions: list[ClarificationQuestion] = Field(default_factory=list)


class ClarificationAnswer(BaseModel):
    """A user's answer to a single clarification question."""

    question_id: str
    selected_option_id: str | None = Field(default=None, description="ID of selected option, None if skipped")
    custom_answer: str | None = Field(default=None, description="Free-text answer override", max_length=500)
    skipped: bool = Field(default=False)


# ============================================================
# Intent Resolution
# ============================================================


class IntentResolveRequest(BaseModel):
    """Request to resolve user intent against project context."""

    prompt: str = Field(description="User's raw natural-language instruction", max_length=10000)
    project_id: str | None = Field(default=None, description="Project ID for context lookup")
    conversation_history: list[AgentMessage] = Field(default_factory=list, max_length=20)
    view_context: ViewContext = Field(default=ViewContext.EDITOR)
    assets_context: dict[str, object] | None = None


class IntentResolveResponse(BaseModel):
    """Response from the intent resolver with grounded prompt and routing."""

    grounded_prompt: str = Field(description="Disambiguated, self-contained prompt")
    complexity: str = Field(description="'simple' or 'orchestrated'")
    relevant_memory_ids: list[str] = Field(default_factory=list, description="Memory doc IDs the agent should read")
    intent_summary: str = Field(default="", description="One-sentence summary of what the user wants")
    requires_generation: bool = Field(default=False, description="Whether the request involves image/video generation")


# ============================================================
# Project Memory
# ============================================================


class MemoryDocumentType(str, Enum):
    """Type classification for project memory documents."""

    SCRIPT = "script"
    RESEARCH = "research"
    STORYBOARD = "storyboard"
    NOTES = "notes"
    REFERENCE = "reference"
    CHARACTER_SHEET = "character_sheet"
    LOCATION_REF = "location_ref"
    VISUAL_IDENTITY = "visual_identity"


class DocumentMeta(BaseModel):
    """Metadata for a project memory document (stored in manifest)."""

    id: str = Field(description="Unique document identifier")
    title: str = Field(description="Human-readable document title")
    type: MemoryDocumentType = Field(description="Document classification")
    filename: str = Field(description="Relative path within .memory/ directory")
    description: str = Field(default="", description="Short summary of the document")
    created_at: str = Field(description="ISO-8601 creation timestamp")
    updated_at: str = Field(description="ISO-8601 last-update timestamp")
    version: int = Field(default=1, description="Incremented on each update")
    tags: list[str] = Field(default_factory=list, description="Searchable tags")
    created_by: str = Field(default="user", description="Creator identifier (e.g. 'user', 'agent:cinematography')")


class MemoryManifest(BaseModel):
    """Index of all documents in a project's memory store."""

    project_id: str
    documents: list[DocumentMeta] = Field(default_factory=list)
    updated_at: str = Field(default="", description="ISO-8601 last-update timestamp")


class MemoryDocument(BaseModel):
    """A full memory document: metadata + content body."""

    meta: DocumentMeta
    content: str = Field(description="Markdown body of the document")


class SaveDocumentRequest(BaseModel):
    """Request to create a new memory document."""

    project_id: str
    title: str
    type: MemoryDocumentType
    content: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    created_by: str = "user"
    assets_path: str | None = Field(default=None, description="Override storage base path")


class UpdateDocumentRequest(BaseModel):
    """Request to update an existing memory document."""

    project_id: str
    document_id: str
    content: str | None = None
    title: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    assets_path: str | None = Field(default=None, description="Override storage base path")


class AddMemoryEntryRequest(BaseModel):
    """Request to append an entry to the memory/preferences log."""

    project_id: str
    entry: str = Field(description="Free-text memory note", max_length=5000)
    assets_path: str | None = Field(default=None, description="Override storage base path")


class UpdateContextRequest(BaseModel):
    """Request to update the master project context document."""

    project_id: str
    content: str = Field(description="New master context content", max_length=50000)
    assets_path: str | None = Field(default=None, description="Override storage base path")


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
