"""Tests for agent.json_repair module."""

from __future__ import annotations

import pytest

from agent.json_repair import repair_simple_json, repair_truncated_json


class TestRepairTruncatedJson:
    """Tests for repair_truncated_json."""

    def test_valid_json_passes_through_unchanged(self) -> None:
        text = '{"key": "value", "arr": [1, 2, 3]}'
        result = repair_truncated_json(text)
        assert result == {"key": "value", "arr": [1, 2, 3]}

    def test_truncated_after_complete_object_recovers_first(self) -> None:
        text = '{"a": 1}, {"b": 2'
        result = repair_truncated_json(text)
        assert result == {"a": 1}

    def test_nested_truncation_recovers_complete_part(self) -> None:
        text = '{"topics": [{"id": "t1"}, {"id": "t2"'
        result = repair_truncated_json(text)
        assert result == {"topics": [{"id": "t1"}]}

    def test_completely_invalid_no_braces_returns_empty_dict(self) -> None:
        text = "not json at all"
        result = repair_truncated_json(text)
        assert result == {}

    def test_empty_string_returns_empty_dict(self) -> None:
        result = repair_truncated_json("")
        assert result == {}

    def test_truncated_single_object_no_complete_subobject_returns_empty(self) -> None:
        """When there is no '}' to truncate at, repair_truncated_json cannot recover."""
        text = '{"key": "value", "arr": [1, 2, 3'
        result = repair_truncated_json(text)
        assert result == {}


class TestRepairSimpleJson:
    """Tests for repair_simple_json."""

    def test_missing_closing_brace_repairs(self) -> None:
        text = '{"key": "value"'
        result = repair_simple_json(text)
        assert result == {"key": "value"}

    def test_missing_closing_bracket_and_brace_repairs(self) -> None:
        text = '{"key": "value", "arr": [1, 2, 3'
        result = repair_simple_json(text)
        assert result == {"key": "value", "arr": [1, 2, 3]}

    def test_trailing_comma_before_truncation_repairs(self) -> None:
        text = '{"arr": [1, 2,'
        result = repair_simple_json(text)
        assert result == {"arr": [1, 2]}

    def test_already_valid_json_returns_none(self) -> None:
        text = '{"key": "value"}'
        result = repair_simple_json(text)
        assert result is None

    def test_does_not_start_with_brace_returns_none(self) -> None:
        text = '[1, 2, 3'
        result = repair_simple_json(text)
        assert result is None

    def test_deeply_nested_missing_closers_repairs(self) -> None:
        text = '{"a": {"b": {"c": [1, 2'
        result = repair_simple_json(text)
        assert result == {"a": {"b": {"c": [1, 2]}}}
