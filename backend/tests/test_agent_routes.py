"""Integration tests for /api/agent/* routes via TestClient."""

from __future__ import annotations

import json

import pytest

from agent.model_policy import LIVE_AUDIO_MODEL
from agent.brain import _brains, _brain_lock, ProjectBrain
from agent import project_memory
from agent.orchestration.orchestrator import _sessions
from agent.types import AnalysisStatus
from tests.fakes.services import FakeResponse


@pytest.fixture(autouse=True)
def _clean_agent_state():
    """Clear module-level agent state between tests."""
    _sessions.clear()
    with _brain_lock:
        _brains.clear()
    yield
    _sessions.clear()
    with _brain_lock:
        _brains.clear()


def _gemini_response(text: str = "", function_calls: list[dict] | None = None) -> FakeResponse:
    parts = []
    if text:
        parts.append({"text": text})
    for fc in (function_calls or []):
        parts.append({"functionCall": fc})
    return FakeResponse(
        status_code=200,
        json_payload={"candidates": [{"content": {"parts": parts}}]},
    )


def _planner_response(tasks: list[dict], duration: float = 60) -> FakeResponse:
    payload = {"tasks": tasks, "target_duration_seconds": duration}
    return FakeResponse(
        status_code=200,
        json_payload={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]},
    )


# ====================================================================
# /api/agent/execute
# ====================================================================


