"""MCP-inspired tool registry for the LTX Desktop agentic editor.

Every tool the LLM agent can invoke is declared here with a rich schema
that doubles as documentation for the model and auto-converts to Gemini
function declarations via ``tools_to_gemini_declarations()``.
"""

from __future__ import annotations

from .types import ExecutionTarget, ToolDefinition, ToolParameter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _param(
    name: str,
    type: str,  # noqa: A002 – shadows builtin on purpose for brevity
    description: str,
    *,
    required: bool = True,
) -> ToolParameter:
    return ToolParameter(
        name=name,
        type=type,
        description=description,
        required=required,
    )


def _tool(
    name: str,
    description: str,
    execution_target: ExecutionTarget,
    parameters: list[ToolParameter] | None = None,
) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=description,
        execution_target=execution_target,
        parameters=parameters or [],
    )


# ---------------------------------------------------------------------------
# Atomic tools – executed on the frontend (Electron/React)
# ---------------------------------------------------------------------------

get_timeline_state = _tool(
    name="get_timeline_state",
    description=(
        "Retrieve the complete current state of the active timeline. "
        "Returns every track (with id, name, muted/locked/enabled flags, kind) "
        "and every clip (with id, assetId, type, startTime, duration, trimStart, "
        "trimEnd, speed, volume, trackIndex, effects, color correction, "
        "transitions, and text/subtitle data). Also includes the list of "
        "subtitle cues. Use this before making edits so you know the exact "
        "clip IDs, track indices, and current timing values."
    ),
    execution_target=ExecutionTarget.FRONTEND,
)

trim_clip = _tool(
    name="trim_clip",
    description=(
        "Adjust the in-point and/or out-point of a clip by a relative delta "
        "(in seconds). A positive trim_start_delta moves the in-point later "
        "(removes frames from the beginning); a negative value extends it "
        "earlier. A positive trim_end_delta removes frames from the end; "
        "a negative value extends it later. Both deltas default to 0. "
        "The clip's position on the timeline (startTime) is NOT changed; "
        "only the visible portion within the source media changes. "
        "If the clip is part of a linked group (e.g. video+audio pair), "
        "the operation automatically applies to all linked siblings — "
        "do not call this tool separately for each linked clip."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to trim."),
        _param(
            "trim_start_delta",
            "number",
            (
                "Seconds to add to the current trim-start value. "
                "Positive = trim more from the beginning, negative = reveal more."
            ),
        ),
        _param(
            "trim_end_delta",
            "number",
            (
                "Seconds to add to the current trim-end value. "
                "Positive = trim more from the end, negative = reveal more."
            ),
        ),
    ],
)

split_clip = _tool(
    name="split_clip",
    description=(
        "Split (razor-cut) a clip into two pieces at the given absolute "
        "timeline time (in seconds). The original clip is shortened to end "
        "at the split point, and a new clip is created starting at the split "
        "point with the remainder. Both clips keep the same track index. "
        "The time must fall within the clip's visible range "
        "(startTime < time < startTime + duration - trimEnd). "
        "If the clip is part of a linked group (e.g. video+audio pair), "
        "the operation automatically applies to all linked siblings — "
        "do not call this tool separately for each linked clip."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to split."),
        _param(
            "time",
            "number",
            "Absolute timeline position (seconds) where the cut occurs.",
        ),
    ],
)

delete_clip = _tool(
    name="delete_clip",
    description=(
        "Remove a clip from the timeline. When ripple is true, all clips "
        "on the same track that start after the deleted clip slide left to "
        "close the gap. When ripple is false, the clip is removed but a "
        "gap remains in its place. "
        "If the clip is part of a linked group (e.g. video+audio pair), "
        "the operation automatically applies to all linked siblings — "
        "do not call this tool separately for each linked clip."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to delete."),
        _param(
            "ripple",
            "boolean",
            (
                "If true, subsequent clips on the same track shift left to "
                "fill the gap left by the deleted clip. If false, a gap remains."
            ),
        ),
    ],
)

move_clip = _tool(
    name="move_clip",
    description=(
        "Reposition a clip on the timeline by changing its start time and/or "
        "track. The clip keeps its current duration, trims, and effects. "
        "Use get_timeline_state first to verify the target position is free "
        "of overlapping clips. Track indices are zero-based and correspond "
        "to the tracks array in the timeline state. "
        "If the clip is part of a linked group (e.g. video+audio pair), "
        "the operation automatically applies to all linked siblings — "
        "do not call this tool separately for each linked clip."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to move."),
        _param(
            "new_start_time",
            "number",
            "New absolute start time on the timeline (seconds).",
        ),
        _param(
            "new_track_index",
            "integer",
            "Zero-based index of the destination track.",
        ),
    ],
)

