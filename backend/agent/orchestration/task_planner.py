"""Decompose a complex user request into a DAG of executable tasks.

Makes a single Gemini call with the user prompt, available skill
descriptors, and current project context.  Returns a validated
``TaskDAG`` with dependency edges and skill assignments.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from agent.types import (
    SkillDescriptor,
    TaskDAG,
    TaskNode,
    TaskStatus,
    TaskType,
)
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_PLANNER_MODEL = "gemini-3-flash-preview"

_PLANNER_SYSTEM_PROMPT = """\
You are a task decomposition planner for LTX Desktop, a professional \
AI video editing application. Sub-agents execute tasks by calling tools.

Given a user request, break it into tasks that can be executed by \
specialized sub-agents. Each task is one of three types:

- **creative**: Produces text output (scripts, shot lists, visual style \
  guides). The sub-agent writes detailed text that later tasks will use. \
  Creative tasks MUST produce structured, numbered output that downstream \
  tasks can follow precisely.
- **execution**: Performs actions via tool calls (generating images/videos, \
  creating timelines, editing clips). The sub-agent MUST call tools — \
  text-only responses are not acceptable for execution tasks.
- **review**: Evaluates the output of prior tasks against the original \
  script/plan. Reviews MUST compare each generated shot against the \
  corresponding shot description. If quality is insufficient, the \
  orchestrator will create correction tasks.

## Available Tools by Category

- **generation**: generate_image, generate_video (text_to_video, \
  image_to_video, audio_to_video), retake_section, fill_timeline_gap
- **clip_editing**: trim_clip, split_clip, delete_clip, move_clip, \
  add_clip_to_timeline, set_clip_speed, flip_clip, reverse_clip, duplicate_clip
- **timeline_mgmt**: create_timeline, duplicate_timeline, rename_timeline
- **transitions**: add_dissolve
- **subtitles**: add_subtitle, edit_subtitle, set_subtitle_style
- **clip_properties**: set_clip_volume, set_clip_opacity, set_color_correction
- **asset_mgmt**: create_subclip_assets, organize_asset
- **analysis**: get_video_metadata, query_project_brain, get_full_transcript
- **review**: review_edit_quality, review_edit_structure

## CRITICAL: Duration Estimation

Before planning any video production, you MUST estimate the target duration \
based on the content described. Do NOT default to 30 seconds.

**Step 1: Estimate duration from content.**
If the user specifies a duration, use it. If not, estimate based on content:
- Social clip / reaction: 10-20s
- Short ad / promo: 20-40s
- Single scene beat (one moment, one action): 30-60s
- Standard scene (setup + development + turn): 60-120s
- Full scene with dialogue and story beats: 2-5 minutes (120-300s)
- Multi-scene short film: 5-10 minutes (300-600s)

Key signals for longer durations:
- Dialogue or conversation between characters -> at least 2-3 minutes
- Multiple locations or scene changes -> at least 3-5 minutes
- Story arc with setup, conflict, resolution -> at least 2-4 minutes
- Words like "full scene", "short film", "narrative" -> at least 2 minutes

**Step 2: Derive shot count from duration.**
- Fast-paced (ads, montage): 1 shot per 3-4 seconds
- Standard pacing: 1 shot per 5-7 seconds
- Slow/cinematic (A24, drama): 1 shot per 6-10 seconds

Examples:
- 30s ad: 6-10 shots
- 60s brand film: 8-12 shots
- 2-minute scene: 15-25 shots
- 4-minute scene with dialogue: 30-45 shots
- 5-minute short film: 40-60 shots

**Include `target_duration_seconds` in your output.** The script task \
description MUST reference this target duration. All downstream tasks \
(timeline assembly, review) MUST use this duration as their target.

## CRITICAL: Production Pipeline Rules

For ANY request to create a video, scene, ad, short film, or visual sequence:

