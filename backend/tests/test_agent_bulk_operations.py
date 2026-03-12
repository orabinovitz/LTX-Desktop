"""Tests for bulk operation tools and intent routing."""

from __future__ import annotations

import pytest

from agent.tool_knowledge_base import (
    CATEGORIES,
    classify_intent,
    get_tools_for_categories,
    get_tools_for_categories_and_view,
)
from agent.tool_registry import ALL_TOOLS, TOOLS_BY_NAME


class TestBatchDeleteAssetsTool:
    """batch_delete_assets tool definition is correct."""

    def test_tool_exists_in_registry(self) -> None:
        assert "batch_delete_assets" in TOOLS_BY_NAME

    def test_tool_category_is_asset_mgmt(self) -> None:
        tool = TOOLS_BY_NAME["batch_delete_assets"]
        assert tool.category == "asset_mgmt"

    def test_tool_is_frontend_execution(self) -> None:
        tool = TOOLS_BY_NAME["batch_delete_assets"]
        assert tool.execution_target.value == "frontend"

    def test_tool_accepts_array_parameter(self) -> None:
        tool = TOOLS_BY_NAME["batch_delete_assets"]
        assert len(tool.parameters) == 1
        param = tool.parameters[0]
        assert param.name == "asset_ids"
        assert param.type == "array"
        assert param.items is not None
        assert param.items.get("type") == "string"

    def test_tool_in_asset_mgmt_category(self) -> None:
        cat = CATEGORIES["asset_mgmt"]
        assert "batch_delete_assets" in cat.tool_names

    def test_tool_in_all_tools_list(self) -> None:
        names = [t.name for t in ALL_TOOLS]
        assert "batch_delete_assets" in names


class TestBulkOperationIntentClassification:
    """Intent classifier routes bulk operations to the right categories."""

    def test_delete_all_routes_to_asset_mgmt(self) -> None:
        cats = classify_intent("delete all the images that aren't animals")
        assert "asset_mgmt" in cats

    def test_remove_every_routes_to_asset_mgmt(self) -> None:
        cats = classify_intent("remove every non-animal image from the project")
        assert "asset_mgmt" in cats

    def test_batch_delete_gets_tool(self) -> None:
        tools = get_tools_for_categories(["asset_mgmt"])
        names = {t.name for t in tools}
        assert "batch_delete_assets" in names
        assert "delete_asset" in names

    def test_batch_delete_available_in_editor(self) -> None:
        tools = get_tools_for_categories_and_view(
            ["core", "asset_mgmt"], "editor"
        )
        names = {t.name for t in tools}
        assert "batch_delete_assets" in names

    def test_batch_delete_available_in_genspace(self) -> None:
        tools = get_tools_for_categories_and_view(
            ["core", "asset_mgmt"], "genspace"
        )
        names = {t.name for t in tools}
        assert "batch_delete_assets" in names

    def test_organize_all_routes_to_asset_mgmt(self) -> None:
        cats = classify_intent("organize all assets into bins")
        assert "asset_mgmt" in cats


class TestBulkOperationSystemPrompt:
    """System prompt includes bulk operation verification instructions."""

    def test_system_prompt_mentions_bulk_operations(self) -> None:
        from agent.gemini_agent import SYSTEM_PROMPT

        assert "Bulk Operations" in SYSTEM_PROMPT

    def test_system_prompt_mentions_batch_delete(self) -> None:
        from agent.gemini_agent import SYSTEM_PROMPT

        assert "batch_delete_assets" in SYSTEM_PROMPT

    def test_system_prompt_mentions_verification(self) -> None:
        from agent.gemini_agent import SYSTEM_PROMPT

        assert "get_project_assets" in SYSTEM_PROMPT
        assert "verification" in SYSTEM_PROMPT.lower() or "verify" in SYSTEM_PROMPT.lower()

    def test_system_prompt_mentions_remaining_count(self) -> None:
        from agent.gemini_agent import SYSTEM_PROMPT

        assert "remaining_asset_count" in SYSTEM_PROMPT


class TestContinueWithUpdatedContext:
    """continue_with_results accepts updated_context parameter."""

    def test_continue_accepts_updated_context_param(self) -> None:
        import inspect
        from agent.gemini_agent import continue_with_results

        sig = inspect.signature(continue_with_results)
        assert "updated_context" in sig.parameters

    def test_continue_request_has_updated_context_field(self) -> None:
        from agent.types import AgentContinueRequest

        req = AgentContinueRequest(
            tool_results=[],
            session_id="test",
            updated_context="## Updated state\n5 assets remaining",
        )
        assert req.updated_context == "## Updated state\n5 assets remaining"

    def test_continue_request_updated_context_defaults_to_none(self) -> None:
        from agent.types import AgentContinueRequest

        req = AgentContinueRequest(tool_results=[], session_id="test")
        assert req.updated_context is None
