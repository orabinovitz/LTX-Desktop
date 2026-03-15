"""Tests for the project memory storage engine."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from agent import project_memory
from agent.types import MemoryDocumentType


@pytest.fixture()
def memory_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Override the default memory root to a temp directory."""
    monkeypatch.setattr(project_memory, "_DEFAULT_MEMORY_ROOT", tmp_path)
    return tmp_path


class TestSanitizeId:
    def test_valid_id(self) -> None:
        assert project_memory._sanitize_id("abc-123_XYZ") == "abc-123_XYZ"

    def test_rejects_path_traversal(self) -> None:
        with pytest.raises(ValueError):
            project_memory._sanitize_id("../../../etc/passwd")

    def test_rejects_slashes(self) -> None:
        with pytest.raises(ValueError):
            project_memory._sanitize_id("foo/bar")

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError):
            project_memory._sanitize_id("")


class TestWriteAndReadDocument:
    def test_create_and_read(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            project_id="proj-1",
            title="Test Script",
            doc_type=MemoryDocumentType.SCRIPT,
            content="INT. DINER - NIGHT\n\nA couple enters.",
            description="A diner scene",
            tags=["scene-1", "diner"],
            created_by="agent:screenwriting",
        )

        assert meta.title == "Test Script"
        assert meta.type == MemoryDocumentType.SCRIPT
        assert meta.version == 1
        assert meta.created_by == "agent:screenwriting"
        assert "scene-1" in meta.tags

        doc = project_memory.read_document("proj-1", meta.id)
        assert doc is not None
        assert doc.content == "INT. DINER - NIGHT\n\nA couple enters."
        assert doc.meta.id == meta.id

    def test_document_persists_to_disk(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            project_id="proj-2",
            title="Research",
            doc_type=MemoryDocumentType.RESEARCH,
            content="Some research data.",
        )

        doc_path = memory_root / "proj-2" / "documents" / "research.md"
        assert doc_path.exists()
        text = doc_path.read_text()
        assert "Some research data." in text
        assert "research" in text

        manifest_path = memory_root / "proj-2" / "manifest.json"
        assert manifest_path.exists()
        manifest_data = json.loads(manifest_path.read_text())
        assert len(manifest_data["documents"]) == 1

    def test_read_nonexistent_returns_none(self, memory_root: Path) -> None:
        assert project_memory.read_document("proj-x", "fake-id") is None


class TestUpdateDocument:
    def test_update_content(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            project_id="proj-3",
            title="Draft",
            doc_type=MemoryDocumentType.NOTES,
            content="First draft.",
        )

        updated = project_memory.update_document(
            project_id="proj-3",
            doc_id=meta.id,
            content="Second draft with changes.",
        )
        assert updated is not None
        assert updated.version == 2
        assert updated.title == "Draft"

        doc = project_memory.read_document("proj-3", meta.id)
        assert doc is not None
        assert doc.content == "Second draft with changes."

    def test_update_metadata_only(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            project_id="proj-4",
            title="Old Title",
            doc_type=MemoryDocumentType.SCRIPT,
            content="The body.",
        )

        updated = project_memory.update_document(
            project_id="proj-4",
            doc_id=meta.id,
            title="New Title",
            tags=["updated"],
        )
        assert updated is not None
        assert updated.title == "New Title"
        assert updated.tags == ["updated"]
        assert updated.version == 2

        doc = project_memory.read_document("proj-4", meta.id)
        assert doc is not None
        assert doc.content == "The body."

    def test_update_nonexistent_returns_none(self, memory_root: Path) -> None:
        assert project_memory.update_document("proj-5", "fake-id", content="x") is None


class TestDeleteDocument:
    def test_delete(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            project_id="proj-6",
            title="Throwaway",
            doc_type=MemoryDocumentType.NOTES,
            content="Delete me.",
        )

        assert project_memory.delete_document("proj-6", meta.id)
        assert project_memory.read_document("proj-6", meta.id) is None
        docs = project_memory.list_documents("proj-6")
        assert len(docs) == 0

    def test_delete_nonexistent(self, memory_root: Path) -> None:
        assert not project_memory.delete_document("proj-7", "fake-id")