1. **ALWAYS start with a script task.** The script MUST include:
   - Scene descriptions with dialogue (if applicable)
   - A NUMBERED shot list where each shot has: visual description (what the \
     camera sees AND any dialogue the characters speak — write dialogue \
     directly into the description), shot type (wide/medium/close-up), \
     camera motion, and duration
   - The total shot count derived from your target_duration_seconds estimate
   - The target duration referenced explicitly in the task description
   - The output MUST use the format "Shot 1:", "Shot 2:", etc.

2. **Visual style MUST be a separate task** that defines color palette, \
   lighting approach, and framing guide for the entire project.

3. **Generation MUST be a separate execution task** that generates \
   EVERY shot from the script. The orchestrator will expand this into \
   per-shot parallel tasks automatically. Label this task description \
   as: "Generate all shots from the shot list: generate each image \
   with generate_image then animate with generate_video image_to_video"

4. **Review MUST compare against the script.** The reviewer receives \
   both the script and the generation results. It must evaluate each \
   shot by number against the script description and flag specific \
   shots that need regeneration.

5. **Timeline assembly is a separate execution task** that creates a \
   timeline, adds all clips, trims dead frames, adjusts pacing, and \
   adds transitions.

6. **Final edit review** evaluates the assembled timeline for pacing, \
   continuity, and overall quality.

NEVER combine script-writing and generation into one task. \
NEVER combine generation and timeline editing into one task. \
NEVER skip the script step — every generated shot must trace back \
to a numbered shot description.

## General Rules

- Each task must be a single, verifiable unit of work.
- Identify dependencies: if task B needs the output of task A, list A \
  in B's `depends_on` array.
- Maximize parallelism: independent tasks should NOT depend on each other.
- Assign the best skill from the catalog. Use `null` for general tasks.
- Execution tasks MUST list the tool_categories they need.
- Keep task descriptions imperative and specific.

## Available Skills
{skill_catalog}

## Output Format
Return ONLY valid JSON matching this schema:
{{
  "target_duration_seconds": 180,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Imperative description of what to do",
      "skill_id": "skill-id-or-null",
      "task_type": "creative|execution|review",
      "depends_on": [],
      "tool_categories": ["generation", "clip_editing"],
      "context_requirements": ["timeline_state"]
    }}
  ]
}}

**target_duration_seconds** (required): Your estimated target duration \
for the final video in seconds. This is derived from the content analysis \
in the Duration Estimation section above. Must be a positive number.

Task IDs: "task-1", "task-2", etc.
context_requirements: "timeline_state", "asset_metadata", "prior_results".

## Example: "Create an A24-style scene of a couple at a diner having a tense conversation"

Note: The user did NOT specify a duration. A scene with dialogue between \
two characters has multiple dramatic beats (arrival, settling in, conversation \
develops, tension builds, resolution). This requires ~3 minutes.

