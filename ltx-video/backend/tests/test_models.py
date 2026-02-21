"""Integration-style tests for model-related endpoints."""

from state.app_state_types import FileDownloadRunning


class TestModelsList:
    def test_defaults(self, client):
        r = client.get("/api/models")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 2
        assert data[0]["id"] == "fast"
        assert "8 steps" in data[0]["description"]
        assert data[1]["id"] == "pro"
        assert "20 steps" in data[1]["description"]

    def test_custom_pro_steps(self, client, test_state):
        test_state.state.app_settings.pro_model.steps = 30
        r = client.get("/api/models")
        assert "30 steps" in r.json()[1]["description"]


class TestModelsStatus:
    def test_nothing_downloaded(self, client):
        r = client.get("/api/models/status")
        assert r.status_code == 200
        assert r.json()["all_downloaded"] is False

    def test_all_downloaded(self, client, create_fake_model_files):
        create_fake_model_files(include_flux=True)
        r = client.get("/api/models/status")
        assert r.json()["all_downloaded"] is True

    def test_with_api_key(self, client, create_fake_model_files, test_state):
        create_fake_model_files(include_flux=True)
        test_state.state.app_settings.ltx_api_key = "test-key"

        r = client.get("/api/models/status")
        te_model = next(m for m in r.json()["models"] if m["name"] == "text_encoder")
        assert te_model["required"] is False


class TestDownloadProgress:
    def test_idle(self, client):
        r = client.get("/api/models/download/progress")
        assert r.status_code == 200
        assert r.json()["status"] == "idle"

    def test_active(self, client, test_state):
        test_state.state.downloading_session = {
            "checkpoint": FileDownloadRunning(
                target_path="checkpoint",
                progress=0.5,
                downloaded_bytes=5_000_000_000,
                total_bytes=10_000_000_000,
                speed_mbps=50,
            )
        }
        r = client.get("/api/models/download/progress")
        data = r.json()
        assert data["status"] == "downloading"
        assert data["currentFile"] == "checkpoint"


class TestModelDownload:
    def test_start_success(self, client, test_state):
        r = client.post("/api/models/download", json={})
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "started"
        assert data["skippingTextEncoder"] is False

        snapshot_calls = [c for c in test_state.model_downloader.calls if c["kind"] == "snapshot"]
        assert snapshot_calls

    def test_already_in_progress(self, client, test_state):
        test_state.downloads.start_download({"checkpoint": ("checkpoint", 100)})
        r = client.post("/api/models/download", json={})
        assert r.status_code == 409

    def test_skip_text_encoder(self, client, test_state):
        r = client.post("/api/models/download", json={"skipTextEncoder": True})
        assert r.status_code == 200

        snapshot_calls = [c for c in test_state.model_downloader.calls if c["kind"] == "snapshot"]
        assert all(c["allow_patterns"] != ["text_encoder/*"] for c in snapshot_calls)

    def test_api_key_auto_skip(self, client, test_state):
        test_state.state.app_settings.ltx_api_key = "test-key"

        r = client.post("/api/models/download", json={})
        assert r.status_code == 200
        assert r.json()["skippingTextEncoder"] is True


class TestTextEncoderDownload:
    def test_start_download(self, client):
        r = client.post("/api/text-encoder/download")
        assert r.status_code == 200
        assert r.json()["status"] == "started"

    def test_already_downloaded(self, client, test_state):
        te_dir = test_state.config.model_path("text_encoder")
        te_dir.mkdir(parents=True, exist_ok=True)
        (te_dir / "model.safetensors").write_bytes(b"\x00" * 1024)

        r = client.post("/api/text-encoder/download")
        assert r.status_code == 200
        assert r.json()["status"] == "already_downloaded"

    def test_already_in_progress(self, client, test_state):
        test_state.downloads.start_download({"checkpoint": ("checkpoint", 100)})
        r = client.post("/api/text-encoder/download")
        assert r.status_code == 409