class TestAgentExecute:
    def test_no_api_key_returns_error(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/execute", json={
            "prompt": "trim this clip",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["done"] is True
        assert "api key" in data["message"].lower()

    def test_execute_with_api_key(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", _gemini_response("I'll trim that clip for you"))

        resp = client.post("/api/agent/execute", json={
            "prompt": "trim this clip",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"]
        assert data["diagnostics"]["selected_model"] == "gemini-3.1-pro-preview"
        assert data["diagnostics"]["stage_name"] == "simple_agent"
        assert isinstance(data["diagnostics"]["llm_ms"], int)

    def test_execute_with_tool_calls(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", _gemini_response(function_calls=[{
            "name": "trim_clip",
            "args": {"clip_id": "c1", "start": 0, "end": 5},
        }]))

        resp = client.post("/api/agent/execute", json={
            "prompt": "trim clip c1 to 5 seconds",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["tool_calls"]) >= 1


# ====================================================================
# /api/agent/continue
# ====================================================================


class TestAgentContinue:
    def test_continue_no_api_key(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/continue", json={
            "tool_results": [],
            "session_id": "sess-1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["done"] is True


# ====================================================================
# /api/agent/classify-complexity
# ====================================================================


class TestClassifyComplexity:
    def test_simple_prompt(self, client, test_state):
        resp = client.get("/api/agent/classify-complexity", params={"prompt": "trim this"})
        assert resp.status_code == 200
        assert resp.json()["complexity"] == "simple"

    def test_orchestrated_prompt(self, client, test_state):
        resp = client.get("/api/agent/classify-complexity", params={
            "prompt": "first generate a video then edit it with cinematic style",
        })
        assert resp.status_code == 200
        assert resp.json()["complexity"] == "orchestrated"


# ====================================================================
# /api/agent/clarify
# ====================================================================


class TestClarify:
    def test_no_api_key_returns_no_clarification(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/clarify", json={
            "prompt": "Create a full cinematic marketing video",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_clarification"] is False

    def test_clarify_returns_questions(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        clarify_payload = {
            "needs_clarification": True,
            "questions": [
                {
                    "id": "target-platform",
                    "question": "What platform is this video for?",
                    "options": [
                        {"id": "youtube", "label": "YouTube (16:9)"},
                        {"id": "instagram-reels", "label": "Instagram Reels (9:16)"},
                        {"id": "tiktok", "label": "TikTok (9:16)"},
                    ],
                    "allow_custom": True,
                },
                {
                    "id": "visual-style",
                    "question": "What visual style are you going for?",
                    "options": [
                        {"id": "cinematic", "label": "Cinematic / Film-like"},
                        {"id": "clean-minimal", "label": "Clean and minimal"},
                        {"id": "bold-energetic", "label": "Bold and energetic"},
                    ],
                    "allow_custom": True,
                },
            ],
        }
        fake_services.http.queue("post", FakeResponse(
            status_code=200,
            json_payload={"candidates": [{"content": {"parts": [{"text": json.dumps(clarify_payload)}]}}]},
        ))

        resp = client.post("/api/agent/clarify", json={
            "prompt": "Create a full cinematic marketing video",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_clarification"] is True
        assert len(data["questions"]) == 2
        assert data["questions"][0]["id"] == "target-platform"
        assert len(data["questions"][0]["options"]) == 3
        assert data["diagnostics"]["selected_model"] == "gemini-3.1-flash-lite-preview"
        assert data["diagnostics"]["stage_name"] == "clarification"
        assert isinstance(data["diagnostics"]["llm_ms"], int)

    def test_clarify_handles_gemini_error(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", FakeResponse(status_code=500, text="Internal error"))

        resp = client.post("/api/agent/clarify", json={
            "prompt": "Create a full cinematic marketing video",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_clarification"] is False

    def test_clarify_handles_no_clarification_needed(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        clarify_payload = {"needs_clarification": False, "questions": []}
        fake_services.http.queue("post", FakeResponse(
            status_code=200,
            json_payload={"candidates": [{"content": {"parts": [{"text": json.dumps(clarify_payload)}]}}]},
        ))

        resp = client.post("/api/agent/clarify", json={
            "prompt": "Generate a sunset video and trim to 5 seconds",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["needs_clarification"] is False


# ====================================================================
# /api/agent/orchestrate
# ====================================================================


class TestOrchestrate:
    def test_no_api_key(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/orchestrate", json={
            "prompt": "Create a marketing video",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "error"
        assert data["done"] is True

    def test_orchestrate_starts_session(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
        ]))

        resp = client.post("/api/agent/orchestrate", json={
            "prompt": "Create a video",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"]
        assert len(data["tasks"]) == 1
        assert data["diagnostics"]["selected_model"] == "gemini-3.1-flash-lite-preview"
        assert data["diagnostics"]["stage_name"] == "orchestrator_planner"
        assert isinstance(data["diagnostics"]["planning_ms"], int)

    def test_orchestrate_continue_expired(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        resp = client.post("/api/agent/orchestrate/continue", json={
            "session_id": "nonexistent",
            "tool_results": [],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["done"] is True
        assert "not found" in data["message"].lower() or "expired" in data["message"].lower()

    def test_skip_pending_task(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
            {"id": "task-2", "description": "Generate video", "task_type": "execution",
             "depends_on": ["task-1"], "tool_categories": ["generation"],
             "context_requirements": []},
        ]))

        resp = client.post("/api/agent/orchestrate", json={
            "prompt": "Create a video",
        })
        assert resp.status_code == 200
        session_id = resp.json()["session_id"]

        resp = client.post("/api/agent/orchestrate/skip-task", json={
            "session_id": session_id,
            "task_id": "task-2",
        })
        assert resp.status_code == 200
        data = resp.json()
        task_2 = next(t for t in data["tasks"] if t["id"] == "task-2")
        assert task_2["status"] == "cancelled"
        assert task_2["error"] == "Skipped by user"

    def test_skip_nonpending_task_rejected(self, client, test_state, fake_services):
        test_state.state.app_settings.gemini_api_key = "test-key"
        fake_services.http.queue("post", _planner_response([
            {"id": "task-1", "description": "Write script", "task_type": "creative",
             "depends_on": [], "tool_categories": [], "context_requirements": []},
        ]))

        resp = client.post("/api/agent/orchestrate", json={
            "prompt": "Create a video",
        })
        session_id = resp.json()["session_id"]

        from agent.types import TaskStatus
        session = _sessions[session_id]
        task = session.dag.get_task("task-1")
        assert task is not None
        task.status = TaskStatus.RUNNING

        resp = client.post("/api/agent/orchestrate/skip-task", json={
            "session_id": session_id,
            "task_id": "task-1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "running" in data["message"].lower()

    def test_skip_expired_session(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = "test-key"
        resp = client.post("/api/agent/orchestrate/skip-task", json={
            "session_id": "nonexistent",
            "task_id": "task-1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["done"] is True
        assert "not found" in data["message"].lower() or "expired" in data["message"].lower()


# ====================================================================
# /api/agent/brain
# ====================================================================


class TestBrainRoutes:
    def test_get_brain_not_found(self, client, test_state):
        resp = client.get("/api/agent/brain/proj-1")
        assert resp.status_code == 200
        assert resp.json()["status"] == "not_found"

    def test_get_brain_found(self, client, test_state):
        brain = ProjectBrain(project_id="proj-1", summary="Test brain")
        with _brain_lock:
            _brains["proj-1"] = brain
        resp = client.get("/api/agent/brain/proj-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["summary"] == "Test brain"

    def test_build_brain_no_metadata(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = "test-key"
        resp = client.post("/api/agent/brain/proj-1/build")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "no_metadata"

    def test_build_brain_no_api_key(self, client, test_state):
        # Handler checks metadata first, then API key; with no metadata, returns no_metadata
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/brain/proj-1/build")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "no_metadata"


# ====================================================================
# /api/agent/video-metadata
# ====================================================================


class TestVideoMetadataRoute:
    def test_not_found(self, client, test_state):
        resp = client.get("/api/agent/video-metadata/unknown-asset")
        assert resp.status_code == 200
        assert resp.json()["status"] == "not_found"


# ====================================================================
# /api/agent/decompose-video
# ====================================================================


class TestDecomposeVideoRoute:
    def test_no_analysis(self, client, test_state):
        resp = client.post("/api/agent/decompose-video/unknown-asset")
        assert resp.status_code == 200
        data = resp.json()
        assert data["error"]
        assert "no analysis" in data["error"].lower()


# ====================================================================
# /api/agent/memory CRUD
# ====================================================================


class TestMemoryRoutes:
    def test_list_empty_memory(self, client, test_state):
        resp = client.get("/api/agent/memory/proj-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["project_id"] == "proj-1"
        assert data["documents"] == []

    def test_create_and_read_document(self, client, test_state, tmp_path):
        assets_path = str(tmp_path)
        resp = client.post("/api/agent/memory/proj-1/document", json={
            "project_id": "proj-1",
            "title": "Test Script",
            "type": "script",
            "content": "EXT. PARK - DAY",
            "assets_path": assets_path,
        })
        assert resp.status_code == 200
        doc_meta = resp.json()
        doc_id = doc_meta["id"]

        resp = client.get(
            f"/api/agent/memory/proj-1/document/{doc_id}",
            params={"assets_path": assets_path},
        )
        assert resp.status_code == 200
        doc = resp.json()
        assert doc["content"] == "EXT. PARK - DAY"

    def test_delete_nonexistent_document(self, client, test_state):
        resp = client.delete("/api/agent/memory/proj-1/document/nonexistent")
        assert resp.status_code == 404

    def test_context_read_write(self, client, test_state, tmp_path):
        assets_path = str(tmp_path)
        resp = client.get(
            "/api/agent/memory/proj-1/context",
            params={"assets_path": assets_path},
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == ""

        resp = client.put("/api/agent/memory/proj-1/context", json={
            "project_id": "proj-1",
            "content": "Master context document",
            "assets_path": assets_path,
        })
        assert resp.status_code == 200

        resp = client.get(
            "/api/agent/memory/proj-1/context",
            params={"assets_path": assets_path},
        )
        assert resp.json()["content"] == "Master context document"

    def test_memory_log(self, client, test_state, tmp_path):
        assets_path = str(tmp_path)
        resp = client.get(
            "/api/agent/memory/proj-1/log",
            params={"assets_path": assets_path},
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == ""

        resp = client.post("/api/agent/memory/proj-1/log", json={
            "project_id": "proj-1",
            "entry": "User prefers cinematic style",
            "assets_path": assets_path,
        })
        assert resp.status_code == 200

        resp = client.get(
            "/api/agent/memory/proj-1/log",
            params={"assets_path": assets_path},
        )
        assert "cinematic" in resp.json()["content"]


# ====================================================================
# /api/agent/live-config
# ====================================================================


class TestLiveConfig:
    def test_get_live_config(self, client, test_state):
        resp = client.get("/api/agent/live-config")
        assert resp.status_code == 200
        data = resp.json()
        assert "system_prompt" in data
        assert "tools" in data
        assert "model" in data
        assert data["model"] == LIVE_AUDIO_MODEL


# ====================================================================
# /api/agent/live-token
# ====================================================================


class TestLiveToken:
    def test_no_api_key_returns_503(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/live-token")
        assert resp.status_code == 503
