"""Integration tests for /api/agent/* routes via TestClient."""

from __future__ import annotations

import json

import pytest

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


# ====================================================================
# /api/agent/live-token
# ====================================================================


class TestLiveToken:
    def test_no_api_key_returns_503(self, client, test_state):
        test_state.state.app_settings.gemini_api_key = ""
        resp = client.post("/api/agent/live-token")
        assert resp.status_code == 503