add_clip_to_timeline = _tool(
    name="add_clip_to_timeline",
    description=(
        "Place an existing project asset onto the timeline as a new clip. "
        "You must provide the asset_id (from get_project_assets), the target "
        "track index (zero-based), and the start time (seconds). The clip "
        "duration is derived from the asset's intrinsic duration. "
        "Video and image assets should go on video tracks (kind='video'), "
        "and audio assets on audio tracks (kind='audio')."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the project asset to add (from get_project_assets).",
        ),
        _param(
            "track_index",
            "integer",
            "Zero-based index of the target track.",
        ),
        _param(
            "start_time",
            "number",
            "Absolute position on the timeline (seconds) where the clip begins.",
        ),
    ],
)

set_playhead = _tool(
    name="set_playhead",
    description=(
        "Move the playhead (current time indicator) to an absolute position "
        "on the timeline. This controls what frame is displayed in the "
        "preview monitor. Time is in seconds and must be >= 0."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param(
            "time",
            "number",
            "Absolute timeline position in seconds to move the playhead to.",
        ),
    ],
)

duplicate_timeline = _tool(
    name="duplicate_timeline",
    description=(
        "Create a snapshot (deep copy) of the current active timeline. "
        "The duplicate is added to the project's timeline list with a new "
        "ID and an auto-incremented name (e.g. 'Timeline 2'). All tracks, "
        "clips, effects, and subtitles are preserved. Useful as an undo "
        "checkpoint before destructive operations or for A/B comparisons."
    ),
    execution_target=ExecutionTarget.FRONTEND,
)

create_timeline = _tool(
    name="create_timeline",
    description=(
        "Create a new empty timeline with default tracks (3 video, 2 audio, "
        "1 subtitle) in the current project. The new timeline becomes the "
        "active timeline. Use this when the user wants to start a fresh edit "
        "from scratch rather than modifying the existing timeline."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param(
            "name",
            "string",
            "Display name for the new timeline. Defaults to an auto-incremented "
            "name like 'Timeline 2' if omitted.",
            required=False,
        ),
    ],
)

rename_timeline = _tool(
    name="rename_timeline",
    description=(
        "Rename the currently active timeline. Use this when the user asks "
        "to change the timeline name, or after creating/duplicating a timeline "
        "to give it a meaningful name that reflects its content."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param(
            "name",
            "string",
            "The new display name for the active timeline.",
        ),
    ],
)

split_at_playhead = _tool(
    name="split_at_playhead",
    description=(
        "Split (razor-cut) every clip that spans the current playhead "
        "position, across all tracks simultaneously. This is the equivalent "
        "of pressing the razor blade key. No parameters are needed — the "
        "playhead position is read from the frontend state. Linked clips "
        "are handled automatically."
    ),
    execution_target=ExecutionTarget.FRONTEND,
)

flip_clip = _tool(
    name="flip_clip",
    description=(
        "Set the horizontal and/or vertical flip state of a clip. "
        "Values are absolute: true = flipped, false = not flipped. "
        "Provide at least one of horizontal or vertical. "
        "Flipping is a visual transform applied during preview and export."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to flip."),
        _param(
            "horizontal",
            "boolean",
            "Set horizontal flip state. true = flipped, false = normal.",
            required=False,
        ),
        _param(
            "vertical",
            "boolean",
            "Set vertical flip state. true = flipped, false = normal.",
            required=False,
        ),
    ],
)

reverse_clip = _tool(
    name="reverse_clip",
    description=(
        "Set whether a clip plays in reverse. When reversed, the video "
        "plays backward from end to start. The clip's position and "
        "duration on the timeline are unchanged."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param(
            "reversed",
            "boolean",
            "true = play backward, false = play forward (normal).",
        ),
    ],
)

set_clip_speed = _tool(
    name="set_clip_speed",
    description=(
        "Change the playback speed of a clip. The clip's timeline duration "
        "is automatically recalculated to match. Common presets: 0.25 "
        "(quarter speed), 0.5 (half), 1 (normal), 1.5, 2 (double), 4 "
        "(quadruple). Values between 0.25 and 4 are accepted."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param(
            "speed",
            "number",
            "New playback speed multiplier (0.25–4). 1 = normal speed.",
        ),
    ],
)

