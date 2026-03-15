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
    *,
    category: str = "core",
) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=description,
        execution_target=execution_target,
        parameters=parameters or [],
        category=category,
    )


# ===================================================================
# CORE — always included in every agent call
# ===================================================================

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
    category="core",
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
    category="core",
)

switch_view = _tool(
    name="switch_view",
    description=(
        "Switch the user's current view/tab. Use this when you need to perform "
        "operations that require a different view. For example, if you're in Gen Space "
        "and need to create a timeline or add clips, call switch_view('video-editor') first. "
        "After switching, the next tool calls will execute in the new view context. "
        "ALWAYS call this BEFORE any tool that belongs to a different view."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="core",
    parameters=[
        _param(
            "target_view",
            "string",
            "The view to switch to: 'gen-space' or 'video-editor'.",
        ),
    ],
)

# ===================================================================
# CLIP EDITING
# ===================================================================

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
    category="clip_editing",
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
    category="clip_editing",
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
    category="clip_editing",
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
    category="clip_editing",
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
        "and audio assets on audio tracks (kind='audio'). "
        "To add only a specific segment of a video, provide optional "
        "source_in and source_out (in seconds of the source media). "
        "The system will automatically create a sub-clip and trim to "
        "the specified range. This is the preferred way to extract "
        "segments from long videos."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_editing",
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
        _param(
            "source_in",
            "number",
            "Optional source in-point in seconds. When provided with source_out, "
            "only the segment between source_in and source_out from the source "
            "media is placed on the timeline. Use this to extract specific segments "
            "from long videos without needing to create sub-clip assets first.",
            required=False,
        ),
        _param(
            "source_out",
            "number",
            "Optional source out-point in seconds. Must be provided together "
            "with source_in. Defines the end of the segment to extract.",
            required=False,
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
    category="clip_editing",
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
    category="clip_editing",
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
    category="clip_editing",
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
    category="clip_editing",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param(
            "speed",
            "number",
            "New playback speed multiplier (0.25–4). 1 = normal speed.",
        ),
    ],
)

duplicate_clip = _tool(
    name="duplicate_clip",
    description=(
        "Create an exact copy of a clip and place it immediately after the "
        "original on the same track. The duplicate has a new ID but shares "
        "the same asset, trims, effects, and speed. Linked clips are "
        "duplicated as a group."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_editing",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip to duplicate."),
    ],
)

# ===================================================================
# CLIP PROPERTIES
# ===================================================================

set_clip_volume = _tool(
    name="set_clip_volume",
    description=(
        "Set the audio volume and/or mute state of a clip. Volume is a "
        "multiplier from 0.0 (silent) to 1.0 (full). Muted clips produce "
        "no audio regardless of volume level."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_properties",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param("volume", "number", "Volume level 0.0–1.0.", required=False),
        _param("muted", "boolean", "true = mute, false = unmute.", required=False),
    ],
)

set_clip_opacity = _tool(
    name="set_clip_opacity",
    description=(
        "Set the visual opacity of a video/image clip. 1.0 is fully opaque "
        "(default), 0.0 is fully transparent. Clips on higher tracks show "
        "through to lower tracks when opacity is reduced."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_properties",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param("opacity", "number", "Opacity value 0.0–1.0."),
    ],
)

