"""Route tasks to the best-matching skill.

Two-stage matching:
1. Validate the planner's skill assignment (is the ID real?).
2. Fall back to keyword matching if the planner didn't assign one.

Returns ``None`` when no skill matches — the orchestrator should
use the general brain prompt in that case.
"""

from __future__ import annotations

import logging

from agent.types import SkillDescriptor, TaskNode

logger = logging.getLogger(__name__)


class SkillRouter:
    """Validates and resolves skill assignments for tasks."""

    def __init__(self, descriptors: list[SkillDescriptor]) -> None:
        self._by_id: dict[str, SkillDescriptor] = {d.id: d for d in descriptors}
        self._all = descriptors

    def route(self, task: TaskNode) -> str | None:
        """Return the best skill ID for *task*, or ``None`` for brain fallback.

        1. If the planner already assigned a valid skill_id, use it.
        2. Otherwise, try keyword matching against the task description.
        3. If still no match, return None.
        """
        if task.skill_id and task.skill_id in self._by_id:
            return task.skill_id

        if task.skill_id:
            logger.warning(
                "Task %s assigned unknown skill '%s' — attempting keyword fallback",
                task.id,
                task.skill_id,
            )

        return self._keyword_match(task.description)

    def _keyword_match(self, text: str) -> str | None:
        """Find the best skill by keyword overlap with the text."""
        text_lower = text.lower()
        best_id: str | None = None
        best_score = 0

        for desc in self._all:
            score = sum(1 for kw in desc.trigger_keywords if kw.lower() in text_lower)
            if score > best_score:
                best_score = score
                best_id = desc.id

        if best_id and best_score > 0:
            logger.info(
                "Keyword-matched skill '%s' (score=%d) for text: %.60s",
                best_id,
                best_score,
                text,
            )
        return best_id
