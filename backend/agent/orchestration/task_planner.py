"""Decompose a complex user request into a DAG of executable tasks.

Makes a single Gemini call with the user prompt, available skill
descriptors, and current project context.  Returns a validated
``TaskDAG`` with dependency edges and skill assignments.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, cast

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

## Scope Matching — Read This First

Your job is to decompose the user's ACTUAL request into tasks. Generate \
ONLY the tasks needed to fulfill what the user explicitly asked for. \
Do not add pipeline stages the user did not request.

A request for "a script" produces only a script task — no generation, \
no editing, no visual identity research. A request for "an image" \
produces only a generation task — no script, no timeline assembly. \
A request for "trim this clip" produces only an editing task.

The production stages below are a reference menu of what is available, \
not a checklist to run on every request. Select only the stages that \
directly serve the user's request.

## Task Types

Each task is one of three types:

- **creative**: Produces text output (scripts, shot lists, visual style \
  guides). Creative tasks should produce structured, numbered output \
  that downstream tasks can follow precisely.
- **execution**: Performs actions via tool calls (generating images/videos, \
  creating timelines, editing clips). Execution tasks call tools — \
  text-only responses are insufficient.
- **review**: Evaluates the output of prior tasks against the original \
  script/plan. The orchestrator creates correction tasks when quality \
  is insufficient.

## Available Tools by Category

- **generation**: generate_image, generate_video (text_to_video, \
  image_to_video, audio_to_video), retake_section, fill_timeline_gap
- **clip_editing**: trim_clip, split_clip, delete_clip, move_clip, \
  add_clip_to_timeline, set_clip_speed, flip_clip, reverse_clip, duplicate_clip
- **timeline_mgmt**: create_timeline, duplicate_timeline, rename_timeline
- **transitions**: add_dissolve
- **subtitles**: add_subtitle, edit_subtitle, set_subtitle_style
- **clip_properties**: set_clip_volume, set_clip_opacity, set_color_correction
- **asset_mgmt**: create_subclip_assets, organize_asset, create_bin, list_bins, \
  rename_bin, set_bin_color, batch_organize_assets
- **analysis**: get_video_metadata, query_project_brain, get_full_transcript
- **review**: review_edit_quality, review_edit_structure
- **memory**: save_to_project_memory, update_project_memory, \
  read_project_memory, list_project_memory, add_memory_note, \
  update_project_context

## Project Memory

If the context includes a Project Memory section, sub-agents should read \
relevant memory documents before starting creative work and save their \
creative outputs when done. User preferences in the memory log should be \
respected because they reflect explicit creative decisions.

## Duration Estimation

When the request involves video production, estimate the target duration \
based on the content described. Use the user's specified duration when \
provided; otherwise estimate from content:
- Social clip / reaction: 10-20s
- Short ad / promo: 20-40s
- Single scene beat: 30-60s
- Standard scene (setup + development + turn): 60-120s
- Full scene with dialogue and story beats: 2-5 minutes
- Multi-scene short film: 5-10 minutes

Signals for longer durations: dialogue between characters (2-3 min+), \
multiple locations (3-5 min+), story arc with conflict/resolution (2-4 min+), \
words like "full scene", "short film", "narrative" (2 min+).

Derive shot count from duration. The video generation API requires \
each shot to be 6, 8, or 10 seconds (or up to 20s for fast model at 1080p):
- Fast-paced (ads, montage): 1 shot per 6 seconds
- Standard pacing: 1 shot per 6-8 seconds
- Slow/cinematic (drama, arthouse): 1 shot per 8-10 seconds

Include `target_duration_seconds` in your output when the request \
involves video production. Set it to 0 for non-production requests \
(scripts only, editing only, single images).

## Available Production Stages

These stages exist as building blocks. Use only the ones the user's \
request requires. Each stage has a trigger condition — skip stages \
whose trigger does not apply.

1. **Script** (creative) — Trigger: user asks for a script, shot list, \
   story, or a full video production from scratch. \
   Produces scene descriptions, dialogue, and a numbered shot list \
   where each shot specifies visual description, shot type, camera \
   motion, and duration. Use format "Shot 1:", "Shot 2:", etc. \
   Valid per-shot durations are 6, 8, or 10 seconds only.

2. **Visual identity research** (creative) — Trigger: user asks for \
   visual research, look development, or a full cinematic production. \
   Research reference films, genre conventions, produce a Visual \
   Identity Bible. Assign skill: `visual-identity`. \
   Depends on: script (if one exists).

3. **Visual style** (creative) — Trigger: user asks for a style guide, \
   cinematography direction, or a full production with 3+ shots. \
   Translate the Visual Identity Bible (or user description) into \
   concrete AI generation guidance. Output ends with NB2_STYLE_BLOCK. \
   Assign skill: `cinematography`. \
   Depends on: script + identity (if they exist).

4. **Character pre-production** (execution) — Trigger: full production \
   with named characters who need visual consistency across shots. \
   Generate 360-degree turnaround reference sheets per character. \
   Output includes `CHARACTER_REFS: {{"name": "id"}}`. \
   Assign skill: `scene-preproduction`. Skip when no named characters.

5. **Location pre-production** (execution) — Trigger: full production \
   with specific locations that need visual consistency. \
   Generate establishing shots + angle variations per location. \
   Output includes `LOCATION_REFS: {{"label": "id"}}`. \
   Assign skill: `scene-preproduction`. Parallel with character pre-prod.

6. **Generation** (execution) — Trigger: user asks to generate images \
   or videos. The orchestrator expands multi-shot generation into \
   per-shot parallel tasks, injecting reference images and \
   NB2_STYLE_BLOCK automatically.

7. **Review** (review) — Trigger: after generation of 3+ shots. \
   Compare each generated shot against the script by number.

8. **Timeline assembly** (execution) — Trigger: user asks to assemble \
   clips on a timeline, or after multi-shot generation that needs \
   sequencing. Create timeline, add clips in order, trim dead frames, \
   adjust pacing.

9. **Final edit review** (review) — Trigger: after timeline assembly \
   for productions with 5+ shots. Evaluate pacing, continuity, quality.

## Cinematic Intent

When the user request references specific directors, cinematographers, \
film titles, or cinematic keywords, and the request involves content \
creation (not just editing existing clips):
- Script tasks should mention the cinematic tone
- Visual identity research should reference the cited filmmakers/films
- Visual style should use cinema camera bodies (ARRI, RED, Panavision), \
  cinema film stocks (Kodak VISION3), and cinema lenses (Cooke, \
  Panavision, Zeiss). Use still camera bodies only for photography, \
  editorial, or product work.

## General Rules

- Generate the minimum number of tasks that fulfill the request.
- Each task is a single, verifiable unit of work.
- Identify dependencies: list upstream task IDs in `depends_on`.
- Maximize parallelism: independent tasks should not depend on each other.
- Assign the best skill from the catalog. Use `null` for general tasks.
- Execution tasks list the tool_categories they need.
- Keep task descriptions imperative and specific.

## Available Skills
{skill_catalog}

## Output Format
Return valid JSON matching this schema:
{{
  "target_duration_seconds": <number>,
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

Task IDs: "task-1", "task-2", etc. \
context_requirements: "timeline_state", "asset_metadata", "prior_results".

## Examples

The examples below range from single-task requests to full productions. \
Match the number of tasks and which stages you include to what the user \
actually asked for. The specific names, aesthetics, and task counts are \
illustrative — vary them based on the actual user request.

### Example 1: "Write me a script for a 30-second fashion ad"

Note: User asked for a script only. No generation, no editing, no \
visual identity research. Single task.

{{
  "target_duration_seconds": 0,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Write a script for a 30-second fashion ad. Include a numbered shot list with 4-5 shots. Each shot: visual description, shot type, camera motion, duration. Format: 'Shot 1:', 'Shot 2:', etc. Target 30 seconds total. Valid durations are 6, 8, or 10 seconds per shot.",
      "skill_id": "advertising-screenwriter",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }}
  ]
}}

### Example 2: "Generate an image of a cozy cabin in the mountains at sunset"

Note: Single image generation. No script, no timeline, no visual research.

{{
  "target_duration_seconds": 0,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Generate an image of a cozy cabin in the mountains at sunset. Call generate_image with a detailed prompt describing warm golden light, snow-capped peaks, wooden cabin with smoke from the chimney. Use aspect_ratio '16:9'.",
      "skill_id": null,
      "task_type": "execution",
      "depends_on": [],
      "tool_categories": ["generation"],
      "context_requirements": []
    }}
  ]
}}

### Example 3: "Split the second clip at 3 seconds and add a dissolve between the two parts"

Note: Editing operations on existing timeline content. No generation, \
no script.

{{
  "target_duration_seconds": 0,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Split the second clip on the timeline at the 3-second mark, then add a dissolve transition between the resulting two parts.",
      "skill_id": "general-editor",
      "task_type": "execution",
      "depends_on": [],
      "tool_categories": ["clip_editing", "transitions"],
      "context_requirements": ["timeline_state"]
    }}
  ]
}}

### Example 4: "Generate 3 shots of a forest scene with morning fog"

Note: Small multi-shot generation. A brief style task helps consistency \
but no full script, visual identity research, or pre-production needed.

{{
  "target_duration_seconds": 24,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Define a visual style for a forest morning fog scene. Soft diffused light, cool blue-green palette, shallow depth of field. Output ends with NB2_STYLE_BLOCK.",
      "skill_id": "cinematography",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-2",
      "description": "Generate 3 forest shots with morning fog. Shot 1: Wide establishing shot of misty tree canopy (8s). Shot 2: Low angle through ferns with light rays (8s). Shot 3: Close-up of dewdrops on a leaf with soft bokeh (8s). For each: generate_image then generate_video image_to_video.",
      "skill_id": null,
      "task_type": "execution",
      "depends_on": ["task-1"],
      "tool_categories": ["generation"],
      "context_requirements": ["prior_results"]
    }}
  ]
}}

### Example 5: "Create a 15-second product launch ad for wireless headphones"

Note: Full short production — script, style, generation, and assembly. \
Short duration, no characters, no narrative — no pre-production needed.

{{
  "target_duration_seconds": 15,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Write a script for a 15-second product ad for wireless headphones. Include a NUMBERED shot list with 2-3 shots. Each shot: visual description, shot type, camera motion, duration. Format: 'Shot 1:', 'Shot 2:', etc. Target 15 seconds total. Valid durations are 6, 8, or 10 seconds per shot. Focus on sleek product close-ups and lifestyle context.",
      "skill_id": "advertising-screenwriter",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-2",
      "description": "Define the visual style for this product ad. Color palette: clean whites with a single accent color. Lighting: bright, soft studio light. Camera: still photography approach for product emphasis. Output ends with NB2_STYLE_BLOCK using appropriate camera body and lens for commercial product work.",
      "skill_id": "cinematography",
      "task_type": "creative",
      "depends_on": ["task-1"],
      "tool_categories": [],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-3",
      "description": "Generate all shots from the shot list applying the visual style. For each shot, call generate_image then generate_video with image_to_video mode.",
      "skill_id": null,
      "task_type": "execution",
      "depends_on": ["task-1", "task-2"],
      "tool_categories": ["generation"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-4",
      "description": "Create timeline, add clips in script order, trim dead frames, close gaps. Target 15 seconds total.",
      "skill_id": "general-editor",
      "task_type": "execution",
      "depends_on": ["task-3"],
      "tool_categories": ["timeline_mgmt", "clip_editing"],
      "context_requirements": ["prior_results", "timeline_state"]
    }}
  ]
}}

### Example 6: "Create a cinematic scene of a detective arriving at a rainy crime scene at night"

Note: Full cinematic production requested from scratch. Cinematic intent \
detected. Single location, one character — both pre-production stages \
needed. Visual identity research included because of cinematic intent. \
This is the ONLY type of request that warrants the full pipeline.

{{
  "target_duration_seconds": 90,
  "tasks": [
    {{
      "id": "task-1",
      "description": "Write a script for a ~90-second noir-style scene: a detective arrives at a rain-soaked crime scene at night. Include a numbered shot list with 12-15 shots. Each shot: visual description, shot type, camera motion, duration. Format 'Shot 1:', 'Shot 2:', etc. Target 90 seconds. Vary durations: 6s for quick detail shots, 8-10s for establishing and atmospheric shots. Valid durations are 6, 8, or 10 seconds per shot. Give the detective a specific physical description for reference sheets.",
      "skill_id": "film-tv-screenwriting",
      "task_type": "creative",
      "depends_on": [],
      "tool_categories": [],
      "context_requirements": []
    }},
    {{
      "id": "task-2",
      "description": "Research and create the Visual Identity Bible for this noir crime scene. Search for reference films in the neo-noir and thriller genres, find cinematographer interviews about shooting night rain scenes. Produce a Visual Identity Bible covering color world, light philosophy, camera identity, texture, and production design. Save to project memory.",
      "skill_id": "visual-identity",
      "task_type": "creative",
      "depends_on": ["task-1"],
      "tool_categories": [],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-3",
      "description": "Define the concrete visual style for this noir scene. Translate the Visual Identity Bible into shot-level guidance. Cinematic project: use cinema cameras, cinema film stocks, cinema lenses. Frame prompts as cinematic screen grabs. Include director/DP references matching the noir tone. Output ends with NB2_STYLE_BLOCK.",
      "skill_id": "cinematography",
      "task_type": "creative",
      "depends_on": ["task-1", "task-2"],
      "tool_categories": [],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-4",
      "description": "Generate character reference sheet for the detective. Apply costume direction from the Visual Identity Bible and camera/film stock from the NB2_STYLE_BLOCK. Output includes CHARACTER_REFS with character name to asset ID mapping.",
      "skill_id": "scene-preproduction",
      "task_type": "execution",
      "depends_on": ["task-1", "task-3"],
      "tool_categories": ["generation", "memory"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-5",
      "description": "Generate location keyframes for the crime scene. Wide establishing exterior plus 2-3 angle variations. Apply production design direction and NB2_STYLE_BLOCK values. Output includes LOCATION_REFS.",
      "skill_id": "scene-preproduction",
      "task_type": "execution",
      "depends_on": ["task-1", "task-3"],
      "tool_categories": ["generation", "memory"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-6",
      "description": "Generate all shots from the shot list applying the NB2_STYLE_BLOCK. Use character and location reference images as image_urls for consistency. For each shot: generate_image then generate_video image_to_video.",
      "skill_id": null,
      "task_type": "execution",
      "depends_on": ["task-1", "task-3", "task-4", "task-5"],
      "tool_categories": ["generation"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-7",
      "description": "Review each generated shot against the script. For each shot by number: PASS or FAIL with explanation. Flag shots needing regeneration.",
      "skill_id": "directing",
      "task_type": "review",
      "depends_on": ["task-1", "task-6"],
      "tool_categories": ["core"],
      "context_requirements": ["prior_results"]
    }},
    {{
      "id": "task-8",
      "description": "Create timeline, add clips in script order, trim dead frames, close gaps. Adjust pacing for noir atmosphere — hold longer on establishing shots, cut tighter on detail inserts. Target ~90 seconds.",
      "skill_id": "tv-film-editing",
      "task_type": "execution",
      "depends_on": ["task-6", "task-7"],
      "tool_categories": ["timeline_mgmt", "clip_editing", "transitions"],
      "context_requirements": ["prior_results", "timeline_state"]
    }}
  ]
}}

### Example 8 — Asset organization
User: "Create bins for characters, locations, and storyboard, then organize \
my assets into them based on their content"

{{"tasks": [
    {{
      "id": "task-1",
      "description": "List all project assets with get_project_assets, then create three bins using create_bin: 'Characters', 'Locations', 'Storyboard'. For each asset, examine its name, tags, and prompt to determine the best bin, then call organize_asset with the appropriate bin name. Archive any duplicate or low-quality assets.",
      "skill_id": null,
      "task_type": "execution",
      "depends_on": [],
      "tool_categories": ["asset_mgmt"],
      "context_requirements": []
    }}
  ]
}}

The examples above range from 1 task to 8 tasks. The number of tasks \
and which production stages are included depends entirely on what the \
user asked for. When in doubt, produce fewer tasks — users can always \
ask for more.
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


def _try_recover_truncated_json(text: str) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Attempt to recover parseable tasks from truncated JSON.

    Scans backward from the end to find the last complete task object,
    then reconstructs valid JSON containing all complete tasks.
    Returns the parsed data or None if recovery fails.
    """
    brace_depth = 0
    in_string = False
    escape_next = False
    last_complete_task_end = -1

    for i, ch in enumerate(text):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            brace_depth += 1
        elif ch == "}":
            brace_depth -= 1
            if brace_depth == 1:
                last_complete_task_end = i

    if last_complete_task_end == -1:
        return None

    repaired = text[: last_complete_task_end + 1] + "\n  ]\n}"
    try:
        data = json.loads(repaired)
        if isinstance(data, dict) and "tasks" in data:
            d = cast(dict[str, Any], data)
            tasks: list[Any] = d["tasks"]
            if len(tasks) >= 1:
                logger.warning(
                    "Recovered %d task(s) from truncated planner JSON",
                    len(tasks),
                )
                return d
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def _parse_planner_response(text: str) -> tuple[list[dict[str, Any]], float | None]:
    """Extract tasks and target_duration_seconds from the planner's JSON response.

    Returns (tasks, target_duration_seconds).  If the JSON is truncated
    (e.g. output-token limit hit), attempts to recover all complete task
    objects before falling back.
    """
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        data: Any = json.loads(text)
    except json.JSONDecodeError:
        recovered = _try_recover_truncated_json(text)
        if recovered is None:
            raise
        data = cast(Any, recovered)

    target_duration: float | None = None

    if isinstance(data, dict):
        d = cast(dict[str, Any], data)
        raw_duration: Any = d.get("target_duration_seconds")
        if raw_duration is not None:
            try:
                target_duration = float(raw_duration)
            except (TypeError, ValueError):
                pass
        if "tasks" in d:
            return cast(list[dict[str, Any]], d["tasks"]), target_duration

    if isinstance(data, list):
        return cast(list[dict[str, Any]], data), None
    raise ValueError(f"Unexpected planner response shape: {type(cast(object, data))}")


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
        memory_context: str | None = None,
        conversation_context: str | None = None,
    ) -> TaskDAG:
        """Break a user request into a validated TaskDAG.

        Makes one Gemini call.  Falls back to a single-task DAG if
        the LLM response cannot be parsed.
        """
        skill_catalog = _build_skill_catalog(available_skills)
        system_prompt = _PLANNER_SYSTEM_PROMPT.format(skill_catalog=skill_catalog)

        user_parts: list[str] = []
        if conversation_context:
            user_parts.append(f"## Recent Conversation\n{conversation_context}")
        if timeline_context:
            user_parts.append(f"## Current Timeline\n{timeline_context}")
        if assets_context:
            user_parts.append(f"## Available Assets\n{assets_context}")
        if memory_context:
            user_parts.append(memory_context)
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
                "maxOutputTokens": 16384,
                "responseMimeType": "application/json",
            },
        }

        t0 = time.monotonic()
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
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.info("[task-planner] Gemini responded HTTP %d in %dms", resp.status_code, elapsed_ms)

            if resp.status_code != 200:
                logger.error(
                    "Planner Gemini call failed with HTTP %d: %s",
                    resp.status_code,
                    resp.text[:300],
                )
                return self._fallback_dag(prompt)

            body = cast(dict[str, Any], resp.json())
            text: str = body["candidates"][0]["content"]["parts"][0]["text"]
            raw_tasks, target_duration = _parse_planner_response(text)

        except Exception:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.error("Task planner failed after %dms", elapsed_ms, exc_info=True)
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

        task_summaries = [
            f"  {t.id} ({t.task_type.value}): {t.description[:60]}"
            for t in tasks
        ]
        logger.info(
            "[task-planner] produced %d task(s) for prompt: %.80s | target_duration=%s\n%s",
            len(tasks),
            prompt,
            target_duration,
            "\n".join(task_summaries),
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
