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

- **creative**: Produces text output (scripts, concepts, visual style guides, \
  shot lists). The sub-agent writes text that later tasks will use.
- **execution**: Performs actions via tool calls (generating images/videos, \
  creating timelines, editing clips, adding transitions). The sub-agent \
  MUST call tools — text-only responses are not acceptable for execution tasks.
- **review**: Evaluates the output of prior tasks and provides feedback. \
  If quality is insufficient, the orchestrator will create correction tasks.

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

## Rules

- Each task must be a single, verifiable unit of work.
- Identify dependencies: if task B needs the output of task A, list A \
  in B's `depends_on` array.
- Maximize parallelism: independent tasks should NOT depend on each other.
- Assign the best skill from the catalog. Use `null` for general tasks.
- Execution tasks MUST list the tool_categories they need.
- For multi-step generation workflows (e.g. "generate images then animate \
  them then edit on timeline"), create SEPARATE execution tasks with \
  dependencies — do NOT combine all into one task.
- After execution tasks that generate or edit content, add a review task \
  to evaluate quality (using the directing or editing skill).
- Keep task descriptions imperative: "Generate 5 product images using \
  generate_image" not "The images should be generated."

## Available Skills
{skill_catalog}

## Output Format
Return ONLY valid JSON matching this schema:
{{
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

Task IDs: "task-1", "task-2", etc.
context_requirements: "timeline_state", "asset_metadata", "prior_results".

## Example Decomposition

User: "Create a 30-second ad with 5 product shots, animate them, edit into a montage"

{{
  "tasks": [
    {{
      "id": "task-1",
      "description": "Write 5 product shot descriptions with visual details, lighting, and camera angles for AI generation",
      "skill_id": "advertising-screenwriter",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-2",
      "description": "Generate 5 product images using generate_image based on the shot descriptions from task-1, then animate each into video using generate_video with image_to_video mode",
      "skill_id": "ai-video-producer",
      "task_type": "execution",
      "depends_on": ["task-1"],
      "tool_categories": ["generation"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-3",
      "description": "Review the generated videos for visual quality, consistency, and suitability. Flag any that need regeneration.",
      "skill_id": "directing",
      "task_type": "review",
      "depends_on": ["task-2"],
      "tool_categories": ["core"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-4",
      "description": "Create a new timeline using create_timeline, add all generated clips using add_clip_to_timeline in sequence, trim dead frames with trim_clip, add dissolve transitions, and adjust pacing for a 30-second montage",
      "skill_id": "tv-film-editing",
      "task_type": "execution",
      "depends_on": ["task-2", "task-3"],
      "tool_categories": ["timeline_mgmt", "clip_editing", "transitions"],
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


def _parse_planner_response(text: str) -> list[dict[str, Any]]:
    """Extract the tasks array from the planner's JSON response."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    data = json.loads(text)
    if isinstance(data, dict) and "tasks" in data:
        return data["tasks"]  # type: ignore[no-any-return]
    if isinstance(data, list):
        return data  # type: ignore[no-any-return]
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
            raw_tasks = _parse_planner_response(text)

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
            "Task planner produced %d task(s) for prompt: %.80s",
            len(tasks),
            prompt,
        )
        return TaskDAG(tasks=tasks, original_prompt=prompt)

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
