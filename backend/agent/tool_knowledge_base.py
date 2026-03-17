"""Category-based tool knowledge base with intent classification.

Organizes tools into semantic categories and provides an intent classifier
that selects only the relevant tool categories for a given user prompt.
This keeps the Gemini function-calling payload focused (15-25 tools
instead of 60+) which improves tool selection accuracy and reduces
token cost.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .tool_registry import ALL_TOOLS, TOOLS_BY_NAME
from .types import ToolDefinition


@dataclass(frozen=True)
class WorkflowRecipe:
    """A common multi-tool workflow pattern shown in the system prompt."""

    name: str
    description: str
    steps: list[str]


@dataclass(frozen=True)
class ToolCategory:
    """A logical grouping of related tools."""

    name: str
    display_name: str
    description: str
    keywords: list[str]
    tool_names: list[str]
    depends_on: list[str] = field(default_factory=list)
    workflows: list[WorkflowRecipe] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Category definitions
# ---------------------------------------------------------------------------

CATEGORIES: dict[str, ToolCategory] = {
    "core": ToolCategory(
        name="core",
        display_name="Core",
        description="Read timeline state and project assets",
        keywords=[],
        tool_names=["get_timeline_state", "get_project_assets", "switch_view"],
    ),
    "clip_editing": ToolCategory(
        name="clip_editing",
        display_name="Clip Editing",
        description="Trim, split, delete, move, duplicate, speed, flip, and reverse clips",
        keywords=[
            "trim", "cut", "split", "delete", "remove", "move", "duplicate",
            "speed", "slow", "fast", "flip", "reverse", "clip", "shorten",
            "lengthen", "extend", "crop", "razor", "blade", "rearrange",
            "reorder", "swap", "shift", "nudge", "ripple",
        ],
        tool_names=[
            "trim_clip", "split_clip", "delete_clip", "move_clip",
            "add_clip_to_timeline", "split_at_playhead", "flip_clip",
            "reverse_clip", "set_clip_speed", "duplicate_clip",
        ],
        workflows=[
            WorkflowRecipe(
                name="cut_and_rearrange",
                description="Cut, trim, and rearrange clips on the timeline",
                steps=[
                    "get_timeline_state",
                    "split_clip at cut points",
                    "delete_clip(ripple=true) to remove unwanted sections",
                    "move_clip to rearrange remaining clips",
                ],
            ),
            WorkflowRecipe(
                name="content_aware_edit",
                description="Trim every clip to its strongest segment using video metadata. Use this for ANY editing request.",
                steps=[
                    "get_timeline_state to see current clips",
                    "For EACH clip: get_video_metadata(asset_id) to get scenes with importance scores",
                    "For EACH clip: identify the strongest scene (importance > 0.7). Calculate trim_start_delta = strongest_scene.start_time - clip.trimStart. Calculate trim_end_delta = (clip_total_duration - strongest_scene.end_time) - clip.trimEnd",
                    "trim_clip(clip_id, trim_start_delta=..., trim_end_delta=...) to keep only the best content",
                    "Close all gaps: move_clip each clip so they butt up against the previous one",
                    "Vary pacing: shorter clips (3-5s) for energy/action, longer (8-12s) for establishing/wide shots",
                ],
            ),
            WorkflowRecipe(
                name="documentary_edit",
                description="Edit clips into a documentary style with varied pacing and professional structure",
                steps=[
                    "Analyze ALL clips with get_video_metadata to understand content, scenes, shot_types",
                    "Plan structure: opening wide shot (5-8s) → medium shots for main content (4-6s each) → close-ups for detail (3-4s) → closing wide shot (5-8s)",
                    "Trim EACH clip to its strongest scene: use importance scores and shot_type from metadata. wide/aerial → 5-8s, medium → 4-6s, close-up → 3-4s",
                    "Arrange clips to alternate shot types (wide → medium → close → medium → wide) for visual variety",
                    "Use hard cuts between clips by default. Only add dissolves at major section transitions (time jumps, topic shifts)",
                    "review_edit_quality to score the edit. If score < 7, tighten the weakest clips and re-review",
                ],
            ),
            WorkflowRecipe(
                name="social_media_edit",
                description="Fast-paced social media cut (30-60s) with quick cuts and high energy",
                steps=[
                    "Target total duration: 30-60 seconds. Calculate clips needed: total_target / 4s_avg = ~10-15 clips",
                    "For EACH clip: get_video_metadata → find the single most important/dynamic scene",
                    "trim_clip to keep ONLY 2-5 seconds of the best action from each clip",
                    "Move all clips tight together with zero gaps between them",
                    "NO dissolves — use hard cuts for energy and pace",
                    "Verify: get_timeline_state → total duration should be 30-60s, no clip longer than 5s",
                ],
            ),
            WorkflowRecipe(
                name="trim_to_highlights",
                description="Trim all clips on the timeline to their highlight moments — use for any 'make it tighter' or 'edit this' request",
                steps=[
                    "get_timeline_state to see all clips",
                    "For EACH clip: get_video_metadata(asset_id) to get scene importance scores",
                    "For EACH clip: find the highest-importance scene. Calculate trim deltas to remove everything before and after that scene",
                    "Apply trim_clip(clip_id, trim_start_delta=..., trim_end_delta=...) for EACH clip",
                    "Close all gaps: move_clip to slide clips left so they are contiguous",
                    "review_edit_quality to verify the edit is tight and well-paced",
                ],
            ),
            WorkflowRecipe(
                name="compilation_edit",
                description="Edit a collection of clips into an organic, well-paced compilation with professional rhythm",
                steps=[
                    "Analyze ALL clips: get_video_metadata for each to understand shot_type, importance, scenes",
                    "Plan shot order and durations using the rhythm curve: establish (5-10s wide) → build (3-6s medium) → detail (2-4s close) → breathe (6-10s wide) → climax (1.5-3s rapid) → resolve (5-10s calm)",
                    "Verify: no adjacent clips within 30% duration of each other. Replan if needed.",
                    "Place clips with add_clip_to_timeline in your planned order",
                    "Trim EACH clip: get_video_metadata → find best scene → trim_clip to planned duration",
                    "Close all gaps: move_clip to make clips contiguous",
                    "review_edit_quality to score. If score < 7, re-trim weakest clips and re-review",
                ],
            ),
        ],
    ),
    "clip_properties": ToolCategory(
        name="clip_properties",
        display_name="Clip Properties",
        description="Volume, opacity, color correction, and clip linking",
        keywords=[
            "volume", "opacity", "transparent", "mute", "unmute", "loud",
            "quiet", "color", "brightness", "contrast", "saturation",
            "temperature", "warm", "cool", "link", "unlink", "correction",
        ],
        tool_names=[
            "set_clip_volume", "set_clip_opacity",
            "link_unlink_clips", "set_color_correction",
        ],
    ),
    "transitions": ToolCategory(
        name="transitions",
        display_name="Transitions",
        description="Add dissolves and transitions between clips",
        keywords=[
            "dissolve", "transition", "fade", "wipe", "cross", "blend",
            "crossfade",
        ],
        tool_names=["add_dissolve"],
    ),
    "playback": ToolCategory(
        name="playback",
        display_name="Playback & Navigation",
        description="Play, pause, step frames, jump to edits, zoom timeline",
        keywords=[
            "play", "pause", "stop", "step", "frame", "navigate", "zoom",
            "fit", "jump", "scrub", "seek", "forward", "backward", "rewind",
            "preview", "in point", "out point", "mark",
        ],
        tool_names=[
            "set_playhead", "toggle_playback", "step_frame",
            "jump_to_edit_point", "set_in_out_points", "zoom_to_fit",
        ],
    ),
    "timeline_mgmt": ToolCategory(
        name="timeline_mgmt",
        display_name="Timeline Management",
        description="Create, duplicate, rename timelines; undo/redo",
        keywords=[
            "timeline", "new timeline", "duplicate timeline", "rename",
            "undo", "redo", "revert", "history", "snapshot", "backup",
        ],
        tool_names=[
            "duplicate_timeline", "create_timeline", "rename_timeline",
            "undo", "redo",
        ],
    ),
    "track_mgmt": ToolCategory(
        name="track_mgmt",
        display_name="Track Management",
        description="Add, delete, mute, lock, and solo tracks",
        keywords=[
            "track", "add track", "new track", "delete track", "remove track",
            "mute track", "lock", "solo", "enable", "disable", "hide track",
            "show track", "audio track", "video track",
        ],
        tool_names=["add_track", "delete_track", "set_track_state"],
    ),
    "asset_mgmt": ToolCategory(
        name="asset_mgmt",
        display_name="Asset Management",
        description="Import, delete, organize assets; manage takes and sub-clips",
        keywords=[
            "import", "asset", "bin", "favorite", "take", "organize",
            "media", "file", "browse", "sub-clip", "subclip",
            "delete", "remove", "name", "rename", "tag", "label",
        ],
        tool_names=[
            "create_subclip_assets", "import_media", "delete_asset",
            "batch_delete_assets", "organize_asset", "set_active_take",
            "regenerate_asset",
        ],
    ),
    "generation": ToolCategory(
        name="generation",
        display_name="Content Generation",
        description="Generate videos (T2V/I2V/A2V), images, retakes, and fill gaps",
        keywords=[
            "generate", "create video", "create image", "make", "produce",
            "animate", "render", "image to video", "text to video",
            "audio to video", "t2v", "i2v", "a2v", "t2i",
            "retake", "regenerate", "fill gap", "suggest prompt",
            "ai generate", "synthesize",
        ],
        tool_names=[
            "generate_video", "generate_image", "retake_section",
            "cancel_generation", "get_generation_status",
            "fill_timeline_gap", "suggest_prompt",
        ],
        depends_on=["asset_mgmt"],
        workflows=[
            WorkflowRecipe(
                name="image_then_animate",
                description="Generate an image then animate it to video",
                steps=[
                    "generate_image(prompt=...) -> returns asset_id",
                    "generate_video(mode='image_to_video', image_asset_id=<asset_id>, prompt=...)",
                    "add_clip_to_timeline(asset_id=<video_asset_id>, ...)",
                ],
            ),
            WorkflowRecipe(
                name="generate_and_place",
                description="Generate a video and place it on the timeline",
                steps=[
                    "generate_video(mode='text_to_video', prompt=...)",
                    "add_clip_to_timeline(asset_id=<result>, track_index=0, start_time=...)",
                ],
            ),
            WorkflowRecipe(
                name="fill_gap",
                description="AI-fill a gap in the timeline",
                steps=[
                    "fill_timeline_gap(gap_start_time=..., gap_duration=..., track_index=..., mode=...)",
                ],
            ),
        ],
    ),
    "subtitles": ToolCategory(
        name="subtitles",
        display_name="Subtitles",
        description="Add, edit, and style subtitles; import/export SRT",
        keywords=[
            "subtitle", "caption", "srt", "text overlay", "text on screen",
            "title", "lower third",
        ],
        tool_names=[
            "add_subtitle", "edit_subtitle", "set_subtitle_style",
            "import_export_srt",
        ],
        workflows=[
            WorkflowRecipe(
                name="add_subtitles",
                description="Add subtitles to the timeline",
                steps=[
                    "add_track(kind='subtitle') if no subtitle track exists",
                    "add_subtitle(track_index=..., start_time=..., duration=..., text=...) for each subtitle",
                    "set_subtitle_style(track_index=..., font_family=..., font_size=..., color=...)",
                ],
            ),
        ],
    ),
    "export": ToolCategory(
        name="export",
        display_name="Export",
        description="Render timeline to video file or export as FCP XML",
        keywords=[
            "export", "render", "publish", "fcp", "xml", "final cut",
            "save video", "output", "encode",
        ],
        tool_names=["export_timeline", "export_fcpxml"],
    ),
    "editing_ops": ToolCategory(
        name="editing_ops",
        display_name="Edit Operations",
        description="3-point insert and overwrite edits",
        keywords=[
            "insert edit", "overwrite", "3-point", "three point",
            "source monitor", "insert at playhead",
        ],
        tool_names=["insert_edit", "overwrite_edit"],
    ),
    "selection_ui": ToolCategory(
        name="selection_ui",
        display_name="Selection & UI",
        description="Select clips, toggle snap, switch editing tools",
        keywords=[
            "select", "deselect", "snap", "snapping", "magnet",
            "tool", "blade tool", "selection tool", "ripple tool",
        ],
        tool_names=[
            "select_clips", "deselect_all", "toggle_snap", "set_active_tool",
        ],
    ),
    "analysis": ToolCategory(
        name="analysis",
        display_name="Analysis & Intelligence",
        description="Video metadata, project brain search, transcripts, decomposition",
        keywords=[
            "analyze", "analyse", "metadata", "transcript", "brain",
            "decompose", "search", "find clip", "scene", "dialogue",
            "topic", "content", "what happens", "full transcript",
        ],
        tool_names=[
            "get_video_metadata", "query_project_brain",
            "get_transcript_segment", "decompose_video",
            "get_full_transcript",
        ],
    ),
    "review": ToolCategory(
        name="review",
        display_name="Edit Quality Review",
        description="Review and score the quality of timeline edits, get structural feedback",
        keywords=[
            "review", "quality", "score", "evaluate", "check edit",
            "improve edit", "feedback", "refine", "iterate", "polish",
            "hook", "pacing", "closure", "structure",
        ],
        tool_names=[
            "review_edit_quality", "review_edit_structure",
        ],
        depends_on=["clip_editing", "analysis"],
        workflows=[
            WorkflowRecipe(
                name="iterative_edit",
                description="Make an edit, review quality, and iterate to improve",
                steps=[
                    "get_full_transcript(asset_id) to read all dialogue",
                    "Select segments and add_clip_to_timeline x N",
                    "get_timeline_state() to see what's placed",
                    "review_edit_quality(topic, edit_transcript) to score",
                    "If score < 8: adjust clips based on feedback, re-review",
                    "review_edit_structure(edit_transcript, topic) for deeper analysis",
                ],
            ),
        ],
    ),
    "memory": ToolCategory(
        name="memory",
        display_name="Project Memory",
        description="Save and retrieve persistent project context: scripts, research, preferences, decisions",
        keywords=[
            "memory", "remember", "save", "context", "script", "research",
            "storyboard", "notes", "preference", "decision", "like",
            "dislike", "feedback", "history", "recall", "previous",
            "write down", "note", "record", "document",
        ],
        tool_names=[
            "save_to_project_memory", "update_project_memory",
            "read_project_memory", "list_project_memory",
            "add_memory_note", "update_project_context",
        ],
        workflows=[
            WorkflowRecipe(
                name="save_creative_output",
                description="Save a creative artifact to project memory for cross-session persistence",
                steps=[
                    "list_project_memory() to check if related documents exist",
                    "save_to_project_memory(title, type, content, description, tags)",
                    "update_project_context(content) to update the master context summary",
                ],
            ),
            WorkflowRecipe(
                name="record_user_preference",
                description="Record user feedback, preferences, or decisions for future agents",
                steps=[
                    "add_memory_note(note) with specific details about the preference",
                    "If significant: update_project_context(content) to reflect the change",
                ],
            ),
        ],
    ),
}


# ---------------------------------------------------------------------------
# View-based category filtering
# ---------------------------------------------------------------------------

ALLOWED_CATEGORIES_BY_VIEW: dict[str, set[str]] = {
    "editor": set(CATEGORIES.keys()),
    "genspace": {"core", "generation", "asset_mgmt", "analysis", "clip_editing", "timeline_mgmt", "track_mgmt", "memory"},
    "playground": {"generation"},
}

EXCLUDED_TOOLS_BY_VIEW: dict[str, set[str]] = {
    "editor": set(),
    "genspace": {"get_timeline_state"},
    "playground": {"get_timeline_state", "get_project_assets"},
}


def filter_categories_for_view(
    categories: list[str],
    view_context: str,
) -> list[str]:
    """Filter categories to only those allowed for the given view context."""
    allowed = ALLOWED_CATEGORIES_BY_VIEW.get(view_context, ALLOWED_CATEGORIES_BY_VIEW["editor"])
    return [c for c in categories if c in allowed]


def get_tools_for_categories_and_view(
    category_names: list[str],
    view_context: str = "editor",
) -> list[ToolDefinition]:
    """Return tools for given categories, excluding tools not available in the view."""
    excluded = EXCLUDED_TOOLS_BY_VIEW.get(view_context, set())
    seen: set[str] = set()
    tools: list[ToolDefinition] = []
    for cat_name in category_names:
        cat = CATEGORIES.get(cat_name)
        if cat is None:
            continue
        for tool_name in cat.tool_names:
            if tool_name in seen or tool_name in excluded:
                continue
            seen.add(tool_name)
            tool = TOOLS_BY_NAME.get(tool_name)
            if tool is not None:
                tools.append(tool)
    return tools


# ---------------------------------------------------------------------------
# Intent classifier
# ---------------------------------------------------------------------------

_WORD_BOUNDARY = re.compile(r"\b")


def classify_intent(user_prompt: str) -> list[str]:
    """Classify a user prompt into relevant tool categories.

    Returns a list of category names. Always includes 'core'.
    Falls back to ALL categories if nothing matches.
    """
    prompt_lower = user_prompt.lower()
    matched: set[str] = set()

    for cat_name, cat in CATEGORIES.items():
        if cat_name == "core":
            continue
        for keyword in cat.keywords:
            if keyword in prompt_lower:
                matched.add(cat_name)
                break

    # Resolve dependencies
    extra: set[str] = set()
    for cat_name in matched:
        cat = CATEGORIES[cat_name]
        for dep in cat.depends_on:
            extra.add(dep)
    matched |= extra

    # Fallback: if nothing matched, include everything
    if not matched:
        matched = {name for name in CATEGORIES if name != "core"}

    matched.add("core")
    return sorted(matched)


def get_tools_for_categories(category_names: list[str]) -> list[ToolDefinition]:
    """Return the deduplicated list of tools for the given categories."""
    seen: set[str] = set()
    tools: list[ToolDefinition] = []
    for cat_name in category_names:
        cat = CATEGORIES.get(cat_name)
        if cat is None:
            continue
        for tool_name in cat.tool_names:
            if tool_name in seen:
                continue
            seen.add(tool_name)
            tool = TOOLS_BY_NAME.get(tool_name)
            if tool is not None:
                tools.append(tool)
    return tools


def get_tools_for_prompt(user_prompt: str) -> list[ToolDefinition]:
    """Classify intent and return only the tools relevant to the prompt."""
    categories = classify_intent(user_prompt)
    return get_tools_for_categories(categories)


# ---------------------------------------------------------------------------
# System prompt helpers
# ---------------------------------------------------------------------------

def build_category_catalog(category_names: list[str]) -> str:
    """Build a compact tool catalog section for the system prompt.

    Only includes the active categories so the model knows what's available.
    """
    lines: list[str] = ["## Available Tool Categories\n"]
    for cat_name in sorted(category_names):
        cat = CATEGORIES.get(cat_name)
        if cat is None:
            continue
        tool_list = ", ".join(f"`{t}`" for t in cat.tool_names)
        lines.append(f"### {cat.display_name}\n{cat.description}\nTools: {tool_list}\n")

    return "\n".join(lines)


def build_workflow_recipes(category_names: list[str]) -> str:
    """Build workflow recipe section for included categories."""
    recipes: list[str] = []
    for cat_name in category_names:
        cat = CATEGORIES.get(cat_name)
        if cat is None:
            continue
        for wf in cat.workflows:
            steps = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(wf.steps))
            recipes.append(f"**{wf.name}** — {wf.description}\n{steps}")

    if not recipes:
        return ""
    return "## Workflow Recipes\n\n" + "\n\n".join(recipes)