add_dissolve = _tool(
    name="add_dissolve",
    description=(
        "Add a cross-dissolve transition between two adjacent clips on "
        "the same track. The left clip's outgoing transition and the "
        "right clip's incoming transition are both set to dissolve. The "
        "clips must be adjacent (left clip ends where right clip begins). "
        "To remove a dissolve, set duration to 0."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    parameters=[
        _param(
            "left_clip_id",
            "string",
            "ID of the outgoing (left) clip at the cut point.",
        ),
        _param(
            "right_clip_id",
            "string",
            "ID of the incoming (right) clip at the cut point.",
        ),
        _param(
            "duration",
            "number",
            "Dissolve duration in seconds (default 0.5). Set to 0 to remove.",
            required=False,
        ),
    ],
)

get_project_assets = _tool(
    name="get_project_assets",
    description=(
        "List every asset in the current project. Each asset includes: id, "
        "type (video/image/audio/adjustment), path, url, prompt, resolution, "
        "duration (for videos), thumbnail, and generation parameters. Use "
        "the returned asset IDs with add_clip_to_timeline or "
        "get_video_metadata."
    ),
    execution_target=ExecutionTarget.FRONTEND,
)

# ---------------------------------------------------------------------------
# Resource tools – executed on the backend (Python / FastAPI)
# ---------------------------------------------------------------------------

get_video_metadata = _tool(
    name="get_video_metadata",
    description=(
        "Analyse a video asset and return rich metadata including: technical "
        "properties (codec, resolution, frame rate, duration, bitrate), "
        "an AI-generated content description summarising what happens in the "
        "video, and a list of detected scene boundaries with timestamps. "
        "This is a backend operation that reads the actual file; the asset "
        "must have been previously imported into the project."
    ),
    execution_target=ExecutionTarget.BACKEND,
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the video asset to analyse (from get_project_assets).",
        ),
    ],
)

# ---------------------------------------------------------------------------
# Public registry
# ---------------------------------------------------------------------------

ALL_TOOLS: list[ToolDefinition] = [
    # Atomic (frontend)
    get_timeline_state,
    trim_clip,
    split_clip,
    delete_clip,
    move_clip,
    add_clip_to_timeline,
    set_playhead,
    duplicate_timeline,
    create_timeline,
    rename_timeline,
    split_at_playhead,
    flip_clip,
    reverse_clip,
    set_clip_speed,
    add_dissolve,
    get_project_assets,
    # Resource (backend)
    get_video_metadata,
]

TOOLS_BY_NAME: dict[str, ToolDefinition] = {tool.name: tool for tool in ALL_TOOLS}

# ---------------------------------------------------------------------------
# Gemini function-declaration converter
# ---------------------------------------------------------------------------

_PARAM_TYPE_MAP: dict[str, str] = {
    "string": "string",
    "number": "number",
    "integer": "integer",
    "boolean": "boolean",
}


def _param_to_property(param: ToolParameter) -> dict[str, str]:
    """Convert a single ToolParameter to a JSON Schema property dict."""
    return {
        "type": _PARAM_TYPE_MAP.get(param.type, param.type),
        "description": param.description,
    }


def tools_to_gemini_declarations(
    tools: list[ToolDefinition] | None = None,
) -> list[dict[str, object]]:
    """Convert tool definitions into Gemini-compatible function declarations.

    If *tools* is ``None`` the full ``ALL_TOOLS`` registry is used.

    Returns a list of dicts, each with ``name``, ``description``, and a
    ``parameters`` object following JSON Schema conventions::

        [{
            "name": "tool_name",
            "description": "...",
            "parameters": {
                "type": "object",
                "properties": { "param": {"type": "string", "description": "..."} },
                "required": ["param"]
            }
        }]
    """
    if tools is None:
        tools = ALL_TOOLS

    declarations: list[dict[str, object]] = []
    for tool in tools:
        properties: dict[str, dict[str, str]] = {}
        required: list[str] = []

        for param in tool.parameters:
            properties[param.name] = _param_to_property(param)
            if param.required:
                required.append(param.name)

        declaration: dict[str, object] = {
            "name": tool.name,
            "description": tool.description,
        }

        # Gemini requires a parameters object even when there are no params;
        # an empty-properties object signals "no arguments".
        declaration["parameters"] = {
            "type": "object",
            "properties": properties,
            "required": required,
        }

        declarations.append(declaration)

    return declarations
