"""Tests for model-related endpoints."""
from unittest.mock import patch

import ltx2_server


class TestModelsList:
    """GET /api/models"""

    def test_defaults(self, client):
        r = client.get("/api/models")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 2
        assert data[0]["id"] == "fast"
        assert "8 steps" in data[0]["description"]
        assert data[1]["id"] == "pro"
        assert "20 steps" in data[1]["description"]

    def test_custom_pro_steps(self, client):
        ltx2_server.app_settings.pro_model.steps = 30
        r = client.get("/api/models")
        data = r.json()
        assert "8 steps" in data[0]["description"]
        assert "30 steps" in data[1]["description"]


class TestModelsStatus:
    """GET /api/models/status"""

    def test_nothing_downloaded(self, client):
        r = client.get("/api/models/status")
        assert r.status_code == 200
        data = r.json()
        assert data["all_downloaded"] is False

    def test_all_downloaded(self, client, create_fake_model_files):
        create_fake_model_files()
        # Also need Flux directory with a file
        ltx2_server.FLUX_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        (ltx2_server.FLUX_MODELS_DIR / "model.safetensors").write_bytes(b"\x00" * 1024)

        r = client.get("/api/models/status")
        data = r.json()
        assert data["all_downloaded"] is True

    def test_partial_download(self, client):
        # Only create checkpoint
        ltx2_server.CHECKPOINT_PATH.write_bytes(b"\x00" * 1024)
        r = client.get("/api/models/status")
        data = r.json()
        assert data["all_downloaded"] is False

    def test_with_api_key(self, client, create_fake_model_files):
        create_fake_model_files()
        ltx2_server.app_settings.ltx_api_key = "test-key"
        # Need Flux too
        ltx2_server.FLUX_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        (ltx2_server.FLUX_MODELS_DIR / "model.safetensors").write_bytes(b"\x00" * 1024)

        r = client.get("/api/models/status")
        data = r.json()
        te_model = next(m for m in data["models"] if m["name"] == "text_encoder")
        assert te_model["required"] is False


class TestDownloadProgress:
    """GET /api/models/download/progress"""

    def test_idle(self, client):
        r = client.get("/api/models/download/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "idle"

    def test_active(self, client):
        ltx2_server.model_download_state["status"] = "downloading"
        ltx2_server.model_download_state["current_file"] = "model.safetensors"
        ltx2_server.model_download_state["total_progress"] = 50

        r = client.get("/api/models/download/progress")
        data = r.json()
        assert data["status"] == "downloading"
        assert data["currentFile"] == "model.safetensors"
        assert data["totalProgress"] == 50


class TestModelDownload:
    """POST /api/models/download"""

    @patch("ltx2_server.start_model_download", return_value=True)
    def test_start_success(self, mock_dl, client):
        r = client.post("/api/models/download", json={})
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "started"

    def test_already_in_progress(self, client):
        ltx2_server.model_download_state["status"] = "downloading"
        r = client.post("/api/models/download", json={})
        assert r.status_code == 409

    @patch("ltx2_server.start_model_download", return_value=True)
    def test_skip_text_encoder(self, mock_dl, client):
        r = client.post(
            "/api/models/download",
            json={"skipTextEncoder": True},
        )
        assert r.status_code == 200
        mock_dl.assert_called_once_with(skip_text_encoder=True)

    @patch("ltx2_server.start_model_download", return_value=True)
    def test_api_key_auto_skip(self, mock_dl, client):
        ltx2_server.app_settings.ltx_api_key = "test-key"
        r = client.post("/api/models/download", json={})
        assert r.status_code == 200
        mock_dl.assert_called_once_with(skip_text_encoder=True)

    @patch("ltx2_server.start_model_download", return_value=False)
    def test_start_failure(self, _mock, client):
        r = client.post("/api/models/download", json={})
        assert r.status_code == 400


class TestTextEncoderDownload:
    """POST /api/text-encoder/download"""

    def test_start_download(self, client):
        r = client.post("/api/text-encoder/download")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "started"

    def test_already_downloaded(self, client):
        te_dir = ltx2_server.GEMMA_PATH / "text_encoder"
        te_dir.mkdir(parents=True, exist_ok=True)
        (te_dir / "model.safetensors").write_bytes(b"\x00" * 1024)

        r = client.post("/api/text-encoder/download")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "already_downloaded"

    def test_already_in_progress(self, client):
        ltx2_server.model_download_state["status"] = "downloading"
        r = client.post("/api/text-encoder/download")
        assert r.status_code == 409