class TestListDocuments:
    def test_list_all(self, memory_root: Path) -> None:
        project_memory.write_document("proj-8", "Script", MemoryDocumentType.SCRIPT, "s")
        project_memory.write_document("proj-8", "Notes", MemoryDocumentType.NOTES, "n")
        project_memory.write_document("proj-8", "Research", MemoryDocumentType.RESEARCH, "r")

        docs = project_memory.list_documents("proj-8")
        assert len(docs) == 3

    def test_list_by_type(self, memory_root: Path) -> None:
        project_memory.write_document("proj-9", "Script", MemoryDocumentType.SCRIPT, "s")
        project_memory.write_document("proj-9", "Notes", MemoryDocumentType.NOTES, "n")

        scripts = project_memory.list_documents("proj-9", doc_type=MemoryDocumentType.SCRIPT)
        assert len(scripts) == 1
        assert scripts[0].type == MemoryDocumentType.SCRIPT

    def test_list_empty_project(self, memory_root: Path) -> None:
        assert project_memory.list_documents("nonexistent") == []


class TestManifest:
    def test_get_manifest(self, memory_root: Path) -> None:
        project_memory.write_document("proj-10", "Doc", MemoryDocumentType.NOTES, "x")
        manifest = project_memory.get_manifest("proj-10")
        assert manifest is not None
        assert len(manifest.documents) == 1

    def test_get_manifest_no_memory(self, memory_root: Path) -> None:
        assert project_memory.get_manifest("nonexistent") is None


class TestContextDocument:
    def test_read_empty_context(self, memory_root: Path) -> None:
        assert project_memory.read_context("proj-11") == ""

    def test_write_and_read_context(self, memory_root: Path) -> None:
        project_memory.update_context("proj-12", "# Project: Heist Film\n\nA couple robs a bank.")
        content = project_memory.read_context("proj-12")
        assert "Heist Film" in content
        assert "robs a bank" in content

    def test_update_context_overwrites(self, memory_root: Path) -> None:
        project_memory.update_context("proj-13", "Version 1")
        project_memory.update_context("proj-13", "Version 2")
        assert project_memory.read_context("proj-13") == "Version 2"


class TestMemoryLog:
    def test_read_empty_log(self, memory_root: Path) -> None:
        assert project_memory.read_memory_log("proj-14") == ""

    def test_append_and_read(self, memory_root: Path) -> None:
        project_memory.append_memory_entry("proj-15", "User wants rural diner")
        project_memory.append_memory_entry("proj-15", "Rejected neon lighting")

        log = project_memory.read_memory_log("proj-15")
        assert "User wants rural diner" in log
        assert "Rejected neon lighting" in log
        assert log.count("- [") == 2

    def test_log_has_header(self, memory_root: Path) -> None:
        project_memory.append_memory_entry("proj-16", "First entry")
        log = project_memory.read_memory_log("proj-16")
        assert "# Project Memory Log" in log


class TestAgentFormatting:
    def test_empty_project(self, memory_root: Path) -> None:
        result = project_memory.format_memory_for_agent("nonexistent")
        assert result == ""

    def test_with_context_and_docs(self, memory_root: Path) -> None:
        project_memory.update_context("proj-17", "A heist film about a couple.")
        project_memory.write_document(
            "proj-17", "Script", MemoryDocumentType.SCRIPT,
            "INT. DINER - NIGHT",
            description="The opening scene",
            tags=["scene-1"],
        )
        project_memory.append_memory_entry("proj-17", "User likes noir style")

        result = project_memory.format_memory_for_agent("proj-17")
        assert "## Project Memory" in result
        assert "heist film" in result
        assert "Script" in result
        assert "noir style" in result

    def test_caps_long_context(self, memory_root: Path) -> None:
        long_content = "x" * 2000
        project_memory.update_context("proj-18", long_content)
        result = project_memory.format_memory_for_agent("proj-18")
        assert "..." in result
        assert len(result) < 2000


