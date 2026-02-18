"""Tests for /health, /api/gpu-info, /api/warmup/status endpoints."""
import sys

from unittest.mock import MagicMock, patch

import ltx2_server

GPU_INFO_STUB = {"name": "Test GPU", "vram": 8192, "vramUsed": 1024}


class TestHealth:
    """GET /health"""

    @patch("ltx2_server.get_gpu_info", return_value=GPU_INFO_STUB)
    def test_no_models_loaded(self, _gpu, client):
        r = client.get("/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert data["models_loaded"] is False
        assert data["active_model"] is None
        assert data["fast_loaded"] is False
        assert data["pro_loaded"] is False

    @patch("ltx2_server.get_gpu_info", return_value=GPU_INFO_STUB)
    def test_fast_model_loaded(self, _gpu, client):
        ltx2_server.distilled_pipeline = MagicMock()
        r = client.get("/health")
        data = r.json()
        assert data["models_loaded"] is True
        assert data["active_model"] == "fast"
        assert data["fast_loaded"] is True

    @patch("ltx2_server.get_gpu_info", return_value=GPU_INFO_STUB)
    def test_pro_model_loaded(self, _gpu, client):
        ltx2_server.pro_pipeline = MagicMock()
        r = client.get("/health")
        data = r.json()
        assert data["models_loaded"] is True
        assert data["active_model"] == "pro"

    @patch("ltx2_server.get_gpu_info", return_value=GPU_INFO_STUB)
    def test_models_downloaded(self, _gpu, client, create_fake_model_files):
        create_fake_model_files()
        r = client.get("/health")
        data = r.json()
        for ms in data["models_status"]:
            assert ms["downloaded"] is True

    @patch("ltx2_server.get_gpu_info", return_value=GPU_INFO_STUB)
    def test_cors_header(self, _gpu, client):
        r = client.get("/health", headers={"Origin": "http://localhost:5173"})
        assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


class TestGpuInfo:
    """GET /api/gpu-info"""

    @patch("ltx2_server.get_gpu_info", return_value={"name": "Unknown", "vram": 0, "vramUsed": 0})
    def test_no_cuda(self, _gpu, client):
        r = client.get("/api/gpu-info")
        assert r.status_code == 200
        data = r.json()
        assert data["cuda_available"] is False
        assert data["gpu_name"] is None
        assert data["vram_gb"] is None

    @patch("ltx2_server.get_gpu_info", return_value={"name": "RTX 5090", "vram": 32768, "vramUsed": 1024})
    def test_with_cuda(self, _gpu, client):
        torch_mod = sys.modules["torch"]
        torch_mod.cuda.is_available.return_value = True
        torch_mod.cuda.get_device_name.return_value = "RTX 5090"
        props = MagicMock()
        props.total_memory = 32 * 1024**3
        torch_mod.cuda.get_device_properties.return_value = props

        r = client.get("/api/gpu-info")
        data = r.json()
        assert data["cuda_available"] is True
        assert data["gpu_name"] == "RTX 5090"
        assert data["vram_gb"] == 32


class TestWarmupStatus:
    """GET /api/warmup/status"""

    def test_pending(self, client):
        r = client.get("/api/warmup/status")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "pending"
        assert data["progress"] == 0

    def test_ready(self, client):
        ltx2_server.warmup_state["status"] = "ready"
        ltx2_server.warmup_state["progress"] = 100
        r = client.get("/api/warmup/status")
        data = r.json()
        assert data["status"] == "ready"
        assert data["progress"] == 100

    def test_error(self, client):
        ltx2_server.warmup_state["status"] = "error"
        ltx2_server.warmup_state["error"] = "GPU not found"
        r = client.get("/api/warmup/status")
        data = r.json()
        assert data["status"] == "error"
        assert data["error"] == "GPU not found"
