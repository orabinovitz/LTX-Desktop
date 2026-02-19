"""Utilities for settings patch/load workflows."""

from __future__ import annotations

from typing import Any


def deep_merge_dicts(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = base.copy()
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def strip_none_values(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in payload.items():
        if value is None:
            continue
        if isinstance(value, dict):
            cleaned[key] = strip_none_values(value)
        else:
            cleaned[key] = value
    return cleaned


def collect_changed_paths(before: Any, after: Any, prefix: str = "") -> set[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        paths: set[str] = set()
        for key in set(before) | set(after):
            next_prefix = f"{prefix}.{key}" if prefix else key
            if key not in before or key not in after:
                paths.add(next_prefix)
                continue
            paths |= collect_changed_paths(before[key], after[key], next_prefix)
        return paths

    if before != after and prefix:
        return {prefix}
    return set()


def migrate_legacy_settings(raw: dict[str, Any]) -> dict[str, Any]:
    migrated = raw.copy()
    if (
        "prompt_enhancer_enabled" in migrated
        and "prompt_enhancer_enabled_t2v" not in migrated
    ):
        legacy_value = bool(migrated["prompt_enhancer_enabled"])
        migrated.setdefault("prompt_enhancer_enabled_t2v", legacy_value)
        migrated.setdefault("prompt_enhancer_enabled_i2v", legacy_value)

    migrated.pop("prompt_enhancer_enabled", None)
    return migrated

