"""Tests verifying JSON key names in responses match the established contract.

camelCase keys: settings, warmup status, download progress, generation progress
snake_case keys: generation paths, image paths
"""
from unittest.mock import patch, MagicMock

import ltx2_server


class TestWarmupStatusCamelCaseKeys:
    """GET /api/warmup/status — keys must be camelCase."""

    def test_camelcase_keys(self, client):
        ltx2_server.warmup_state["status"] = "loading"
        ltx2_server.warmup_state["current_step"] = "Loading model..."
        ltx2_server.warmup_state["progress"] = 50

        r = client.get("/api/warmup/status")
        assert r.status_code == 200
        data = r.json()
        assert "currentStep" in data
        assert "current_step" not in data
        assert data["currentStep"] == "Loading model..."


class TestGenerationProgressCamelCaseKeys:
    """GET /api/generation/progress — keys must be camelCase."""

    def test_camelcase_keys(self, client):
        ltx2_server.current_generation["status"] = "running"
        ltx2_server.current_generation["current_step"] = 5
        ltx2_server.current_generation["total_steps"] = 20

        r = client.get("/api/generation/progress")
        assert r.status_code == 200
        data = r.json()
        assert "currentStep" in data
        assert "totalSteps" in data
        assert "current_step" not in data
        assert "total_steps" not in data
        assert data["currentStep"] == 5
        assert data["totalSteps"] == 20


class TestDownloadProgressCamelCaseKeys:
    """GET /api/models/download/progress — keys must be camelCase."""

    def test_camelcase_keys(self, client):
        ltx2_server.model_download_state.update({
            "status": "downloading",
            "current_file": "model.safetensors",
            "current_file_progress": 45,
            "total_progress": 30,
            "downloaded_bytes": 5_000_000_000,
            "total_bytes": 19_000_000_000,
            "files_completed": 1,
            "total_files": 4,
            "error": None,
            "speed_mbps": 50,
        })

        r = client.get("/api/models/download/progress")
        assert r.status_code == 200
        data = r.json()

        expected_keys = {
            "status", "currentFile", "currentFileProgress", "totalProgress",
            "downloadedBytes", "totalBytes", "filesCompleted", "totalFiles",
            "error", "speedMbps",
        }
        assert set(data.keys()) == expected_keys

        # Ensure no snake_case keys leaked
        for key in data:
            assert "_" not in key or key == "status", f"Unexpected snake_case key: {key}"


class TestSettingsCamelCaseKeys:
    """GET /api/settings — keys must be camelCase."""

    def test_camelcase_keys(self, client):
        r = client.get("/api/settings")
        assert r.status_code == 200
        data = r.json()

        assert "keepModelsLoaded" not in data
        assert "keep_models_loaded" not in data
        assert "useTorchCompile" in data
        assert "use_torch_compile" not in data
        assert "fastModel" in data
        assert "fast_model" not in data
        assert "seedLocked" in data
        assert "seed_locked" not in data


class TestGenerateSnakeCaseKeys:
    """POST /api/generate — response keys must be snake_case."""

    @patch("ltx2_server.generate_video", return_value="/tmp/output.mp4")
    def test_snake_case_keys(self, _gen, client):
        r = client.post("/api/generate", json={"prompt": "test"})
        assert r.status_code == 200
        data = r.json()

        assert "video_path" in data
        assert "videoPath" not in data


class TestGenerateImageSnakeCaseKeys:
    """POST /api/generate-image — response keys must be snake_case."""

    @patch("ltx2_server.generate_image", return_value=["/tmp/img.png"])
    def test_snake_case_keys(self, _gen, client):
        r = client.post("/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 200
        data = r.json()

        assert "image_paths" in data
        assert "imagePaths" not in data
