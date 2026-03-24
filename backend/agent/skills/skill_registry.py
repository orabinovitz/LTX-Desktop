"""Skill discovery, parsing, and registry.

Reads SKILL.md files from the skills directory on startup, parses
YAML frontmatter + markdown body, and serves lightweight descriptors
for routing and full content for sub-agent execution.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, cast

import yaml

from agent.types import SkillContent, SkillDescriptor

logger = logging.getLogger(__name__)

_SKILLS_DIR = Path(__file__).parent
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_SYSTEM_PROMPT_RE = re.compile(
    r"##\s*System\s*Prompt\s*\n(.*)",
    re.DOTALL | re.IGNORECASE,
)


def _load_references(skill_dir: Path) -> dict[str, str]:
    """Load all .md files from a skill's subdirectories.

    Scans every immediate subdirectory (``references/``, ``examples/``,
    ``templates/``, etc.) and loads ``.md`` files.  Keys use the relative
    path from the skill directory so skill prompts can reference them
    naturally, e.g. ``references/SCREENWRITING_PRINCIPLES.md``.
    """
    references: dict[str, str] = {}
    for sub in sorted(skill_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith("."):
            continue
        for ref_file in sorted(sub.iterdir()):
            if ref_file.suffix == ".md" and ref_file.is_file():
                key = f"{sub.name}/{ref_file.name}"
                try:
                    references[key] = ref_file.read_text(encoding="utf-8")
                except OSError:
                    logger.warning("Could not read reference file: %s", ref_file)
    return references


def _parse_skill_file(path: Path) -> SkillContent | None:
    """Parse a SKILL.md file into a SkillContent object.

    Expected format:
        ---
        id: skill-id
        name: Human Name
        description: >
          What this skill does...
        tool_categories: [cat1, cat2]
        trigger_keywords: [kw1, kw2]
        ---

        ## System Prompt

        Full system prompt content here...
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("Could not read skill file: %s", path)
        return None

    fm_match = _FRONTMATTER_RE.match(text)
    if not fm_match:
        logger.warning("No YAML frontmatter in %s", path)
        return None

    try:
        meta = yaml.safe_load(fm_match.group(1))
    except yaml.YAMLError:
        logger.warning("Invalid YAML frontmatter in %s", path, exc_info=True)
        return None

    if not isinstance(meta, dict) or "id" not in meta:
        logger.warning("Skill file missing 'id' field: %s", path)
        return None

    m = cast(dict[str, Any], meta)

    body = text[fm_match.end():]
    prompt_match = _SYSTEM_PROMPT_RE.search(body)
    system_prompt = prompt_match.group(1).strip() if prompt_match else body.strip()

    descriptor = SkillDescriptor(
        id=m["id"],
        name=m.get("name", m["id"]),
        description=m.get("description", ""),
        tool_categories=m.get("tool_categories", []),
        trigger_keywords=m.get("trigger_keywords", []),
        preferred_model_tier=m.get("preferred_model_tier"),
        reasoning_class=m.get("reasoning_class"),
        editing_critical=bool(m.get("editing_critical", False)),
        high_stakes_consistency=bool(m.get("high_stakes_consistency", False)),
        search_grounded=bool(m.get("search_grounded", m.get("enable_search", False))),
        do_not_trigger_when=m.get("do_not_trigger_when", []),
    )

    tool_overrides: list[str] | None = m.get("tool_overrides")

    references = _load_references(path.parent)

    enable_search: bool = bool(m.get("enable_search", False))

    return SkillContent(
        descriptor=descriptor,
        system_prompt=system_prompt,
        tool_overrides=tool_overrides,
        references=references,
        enable_search=enable_search,
    )


class SkillRegistry:
    """In-memory registry of all available skills.

    Loaded once at startup by scanning ``backend/agent/skills/*/SKILL.md``.
    Provides two access levels:

    1. ``get_all_descriptors()`` — lightweight summaries for the planner
       (~100 tokens each).
    2. ``get_skill_content(skill_id)`` — full skill instructions loaded
       only when a sub-agent is about to execute.
    """

    def __init__(self, skills_dir: Path | None = None) -> None:
        self._skills_dir = skills_dir or _SKILLS_DIR
        self._skills: dict[str, SkillContent] = {}
        self._load_all()

    def _load_all(self) -> None:
        """Scan the skills directory and parse every SKILL.md found."""
        if not self._skills_dir.is_dir():
            logger.warning("Skills directory does not exist: %s", self._skills_dir)
            return

        loaded = 0
        for skill_dir in sorted(self._skills_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            content = _parse_skill_file(skill_file)
            if content is not None:
                self._skills[content.descriptor.id] = content
                loaded += 1

        logger.info(
            "SkillRegistry loaded %d skill(s) from %s",
            loaded,
            self._skills_dir,
        )

    def get_all_descriptors(self) -> list[SkillDescriptor]:
        """Return lightweight descriptors for all registered skills."""
        return [s.descriptor for s in self._skills.values()]

    def get_skill_content(self, skill_id: str) -> SkillContent | None:
        """Load the full skill content by ID. Returns None if not found."""
        return self._skills.get(skill_id)

    def get_skill_ids(self) -> list[str]:
        """Return all registered skill IDs."""
        return list(self._skills.keys())

    def find_by_keyword(self, query: str) -> list[SkillDescriptor]:
        """Return skills whose trigger keywords appear in the query."""
        query_lower = query.lower()
        matches: list[SkillDescriptor] = []
        for skill in self._skills.values():
            for kw in skill.descriptor.trigger_keywords:
                if kw.lower() in query_lower:
                    matches.append(skill.descriptor)
                    break
        return matches

    def reload(self) -> None:
        """Re-scan the skills directory (useful for development)."""
        self._skills.clear()
        self._load_all()


_global_registry: SkillRegistry | None = None


def get_skill_registry() -> SkillRegistry:
    """Return the singleton SkillRegistry, creating it on first call."""
    global _global_registry  # noqa: PLW0603
    if _global_registry is None:
        _global_registry = SkillRegistry()
    return _global_registry