link_unlink_clips = _tool(
    name="link_unlink_clips",
    description=(
        "Link or unlink clips so they move and are edited as a group. "
        "Typically used to pair a video clip with its audio counterpart. "
        "When linking, provide all clip IDs that should form one group."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_properties",
    parameters=[
        ToolParameter(
            name="clip_ids",
            type="array",
            description="Array of clip IDs to link or unlink.",
            items={"type": "string"},
        ),
        _param(
            "action",
            "string",
            "'link' to group clips together, 'unlink' to separate them.",
        ),
    ],
)

set_color_correction = _tool(
    name="set_color_correction",
    description=(
        "Adjust color correction properties of a clip: brightness, contrast, "
        "saturation, and color temperature. All values are relative offsets "
        "where 0 is no change. Provide only the properties you want to modify."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="clip_properties",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the clip."),
        _param("brightness", "number", "Brightness offset (-100 to 100).", required=False),
        _param("contrast", "number", "Contrast offset (-100 to 100).", required=False),
        _param("saturation", "number", "Saturation offset (-100 to 100).", required=False),
        _param("temperature", "number", "Color temperature offset (-100 to 100).", required=False),
    ],
)

# ===================================================================
# TRANSITIONS
# ===================================================================

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
    category="transitions",
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

# ===================================================================
# PLAYBACK & NAVIGATION
# ===================================================================

set_playhead = _tool(
    name="set_playhead",
    description=(
        "Move the playhead (current time indicator) to an absolute position "
        "on the timeline. This controls what frame is displayed in the "
        "preview monitor. Time is in seconds and must be >= 0."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param(
            "time",
            "number",
            "Absolute timeline position in seconds to move the playhead to.",
        ),
    ],
)

toggle_playback = _tool(
    name="toggle_playback",
    description=(
        "Play, pause, or toggle timeline playback. By default toggles "
        "the current state."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param(
            "action",
            "string",
            "'play', 'pause', or 'toggle' (default). Controls playback state.",
            required=False,
        ),
    ],
)

step_frame = _tool(
    name="step_frame",
    description=(
        "Step the playhead forward or backward by a number of frames. "
        "Pauses playback if currently playing."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param("direction", "string", "'forward' or 'backward'."),
        _param("frames", "integer", "Number of frames to step (default 1).", required=False),
    ],
)

jump_to_edit_point = _tool(
    name="jump_to_edit_point",
    description=(
        "Jump the playhead to the next or previous edit point (cut) on "
        "the timeline. An edit point is where any clip starts or ends."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param("direction", "string", "'next' or 'previous'."),
    ],
)

set_in_out_points = _tool(
    name="set_in_out_points",
    description=(
        "Set or clear the In and Out point markers on the timeline. These "
        "markers define a region for playback, export, or 3-point editing. "
        "Pass null to clear a specific point."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param("in_point", "number", "In point time in seconds, or null to clear.", required=False),
        _param("out_point", "number", "Out point time in seconds, or null to clear.", required=False),
    ],
)

zoom_to_fit = _tool(
    name="zoom_to_fit",
    description=(
        "Adjust the timeline zoom level. 'fit' scales to show the entire "
        "timeline. 'zoom_in' and 'zoom_out' step the zoom. 'set_level' "
        "sets a specific zoom level."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="playback",
    parameters=[
        _param("action", "string", "'fit', 'zoom_in', 'zoom_out', or 'set_level'."),
        _param("level", "number", "Zoom level (only used with 'set_level').", required=False),
    ],
)

# ===================================================================
# TIMELINE MANAGEMENT
# ===================================================================

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
    category="timeline_mgmt",
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
    category="timeline_mgmt",
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
    category="timeline_mgmt",
    parameters=[
        _param(
            "name",
            "string",
            "The new display name for the active timeline.",
        ),
    ],
)

undo = _tool(
    name="undo",
    description="Undo the last editing action on the timeline.",
    execution_target=ExecutionTarget.FRONTEND,
    category="timeline_mgmt",
)

redo = _tool(
    name="redo",
    description="Redo the last undone editing action on the timeline.",
    execution_target=ExecutionTarget.FRONTEND,
    category="timeline_mgmt",
)

# ===================================================================
# TRACK MANAGEMENT
# ===================================================================

add_track = _tool(
    name="add_track",
    description=(
        "Add a new track to the timeline. Specify the kind (video, audio, "
        "or subtitle) and optionally a position index. Video tracks are "
        "ordered top-to-bottom (higher index = lower layer)."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="track_mgmt",
    parameters=[
        _param("kind", "string", "'video', 'audio', or 'subtitle'."),
        _param("position", "integer", "Insert at this index (default: end).", required=False),
    ],
)

delete_track = _tool(
    name="delete_track",
    description=(
        "Delete a track and all clips on it from the timeline. This is "
        "destructive — all clips on the track are removed."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="track_mgmt",
    parameters=[
        _param("track_index", "integer", "Zero-based index of the track to delete."),
    ],
)

set_track_state = _tool(
    name="set_track_state",
    description=(
        "Change track state flags: muted, locked, solo, or output enabled. "
        "Provide only the flags you want to change."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="track_mgmt",
    parameters=[
        _param("track_index", "integer", "Zero-based index of the track."),
        _param("muted", "boolean", "true = mute track audio.", required=False),
        _param("locked", "boolean", "true = lock track (prevent edits).", required=False),
        _param("solo", "boolean", "true = solo this audio track.", required=False),
        _param("enabled", "boolean", "true = show video output, false = hide.", required=False),
    ],
)

# ===================================================================
# ASSET MANAGEMENT
# ===================================================================

create_subclip_assets = _tool(
    name="create_subclip_assets",
    description=(
        "Create virtual sub-clip assets in the project bin from a list of "
        "sub-clip definitions. Each sub-clip references a parent video asset "
        "and has specific source in/out points, a title, and topic tags. "
        "Sub-clips appear in the bin organized by their first topic tag."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        ToolParameter(
            name="subclips",
            type="array",
            description="Array of sub-clip definitions.",
            items={
                "type": "object",
                "properties": {
                    "parent_asset_id": {"type": "string", "description": "ID of the parent video asset"},
                    "source_in": {"type": "number", "description": "Source in-point in seconds"},
                    "source_out": {"type": "number", "description": "Source out-point in seconds"},
                    "title": {"type": "string", "description": "Sub-clip title"},
                    "description": {"type": "string", "description": "Sub-clip description"},
                    "topics": {"type": "array", "description": "Topic tags", "items": {"type": "string"}},
                },
                "required": ["parent_asset_id", "source_in", "source_out", "title", "description"],
            },
        ),
    ],
)

import_media = _tool(
    name="import_media",
    description=(
        "Open a native file picker dialog to import media into the project. "
        "The imported file is copied to the project asset folder and a new "
        "asset is created. Returns the new asset_id."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        _param(
            "file_type",
            "string",
            "Filter for 'video', 'image', 'audio', or 'any' (default).",
            required=False,
        ),
    ],
)

delete_asset = _tool(
    name="delete_asset",
    description="Remove an asset from the project. Does not delete clips already on the timeline.",
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        _param("asset_id", "string", "ID of the asset to delete."),
    ],
)

batch_delete_assets = _tool(
    name="batch_delete_assets",
    description=(
        "Remove multiple assets from the project in one call. Use this instead of "
        "calling delete_asset repeatedly when you need to delete more than one asset. "
        "Returns the list of successfully deleted IDs, any failures, and the remaining "
        "asset count so you can verify the operation is complete."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        ToolParameter(
            name="asset_ids",
            type="array",
            description="Array of asset IDs to delete.",
            items={"type": "string"},
        ),
    ],
)

organize_asset = _tool(
    name="organize_asset",
    description=(
        "Organize an asset by setting its bin and/or toggling its favorite status."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        _param("asset_id", "string", "ID of the asset."),
        _param("bin", "string", "Bin name to move asset to.", required=False),
        _param("favorite", "boolean", "true = favorite, false = unfavorite.", required=False),
    ],
)

set_active_take = _tool(
    name="set_active_take",
    description=(
        "Switch the active take for an asset that has multiple takes "
        "(generated variations). The active take is used when the asset "
        "is added to the timeline."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        _param("asset_id", "string", "ID of the asset."),
        _param("take_index", "integer", "Zero-based index of the take to activate."),
    ],
)

regenerate_asset = _tool(
    name="regenerate_asset",
    description=(
        "Create a new take for an existing generated asset by re-running "
        "generation with its stored parameters. The new take is added to "
        "the asset's take list. Returns the new take index."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="asset_mgmt",
    parameters=[
        _param("asset_id", "string", "ID of the asset to regenerate."),
    ],
)

# ===================================================================
# GENERATION
# ===================================================================

generate_video = _tool(
    name="generate_video",
    description=(
        "Generate a new video using AI. Supports three modes: "
        "'text_to_video' (from prompt only), 'image_to_video' (animate an "
        "image — requires image_asset_id), 'audio_to_video' (from audio — "
        "requires audio_asset_id). The generated video is saved as a new "
        "project asset. This is a long-running operation (20-120 seconds)."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
    parameters=[
        _param("prompt", "string", "Text description of the desired video content."),
        _param(
            "mode",
            "string",
            "'text_to_video', 'image_to_video', or 'audio_to_video'.",
        ),
        _param("image_asset_id", "string", "Asset ID of the input image (for image_to_video).", required=False),
        _param("audio_asset_id", "string", "Asset ID of the input audio (for audio_to_video).", required=False),
        _param(
            "duration", "integer",
            "Video duration in seconds. Allowed values depend on model: "
            "fast model: 6, 8, 10, 12, 14, 16, 18, or 20 seconds. "
            "pro model: 6, 8, or 10 seconds only. "
            "Choose duration based on content: 6s for quick shots, 8-10s for standard scenes, "
            "12-16s for extended scenes, 18-20s for long continuous shots.",
            required=False,
        ),
        _param("resolution", "string", "e.g. '720p', '1080p' (default).", required=False),
        _param("fps", "integer", "Frames per second (default 24).", required=False),
        _param("aspect_ratio", "string", "'16:9' (default) or '9:16'.", required=False),
        _param(
            "model", "string",
            "'fast' or 'pro'. Choose based on content: "
            "pro = higher quality, better for complex scenes, cinematic shots, detailed motion (max 10s). "
            "fast = good quality, supports up to 20 seconds, better for simple content, talking heads, "
            "landscapes, or when longer duration is needed. "
            "If duration > 10s, you MUST use 'fast'. For short complex shots, prefer 'pro'.",
            required=False,
        ),
        _param("camera_motion", "string", "Camera motion preset (e.g. 'static', 'dolly_in').", required=False),
    ],
)

generate_image = _tool(
    name="generate_image",
    description=(
        "Generate or edit an image using AI. Default model is Nano Banana 2 "
        "(higher quality, supports editing with reference images). Pass "
        "image_urls with asset IDs (from get_project_assets) to composite/edit "
        "multiple images together. Without image_urls, generates from text only. "
        "Returns the asset_id."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
    parameters=[
        _param("prompt", "string", "Text description of the desired image, or editing instruction when image_urls are provided."),
        _param("model", "string", "'nano-banana-2' (default, higher quality) or 'z-image-turbo' (fast). Use NB2 unless user requests ZIT.", required=False),
        _param("resolution", "string", "For NB2: '1K', '2K', or '4K'. For ZIT: '1080p', '1440p', or '2048p'.", required=False),
        _param("aspect_ratio", "string", "For NB2: 'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'. For ZIT: '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'.", required=False),
        _param("num_variations", "integer", "Number of image variations (1-4, default 1).", required=False),
        _param("image_urls", "array", "List of asset IDs for reference images (from get_project_assets results). The system resolves these to image data automatically. Use for NB2 editing: compositing people, objects, or scenes from multiple images.", required=False),
    ],
)

retake_section = _tool(
    name="retake_section",
    description=(
        "Regenerate a portion of an existing video. Specify the video asset, "
        "start time, duration, and a new prompt for the section. The result "
        "is saved as a new asset or take."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
    parameters=[
        _param("video_asset_id", "string", "Asset ID of the video to retake from."),
        _param("start_time", "number", "Start time in seconds within the video."),
        _param("duration", "number", "Duration of the section to retake (minimum 2 seconds)."),
        _param("prompt", "string", "New prompt describing the desired content for this section."),
        _param(
            "mode",
            "string",
            "'replace_audio_and_video' (default), 'replace_video', or 'replace_audio'.",
            required=False,
        ),
    ],
)

cancel_generation = _tool(
    name="cancel_generation",
    description="Cancel any in-progress video or image generation.",
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
)

get_generation_status = _tool(
    name="get_generation_status",
    description=(
        "Check whether a generation is currently in progress and its "
        "completion percentage. Returns status, phase, and progress."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
)

fill_timeline_gap = _tool(
    name="fill_timeline_gap",
    description=(
        "AI-generate content to fill a gap in the timeline. Automatically "
        "suggests a prompt based on neighboring clips if none provided, "
        "generates the content, and places the result in the gap."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="generation",
    parameters=[
        _param("gap_start_time", "number", "Start time of the gap in seconds."),
        _param("gap_duration", "number", "Duration of the gap in seconds."),
        _param("track_index", "integer", "Track index where the gap is."),
        _param(
            "mode",
            "string",
            "'text_to_video', 'image_to_video', or 'text_to_image'.",
        ),
        _param("prompt", "string", "Optional prompt. If omitted, AI suggests one.", required=False),
    ],
)

suggest_prompt = _tool(
    name="suggest_prompt",
    description=(
        "Ask the AI to suggest a generation prompt based on context. Useful "
        "for filling gaps or generating content that matches the surrounding "
        "clips. Returns a suggested prompt string."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="generation",
    parameters=[
        _param("before_prompt", "string", "Prompt/description of the clip before.", required=False),
        _param("after_prompt", "string", "Prompt/description of the clip after.", required=False),
        _param("mode", "string", "'text_to_video', 'image_to_video', or 'text_to_image'."),
        _param("duration", "number", "Target duration in seconds.", required=False),
    ],
)

# ===================================================================
# SUBTITLES
# ===================================================================

add_subtitle = _tool(
    name="add_subtitle",
    description=(
        "Add a subtitle clip to a subtitle track at the specified time. "
        "The subtitle will display the given text during playback and export."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="subtitles",
    parameters=[
        _param("track_index", "integer", "Index of the subtitle track."),
        _param("start_time", "number", "Start time in seconds."),
        _param("duration", "number", "Duration in seconds."),
        _param("text", "string", "Subtitle text content."),
    ],
)

edit_subtitle = _tool(
    name="edit_subtitle",
    description=(
        "Edit an existing subtitle clip's text, start time, or duration. "
        "Provide only the fields you want to change."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="subtitles",
    parameters=[
        _param("clip_id", "string", "Unique identifier of the subtitle clip."),
        _param("text", "string", "New subtitle text.", required=False),
        _param("start_time", "number", "New start time in seconds.", required=False),
        _param("duration", "number", "New duration in seconds.", required=False),
    ],
)

set_subtitle_style = _tool(
    name="set_subtitle_style",
    description=(
        "Set the visual style for a subtitle track. All subtitles on the "
        "track share the same style."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="subtitles",
    parameters=[
        _param("track_index", "integer", "Index of the subtitle track."),
        _param("font_family", "string", "Font family name.", required=False),
        _param("font_size", "integer", "Font size in pixels.", required=False),
        _param("color", "string", "Text color as hex (e.g. '#FFFFFF').", required=False),
        _param("background_color", "string", "Background color as hex.", required=False),
        _param("position", "string", "'bottom', 'top', or 'center'.", required=False),
    ],
)

import_export_srt = _tool(
    name="import_export_srt",
    description=(
        "Import subtitles from an SRT file or export the current subtitles "
        "to SRT format."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="subtitles",
    parameters=[
        _param("action", "string", "'import' or 'export'."),
        _param("track_index", "integer", "Subtitle track index (for export).", required=False),
    ],
)

# ===================================================================
# EXPORT
# ===================================================================

export_timeline = _tool(
    name="export_timeline",
    description=(
        "Render and export the timeline to a video file. Uses the current "
        "project settings or the provided overrides. Returns the output "
        "file path when complete."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="export",
    parameters=[
        _param("format", "string", "Output format, e.g. 'mp4' (default).", required=False),
        _param("resolution", "string", "Export resolution override.", required=False),
        _param("fps", "integer", "Export FPS override.", required=False),
    ],
)

export_fcpxml = _tool(
    name="export_fcpxml",
    description="Export the timeline as Final Cut Pro 7 XML for use in other NLEs.",
    execution_target=ExecutionTarget.FRONTEND,
    category="export",
)

# ===================================================================
# EDIT OPERATIONS (3-point editing)
# ===================================================================

insert_edit = _tool(
    name="insert_edit",
    description=(
        "Perform a 3-point insert edit: place source material at the "
        "playhead, pushing existing clips to the right to make room. "
        "Optionally specify source in/out points."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="editing_ops",
    parameters=[
        _param("asset_id", "string", "ID of the source asset."),
        _param("source_in", "number", "Source in-point in seconds.", required=False),
        _param("source_out", "number", "Source out-point in seconds.", required=False),
    ],
)

overwrite_edit = _tool(
    name="overwrite_edit",
    description=(
        "Perform a 3-point overwrite edit: place source material at the "
        "playhead, replacing whatever is currently there."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="editing_ops",
    parameters=[
        _param("asset_id", "string", "ID of the source asset."),
        _param("source_in", "number", "Source in-point in seconds.", required=False),
        _param("source_out", "number", "Source out-point in seconds.", required=False),
    ],
)

# ===================================================================
# SELECTION & UI
# ===================================================================

select_clips = _tool(
    name="select_clips",
    description=(
        "Select or deselect specific clips on the timeline. Use mode 'set' "
        "to replace the current selection, 'add' to add to it, or 'remove' "
        "to deselect specific clips."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="selection_ui",
    parameters=[
        ToolParameter(
            name="clip_ids",
            type="array",
            description="Array of clip IDs to select/deselect.",
            items={"type": "string"},
        ),
        _param("mode", "string", "'set', 'add', or 'remove'."),
    ],
)

deselect_all = _tool(
    name="deselect_all",
    description="Clear the current clip selection on the timeline.",
    execution_target=ExecutionTarget.FRONTEND,
    category="selection_ui",
)

toggle_snap = _tool(
    name="toggle_snap",
    description=(
        "Enable or disable timeline snapping. When enabled, clips snap to "
        "edit points, playhead, and other clip edges during drag operations."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="selection_ui",
    parameters=[
        _param("enabled", "boolean", "true = enable snapping, false = disable.", required=False),
    ],
)

set_active_tool = _tool(
    name="set_active_tool",
    description=(
        "Switch the active editing tool on the timeline toolbar. This "
        "changes how click/drag interactions behave."
    ),
    execution_target=ExecutionTarget.FRONTEND,
    category="selection_ui",
    parameters=[
        _param(
            "tool",
            "string",
            "'selection', 'blade', 'ripple_trim', 'roll_trim', 'slip', 'slide', or 'track_select'.",
        ),
    ],
)

# ===================================================================
# ANALYSIS — backend resource tools
# ===================================================================

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
    category="analysis",
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the video asset to analyse (from get_project_assets).",
        ),
    ],
)

query_project_brain = _tool(
    name="query_project_brain",
    description=(
        "Search the project brain for clips relevant to a query or topic. "
        "Returns a ranked list of matching clips with their descriptions, "
        "durations, topics, and key quotes. Use this BEFORE loading full "
        "video metadata to find only the clips that matter for the user's "
        "request. The brain is a pre-built index — this call is instant."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="analysis",
    parameters=[
        _param(
            "query",
            "string",
            "Natural-language query describing what content to find "
            "(e.g. 'product demo', 'interview about pricing', 'outdoor shots').",
        ),
    ],
)

get_transcript_segment = _tool(
    name="get_transcript_segment",
    description=(
        "Get the transcribed dialogue for a specific time range of a video. "
        "Returns the transcript text for all speech between start_time and "
        "end_time. Use this to read what was said in a specific section "
        "before deciding whether to include it in an edit."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="analysis",
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the video asset.",
        ),
        _param(
            "start_time",
            "number",
            "Start of the time range in seconds.",
        ),
        _param(
            "end_time",
            "number",
            "End of the time range in seconds.",
        ),
    ],
)

decompose_video = _tool(
    name="decompose_video",
    description=(
        "Break a long video into scene-based sub-clip assets. The video must "
        "have been analyzed first (via get_video_metadata). Creates virtual "
        "sub-clips in the project bin organized by topic — each sub-clip "
        "references the original file with specific in/out points. Use this "
        "when a user imports a long video and you need to work with "
        "individual segments."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="analysis",
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the video asset to decompose.",
        ),
    ],
)

# ===================================================================
# REVIEW — edit quality evaluation tools
# ===================================================================

get_full_transcript = _tool(
    name="get_full_transcript",
    description=(
        "Return the complete dialogue transcript for an analyzed video asset "
        "with lines merged into sentences. Use this BEFORE making edits from "
        "long-form content — it gives you the full text with precise timestamps "
        "so you can select the best segments. Much more efficient than calling "
        "get_transcript_segment repeatedly with guessed time ranges."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="analysis",
    parameters=[
        _param(
            "asset_id",
            "string",
            "ID of the video asset (must have been analyzed first).",
        ),
    ],
)

review_edit_quality = _tool(
    name="review_edit_quality",
    description=(
        "Evaluate the quality of the current timeline edit by analyzing the "
        "transcript text of placed clips. Returns scores for hook quality, "
        "pacing, content relevance, closure, sentence completeness, and an "
        "overall score with specific feedback for improvement. Use this after "
        "placing clips to check quality, then iterate based on the feedback."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="review",
    parameters=[
        _param(
            "topic",
            "string",
            "The topic/theme of the edit (e.g. 'audio improvements in LTX 2.3').",
        ),
        _param(
            "edit_transcript",
            "string",
            "The concatenated transcript text of clips on the timeline, in order. "
            "Include timestamps: '[0.0s-5.2s] First sentence. [5.2s-10.0s] Second...'",
        ),
        _param(
            "target_duration",
            "number",
            "Target duration of the edit in seconds.",
            required=False,
        ),
    ],
)

review_edit_structure = _tool(
    name="review_edit_structure",
    description=(
        "Analyze the narrative structure of a timeline edit: hook/body/closure "
        "arc, sentence integrity, information density, and topic coherence. "
        "Returns a structure score with per-segment analysis and actionable "
        "recommendations. Use after review_edit_quality for deeper structural "
        "analysis, especially for long-form to short-form edits."
    ),
    execution_target=ExecutionTarget.BACKEND,
    category="review",
    parameters=[
        _param(
            "edit_transcript",
            "string",
            "The concatenated transcript text of the edit, with timestamps.",
        ),
        _param(
            "topic",
            "string",
            "The topic/theme of the edit.",
        ),
    ],
)

# ---------------------------------------------------------------------------
# Public registry
# ---------------------------------------------------------------------------

ALL_TOOLS: list[ToolDefinition] = [
    # Core (always included)
    get_timeline_state,
    get_project_assets,
    switch_view,
    # Clip editing
    trim_clip,
    split_clip,
    delete_clip,
    move_clip,
    add_clip_to_timeline,
    split_at_playhead,
    flip_clip,
    reverse_clip,
    set_clip_speed,
    duplicate_clip,
    # Clip properties
    set_clip_volume,
    set_clip_opacity,
    link_unlink_clips,
    set_color_correction,
    # Transitions
    add_dissolve,
    # Playback & navigation
    set_playhead,
    toggle_playback,
    step_frame,
    jump_to_edit_point,
    set_in_out_points,
    zoom_to_fit,
    # Timeline management
    duplicate_timeline,
    create_timeline,
    rename_timeline,
    undo,
    redo,
    # Track management
    add_track,
    delete_track,
    set_track_state,
    # Asset management
    create_subclip_assets,
    import_media,
    delete_asset,
    batch_delete_assets,
    organize_asset,
    set_active_take,
    regenerate_asset,
    # Generation
    generate_video,
    generate_image,
    retake_section,
    cancel_generation,
    get_generation_status,
    fill_timeline_gap,
    suggest_prompt,
    # Subtitles
    add_subtitle,
    edit_subtitle,
    set_subtitle_style,
    import_export_srt,
    # Export
    export_timeline,
    export_fcpxml,
    # Edit operations
    insert_edit,
    overwrite_edit,
    # Selection & UI
    select_clips,
    deselect_all,
    toggle_snap,
    set_active_tool,
    # Analysis (backend)
    get_video_metadata,
    query_project_brain,
    get_transcript_segment,
    decompose_video,
    get_full_transcript,
    # Review (backend)
    review_edit_quality,
    review_edit_structure,
]

TOOLS_BY_NAME: dict[str, ToolDefinition] = {tool.name: tool for tool in ALL_TOOLS}

# ---------------------------------------------------------------------------
# Gemini function-declaration converter
# ---------------------------------------------------------------------------

def _param_to_property(param: ToolParameter) -> dict[str, object]:
    """Convert a single ToolParameter to a JSON Schema property dict."""
    prop: dict[str, object] = {
        "type": param.type,
        "description": param.description,
    }
    if param.items is not None:
        prop["items"] = param.items
    return prop


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