class TestDocumentSizeLimits:
    def test_rejects_oversized_document(self, memory_root: Path) -> None:
        huge_content = "x" * (project_memory._MAX_DOCUMENT_SIZE_BYTES + 1)
        with pytest.raises(ValueError, match="1 MB"):
            project_memory.write_document(
                "proj-19", "Big", MemoryDocumentType.NOTES, huge_content,
            )

    def test_rejects_oversized_update(self, memory_root: Path) -> None:
        meta = project_memory.write_document(
            "proj-20", "Small", MemoryDocumentType.NOTES, "ok",
        )
        huge_content = "x" * (project_memory._MAX_DOCUMENT_SIZE_BYTES + 1)
        with pytest.raises(ValueError, match="1 MB"):
            project_memory.update_document("proj-20", meta.id, content=huge_content)


class TestDocumentLimit:
    def test_max_documents_enforced(self, memory_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(project_memory, "_MAX_DOCUMENTS_PER_PROJECT", 3)
        for i in range(3):
            project_memory.write_document(
                "proj-21", f"Doc {i}", MemoryDocumentType.NOTES, "x",
            )
        with pytest.raises(ValueError, match="document limit"):
            project_memory.write_document(
                "proj-21", "Overflow", MemoryDocumentType.NOTES, "x",
            )


# ===================================================================
# Smart Contextual Memory tests
# ===================================================================


class TestHasMemory:
    def test_empty_project_returns_false(self, memory_root: Path) -> None:
        assert not project_memory.has_memory("nonexistent-proj")

    def test_project_with_context_returns_true(self, memory_root: Path) -> None:
        project_memory.update_context("proj-has-1", "Some context")
        assert project_memory.has_memory("proj-has-1")

    def test_project_with_document_returns_true(self, memory_root: Path) -> None:
        project_memory.write_document("proj-has-2", "Script", MemoryDocumentType.SCRIPT, "content")
        assert project_memory.has_memory("proj-has-2")

    def test_project_with_log_returns_true(self, memory_root: Path) -> None:
        project_memory.append_memory_entry("proj-has-3", "user likes noir")
        assert project_memory.has_memory("proj-has-3")

    def test_invalid_project_id_returns_false(self) -> None:
        assert not project_memory.has_memory("../../../etc")


class TestFormatCache:
    def test_second_call_uses_cache(self, memory_root: Path) -> None:
        project_memory._format_cache.clear()
        project_memory.update_context("proj-cache-1", "Cached context")

        result1 = project_memory.format_memory_for_agent("proj-cache-1")
        assert "Cached context" in result1

        # Modify the file on disk behind the cache's back
        mdir = memory_root / "proj-cache-1"
        (mdir / "context.md").write_text("Changed on disk")

        result2 = project_memory.format_memory_for_agent("proj-cache-1")
        assert result2 == result1  # still returns cached version

    def test_invalidate_cache_forces_reread(self, memory_root: Path) -> None:
        project_memory._format_cache.clear()
        project_memory.update_context("proj-cache-2", "Version 1")

        result1 = project_memory.format_memory_for_agent("proj-cache-2")
        assert "Version 1" in result1

        # Manually write new content and invalidate
        mdir = memory_root / "proj-cache-2"
        (mdir / "context.md").write_text("Version 2")
        project_memory.invalidate_cache("proj-cache-2")

        result2 = project_memory.format_memory_for_agent("proj-cache-2")
        assert "Version 2" in result2
        assert result2 != result1

    def test_cache_keys_are_per_project(self, memory_root: Path) -> None:
        project_memory._format_cache.clear()
        project_memory.update_context("proj-cache-a", "Project A")
        project_memory.update_context("proj-cache-b", "Project B")

        result_a = project_memory.format_memory_for_agent("proj-cache-a")
        result_b = project_memory.format_memory_for_agent("proj-cache-b")
        assert "Project A" in result_a
        assert "Project B" in result_b
        assert result_a != result_b

    def test_write_document_invalidates_cache(self, memory_root: Path) -> None:
        project_memory._format_cache.clear()
        project_memory.update_context("proj-cache-3", "Initial")
        project_memory.format_memory_for_agent("proj-cache-3")

        cache_key = "proj-cache-3:"
        assert cache_key in project_memory._format_cache

        project_memory.write_document("proj-cache-3", "Doc", MemoryDocumentType.NOTES, "x")
        assert cache_key not in project_memory._format_cache

    def test_append_memory_entry_invalidates_cache(self, memory_root: Path) -> None:
        project_memory._format_cache.clear()
        project_memory.update_context("proj-cache-4", "Initial")
        project_memory.format_memory_for_agent("proj-cache-4")

        cache_key = "proj-cache-4:"
        assert cache_key in project_memory._format_cache

        project_memory.append_memory_entry("proj-cache-4", "note")
        assert cache_key not in project_memory._format_cache


class TestConditionalIntentClassification:
    """Verify that classify_intent routes memory-related prompts correctly."""

    def test_trim_clip_does_not_include_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("trim clip X by 2 seconds")
        assert "memory" not in cats

    def test_write_script_includes_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("write a script for the diner scene")
        assert "memory" in cats

    def test_remember_preference_includes_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("remember that the user likes rural settings")
        assert "memory" in cats

    def test_generate_video_does_not_include_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("generate a video of a sunset")
        assert "memory" not in cats

    def test_ambiguous_prompt_fallback_includes_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("hello")
        assert "memory" in cats  # fallback returns all categories

    def test_save_notes_includes_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("save these notes about the character")
        assert "memory" in cats

    def test_delete_clip_does_not_include_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("delete the first clip on the timeline")
        assert "memory" not in cats

    def test_research_locations_includes_memory(self) -> None:
        from agent.tool_knowledge_base import classify_intent
        cats = classify_intent("do some research on 1950s diners")
        assert "memory" in cats


class TestSubAgentConditionalMemory:
    """Verify that sub-agents only get memory for creative/review tasks."""

    def test_creative_task_gets_memory_tools(self) -> None:
        from agent.orchestration.sub_agent_pool import _get_scoped_tools
        from agent.types import TaskNode, TaskType, TaskStatus

        task = TaskNode(
            id="t1", description="Write a screenplay",
            task_type=TaskType.CREATIVE, status=TaskStatus.PENDING,
        )
        _, tool_names = _get_scoped_tools(task, None)
        assert "save_to_project_memory" in tool_names

    def test_execution_task_does_not_get_memory_tools(self) -> None:
        from agent.orchestration.sub_agent_pool import _get_scoped_tools
        from agent.types import TaskNode, TaskType, TaskStatus

        task = TaskNode(
            id="t2", description="Add clips to the timeline",
            task_type=TaskType.EXECUTION, status=TaskStatus.PENDING,
            tool_categories=["clip_editing"],
        )
        _, tool_names = _get_scoped_tools(task, None)
        assert "save_to_project_memory" not in tool_names

    def test_review_task_gets_memory_tools(self) -> None:
        from agent.orchestration.sub_agent_pool import _get_scoped_tools
        from agent.types import TaskNode, TaskType, TaskStatus

        task = TaskNode(
            id="t3", description="Review the generated shots",
            task_type=TaskType.REVIEW, status=TaskStatus.PENDING,
        )
        _, tool_names = _get_scoped_tools(task, None)
        assert "save_to_project_memory" in tool_names

    def test_creative_task_context_includes_memory(self, memory_root: Path) -> None:
        from agent.orchestration.sub_agent_pool import _build_user_message
        from agent.types import TaskNode, TaskType, TaskStatus, SubAgentContext

        project_memory.update_context("proj-sub-1", "Heist film about a couple")

        task = TaskNode(
            id="t4", description="Write the diner scene script",
            task_type=TaskType.CREATIVE, status=TaskStatus.PENDING,
        )
        ctx = SubAgentContext(task=task, project_id="proj-sub-1")
        msg = _build_user_message(ctx, ["save_to_project_memory"])
        assert "Heist film" in msg

    def test_execution_task_context_excludes_memory(self, memory_root: Path) -> None:
        from agent.orchestration.sub_agent_pool import _build_user_message
        from agent.types import TaskNode, TaskType, TaskStatus, SubAgentContext

        project_memory.update_context("proj-sub-2", "Heist film about a couple")

        task = TaskNode(
            id="t5", description="Trim all clips to 5 seconds",
            task_type=TaskType.EXECUTION, status=TaskStatus.PENDING,
        )
        ctx = SubAgentContext(task=task, project_id="proj-sub-2")
        msg = _build_user_message(ctx, ["trim_clip"])
        assert "Heist film" not in msg
