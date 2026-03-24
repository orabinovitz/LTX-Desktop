"""Tests for extended skill metadata parsing."""

from __future__ import annotations

from pathlib import Path

from agent.skills.skill_registry import SkillRegistry


def _write_skill(skill_dir: Path, body: str) -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body, encoding="utf-8")


def test_skill_registry_parses_extended_metadata(tmp_path: Path) -> None:
    _write_skill(
        tmp_path / "demo-skill",
        """---
id: demo-skill
name: Demo Skill
description: >
  Demonstrates metadata parsing.
tool_categories:
  - generation
trigger_keywords:
  - demo
preferred_model_tier: pro
reasoning_class: creative_synthesis
editing_critical: true
high_stakes_consistency: true
search_grounded: true
do_not_trigger_when:
  - User asks for something else
enable_search: true
---

## System Prompt

Do the demo task.
""",
    )

    registry = SkillRegistry(skills_dir=tmp_path)
    content = registry.get_skill_content("demo-skill")

    assert content is not None
    assert content.descriptor.preferred_model_tier == "pro"
    assert content.descriptor.reasoning_class == "creative_synthesis"
    assert content.descriptor.editing_critical is True
    assert content.descriptor.high_stakes_consistency is True
    assert content.descriptor.search_grounded is True
    assert content.descriptor.do_not_trigger_when == ["User asks for something else"]
    assert content.enable_search is True


def test_skill_registry_defaults_extended_metadata(tmp_path: Path) -> None:
    _write_skill(
        tmp_path / "minimal-skill",
        """---
id: minimal-skill
name: Minimal Skill
description: >
  Minimal metadata skill.
tool_categories:
  - core
trigger_keywords:
  - minimal
---

## System Prompt

Do the minimal task.
""",
    )

    registry = SkillRegistry(skills_dir=tmp_path)
    content = registry.get_skill_content("minimal-skill")

    assert content is not None
    assert content.descriptor.preferred_model_tier is None
    assert content.descriptor.reasoning_class is None
    assert content.descriptor.editing_critical is False
    assert content.descriptor.high_stakes_consistency is False
    assert content.descriptor.search_grounded is False
    assert content.descriptor.do_not_trigger_when == []