{{
  "target_duration_seconds": 180,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Write a detailed script for a ~3-minute A24-style diner scene. The couple's conversation should have multiple beats: arrival and settling in, casual talk that reveals subtext, a tension shift, and an unresolved ending. Include a NUMBERED shot list with 25-30 shots. Each shot must specify: visual description, shot type (wide/medium/close-up/detail), camera motion, duration in seconds, and any dialogue as subtitle text. Use format 'Shot 1:', 'Shot 2:', etc. Target total duration ~180 seconds. Vary shot durations: 4-6s for quick reactions, 6-10s for dialogue beats, 8-12s for establishing and emotional holds.",
      "skill_id": "film-tv-screenwriting",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-2",
      "description": "Define the A24 visual style for this diner scene: color palette (warm tungsten with cool shadows), lighting approach (practical sources, neon signs, overhead fluorescents), framing philosophy (off-center compositions, negative space), and grain/texture. Describe how each shot type should look visually for AI generation prompts.",
      "skill_id": "cinematography",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-3",
      "description": "Generate all shots from the shot list: for EACH numbered shot in the script from task-1, generate an image with generate_image using the visual style from task-2, then animate it into a video clip with generate_video in image_to_video mode. Generate EVERY shot listed — do not skip any.",
      "skill_id": "ai-video-producer",
      "task_type": "execution",
      "depends_on": ["task-1", "task-2"],
      "tool_categories": ["generation"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-4",
      "description": "Review each generated shot against the script from task-1. For EACH shot by number, verify: does the visual match the shot description? Is the framing correct? Does it fit the A24 aesthetic from task-2? Flag specific shots that need regeneration and explain why.",
      "skill_id": "directing",
      "task_type": "review",
      "depends_on": ["task-1", "task-3"],
      "tool_categories": ["core"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-5",
      "description": "Create a new timeline with create_timeline. Add ALL generated video clips in script order using add_clip_to_timeline. Trim dead frames from each clip head/tail with trim_clip. Close all gaps. Use hard cuts between clips by default. Only add a dissolve at major section breaks (time jumps or location changes). Adjust pacing: hold longer on emotional close-ups, cut tighter on wide establishing shots. Target total duration ~180 seconds.",
      "skill_id": "tv-film-editing",
      "task_type": "execution",
      "depends_on": ["task-3", "task-4"],
      "tool_categories": ["timeline_mgmt", "clip_editing", "transitions", "playback"],
      "context_requirements": ["prior_results", "timeline_state"]
    }},
    {{
      "id": "task-6",
      "description": "Review the final edited timeline. Check: total duration (~180s), pacing rhythm, shot-to-shot continuity, whether the emotional subtext from the script is preserved, and whether the A24 aesthetic is maintained. Flag specific edits that need adjustment.",
      "skill_id": "tv-film-editing",
      "task_type": "review",
      "depends_on": ["task-5"],
      "tool_categories": ["core"],
      "context_requirements": ["prior_results", "timeline_state"]
    }}
  ]
}}
"""


def _build_skill_catalog(descriptors: list[SkillDescriptor]) -> str:
    """Format skill descriptors into a compact catalog for the planner."""
    if not descriptors:
        return "(no specialized skills available — use null for all tasks)"

    lines: list[str] = []
    for d in descriptors:
        cats = ", ".join(d.tool_categories) if d.tool_categories else "general"
        lines.append(f"- **{d.id}** ({d.name}): {d.description} [categories: {cats}]")
    return "\n".join(lines)


def _validate_dag(tasks: list[TaskNode]) -> list[TaskNode]:
    """Validate the DAG is acyclic and fix common issues.

    Removes unknown dependency references and detects cycles via
    topological sort.  If a cycle is detected, all dependency edges
    within the cycle are removed (tasks become independent).
    """
    task_ids = {t.id for t in tasks}

    for task in tasks:
        task.depends_on = [d for d in task.depends_on if d in task_ids]

    visited: set[str] = set()
    in_stack: set[str] = set()
    cycle_nodes: set[str] = set()
    adj: dict[str, list[str]] = {t.id: list(t.depends_on) for t in tasks}

    def _dfs(node_id: str) -> bool:
        visited.add(node_id)
        in_stack.add(node_id)
        for dep in adj.get(node_id, []):
            if dep in in_stack:
                cycle_nodes.add(node_id)
                cycle_nodes.add(dep)
                return True
            if dep not in visited and _dfs(dep):
                cycle_nodes.add(node_id)
                return True
        in_stack.discard(node_id)
        return False

    for t in tasks:
        if t.id not in visited:
            _dfs(t.id)

    if cycle_nodes:
        logger.warning(
            "DAG cycle detected among tasks %s — removing cycle edges",
            cycle_nodes,
        )
        for task in tasks:
            if task.id in cycle_nodes:
                task.depends_on = [
                    d for d in task.depends_on if d not in cycle_nodes
                ]

    return tasks


def _parse_planner_response(text: str) -> tuple[list[dict[str, Any]], float | None]:
    """Extract tasks and target_duration_seconds from the planner's JSON response.

    Returns (tasks, target_duration_seconds).
    """
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    data = json.loads(text)
    target_duration: float | None = None

    if isinstance(data, dict):
        raw_duration = data.get("target_duration_seconds")
        if raw_duration is not None:
            try:
                target_duration = float(raw_duration)
            except (TypeError, ValueError):
                pass
        if "tasks" in data:
            return data["tasks"], target_duration  # type: ignore[return-value]

    if isinstance(data, list):
        return data, None  # type: ignore[return-value]
    raise ValueError(f"Unexpected planner response shape: {type(data)}")


class TaskPlanner:
    """Decomposes user prompts into executable task DAGs via Gemini."""

    def __init__(self, api_key: str, http_client: HTTPClient) -> None:
        self._api_key = api_key
        self._http_client = http_client

    def decompose(
        self,
        prompt: str,
        available_skills: list[SkillDescriptor],
        timeline_context: str | None = None,
        assets_context: str | None = None,
    ) -> TaskDAG:
        """Break a user request into a validated TaskDAG.

        Makes one Gemini call.  Falls back to a single-task DAG if
        the LLM response cannot be parsed.
        """
        skill_catalog = _build_skill_catalog(available_skills)
        system_prompt = _PLANNER_SYSTEM_PROMPT.format(skill_catalog=skill_catalog)

        user_parts: list[str] = []
        if timeline_context:
            user_parts.append(f"## Current Timeline\n{timeline_context}")
        if assets_context:
            user_parts.append(f"## Available Assets\n{assets_context}")
        user_parts.append(f"## User Request\n{prompt}")
        user_message = "\n\n".join(user_parts)

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{_PLANNER_MODEL}:generateContent"
        )
        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": user_message}]}],
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 4096,
                "responseMimeType": "application/json",
            },
        }

        try:
            resp = self._http_client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": self._api_key,
                },
                json_payload=payload,
                timeout=60,
            )

            if resp.status_code != 200:
                logger.error(
                    "Planner Gemini call failed with HTTP %d: %s",
                    resp.status_code,
                    resp.text[:300],
                )
                return self._fallback_dag(prompt)

            body = resp.json()
            text = body["candidates"][0]["content"]["parts"][0]["text"]
            raw_tasks, target_duration = _parse_planner_response(text)

        except Exception:
            logger.error("Task planner failed", exc_info=True)
            return self._fallback_dag(prompt)

        task_type_map = {
            "creative": TaskType.CREATIVE,
            "execution": TaskType.EXECUTION,
            "review": TaskType.REVIEW,
        }

        tasks: list[TaskNode] = []
        for raw in raw_tasks:
            raw_type = raw.get("task_type", "execution")
            tasks.append(TaskNode(
                id=raw.get("id", f"task-{uuid.uuid4().hex[:6]}"),
                description=raw.get("description", ""),
                skill_id=raw.get("skill_id"),
                depends_on=raw.get("depends_on", []),
                status=TaskStatus.PENDING,
                task_type=task_type_map.get(raw_type, TaskType.EXECUTION),
                tool_categories=raw.get("tool_categories", []),
                context_requirements=raw.get("context_requirements", []),
            ))

        tasks = _validate_dag(tasks)

        logger.info(
            "Task planner produced %d task(s) for prompt: %.80s | target_duration=%s",
            len(tasks),
            prompt,
            target_duration,
        )
        return TaskDAG(
            tasks=tasks,
            original_prompt=prompt,
            target_duration_seconds=target_duration,
        )

    @staticmethod
    def _fallback_dag(prompt: str) -> TaskDAG:
        """Create a single-task DAG as a fallback when planning fails."""
        return TaskDAG(
            tasks=[
                TaskNode(
                    id="task-1",
                    description=prompt,
                    skill_id=None,
                    depends_on=[],
                    status=TaskStatus.PENDING,
                    tool_categories=["core"],
                    context_requirements=["timeline_state"],
                )
            ],
            original_prompt=prompt,
        )
