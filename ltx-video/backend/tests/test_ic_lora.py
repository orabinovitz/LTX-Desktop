"""Tests for IC-LoRA endpoints."""
import sys

import requests
from unittest.mock import MagicMock, patch

import ltx2_server


class TestIcLoraListModels:
    """GET /api/ic-lora/list-models"""

    def test_empty_directory(self, server):
        r = requests.get(f"{server}/api/ic-lora/list-models")
        assert r.status_code == 200
        data = r.json()
        assert data["models"] == []

    def test_with_files(self, server, create_fake_ic_lora_files):
        create_fake_ic_lora_files(["canny_control", "depth_control"])
        r = requests.get(f"{server}/api/ic-lora/list-models")
        data = r.json()
        assert len(data["models"]) == 2
        names = [m["name"] for m in data["models"]]
        assert "canny_control" in names
        assert "depth_control" in names

    def test_ignores_non_safetensors(self, server):
        (ltx2_server.IC_LORA_DIR / "notes.txt").write_text("hello")
        (ltx2_server.IC_LORA_DIR / "model.safetensors").write_bytes(b"\x00" * 1024)

        r = requests.get(f"{server}/api/ic-lora/list-models")
        data = r.json()
        assert len(data["models"]) == 1
        assert data["models"][0]["name"] == "model"

    def test_metadata_read_failure(self, server):
        """safe_open raises -> conditioning_type defaults to 'unknown'."""
        (ltx2_server.IC_LORA_DIR / "broken.safetensors").write_bytes(b"\x00" * 1024)

        r = requests.get(f"{server}/api/ic-lora/list-models")
        data = r.json()
        assert len(data["models"]) == 1
        assert data["models"][0]["conditioning_type"] == "unknown"


class TestIcLoraDownload:
    """POST /api/ic-lora/download-model"""

    @patch("urllib.request.urlopen")
    def test_download_known_model(self, mock_urlopen, server):
        mock_resp = MagicMock()
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers.get.return_value = "1000"
        mock_resp.read.side_effect = [b"\x00" * 1000, b""]
        mock_urlopen.return_value = mock_resp

        r = requests.post(
            f"{server}/api/ic-lora/download-model", json={"model": "canny"}
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["already_existed"] is False

    def test_already_exists(self, server):
        dest = ltx2_server.IC_LORA_DIR / "ltx-2-19b-ic-lora-canny-control.safetensors"
        dest.write_bytes(b"\x00" * 2_000_000)

        r = requests.post(
            f"{server}/api/ic-lora/download-model", json={"model": "canny"}
        )
        assert r.status_code == 200
        data = r.json()
        assert data["already_existed"] is True

    def test_unknown_model(self, server):
        r = requests.post(
            f"{server}/api/ic-lora/download-model", json={"model": "nonexistent"}
        )
        assert r.status_code == 400

    @patch("urllib.request.urlopen", side_effect=Exception("Connection refused"))
    def test_network_error(self, _mock, server):
        r = requests.post(
            f"{server}/api/ic-lora/download-model", json={"model": "canny"}
        )
        assert r.status_code == 500
        data = r.json()
        assert "error" in data


class TestIcLoraExtractConditioning:
    """POST /api/ic-lora/extract-conditioning"""

    def _setup_cv2(self, read_return=(True, MagicMock())):
        """Configure the cv2 stub for video capture + image processing."""
        cv2_mock = sys.modules["cv2"]
        cap_mock = MagicMock()
        cap_mock.get.return_value = 24.0
        cap_mock.read.return_value = read_return
        cv2_mock.VideoCapture.return_value = cap_mock
        cv2_mock.cvtColor.return_value = MagicMock()
        cv2_mock.Canny.return_value = MagicMock()
        cv2_mock.GaussianBlur.return_value = MagicMock()
        cv2_mock.applyColorMap.return_value = MagicMock()
        # imencode returns (success, jpeg_bytes)
        cv2_mock.imencode.return_value = (True, b"\xff\xd8\xff\xe0")
        return cv2_mock

    def test_canny_extraction(self, server):
        self._setup_cv2()
        video_path = ltx2_server.OUTPUTS_DIR / "test_video.mp4"
        video_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/extract-conditioning",
            json={
                "video_path": str(video_path),
                "conditioning_type": "canny",
                "frame_time": 0,
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "conditioning" in data
        assert "original" in data
        assert data["conditioning_type"] == "canny"

    def test_depth_extraction(self, server):
        self._setup_cv2()
        video_path = ltx2_server.OUTPUTS_DIR / "test_video.mp4"
        video_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/extract-conditioning",
            json={
                "video_path": str(video_path),
                "conditioning_type": "depth",
                "frame_time": 0,
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["conditioning_type"] == "depth"

    def test_missing_video(self, server):
        r = requests.post(
            f"{server}/api/ic-lora/extract-conditioning",
            json={"conditioning_type": "canny"},
        )
        assert r.status_code == 400

    def test_unreadable_frame(self, server):
        self._setup_cv2(read_return=(False, None))
        video_path = ltx2_server.OUTPUTS_DIR / "bad_video.mp4"
        video_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/extract-conditioning",
            json={"video_path": str(video_path), "conditioning_type": "canny"},
        )
        assert r.status_code == 400


class TestIcLoraGenerate:
    """POST /api/ic-lora/generate"""

    def _setup_cv2_for_generate(self):
        """Configure cv2 stub for the full IC-LoRA generate flow."""
        cv2_mock = sys.modules["cv2"]

        cap_mock = MagicMock()
        cap_mock.isOpened.return_value = True
        cap_mock.get.return_value = 24.0
        # Return a few frames, then signal end
        cap_mock.read.side_effect = [
            (True, MagicMock()),
            (True, MagicMock()),
            (False, None),
        ]
        cv2_mock.VideoCapture.return_value = cap_mock
        cv2_mock.VideoWriter.return_value = MagicMock()
        cv2_mock.VideoWriter_fourcc.return_value = MagicMock()
        cv2_mock.cvtColor.return_value = MagicMock()
        cv2_mock.GaussianBlur.return_value = MagicMock()
        cv2_mock.Canny.return_value = MagicMock()
        cv2_mock.applyColorMap.return_value = MagicMock()

    @patch("ltx2_server.load_ic_lora_pipeline")
    def test_happy_path(self, mock_load, server):
        self._setup_cv2_for_generate()

        pipeline_mock = MagicMock()
        mock_load.return_value = pipeline_mock

        video_path = ltx2_server.OUTPUTS_DIR / "input.mp4"
        video_path.write_bytes(b"\x00" * 100)
        lora_path = ltx2_server.IC_LORA_DIR / "test.safetensors"
        lora_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={
                "video_path": str(video_path),
                "lora_path": str(lora_path),
                "prompt": "test prompt",
                "conditioning_type": "canny",
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert "video_path" in data

    def test_missing_video_path(self, server):
        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={"lora_path": "/some/lora.safetensors"},
        )
        assert r.status_code == 400

    def test_missing_lora_path(self, server):
        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={"video_path": "/some/video.mp4"},
        )
        assert r.status_code == 400

    def test_video_not_found(self, server):
        lora_path = ltx2_server.IC_LORA_DIR / "test.safetensors"
        lora_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={
                "video_path": "/nonexistent/video.mp4",
                "lora_path": str(lora_path),
            },
        )
        assert r.status_code == 400

    def test_lora_not_found(self, server):
        video_path = ltx2_server.OUTPUTS_DIR / "input.mp4"
        video_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={
                "video_path": str(video_path),
                "lora_path": "/nonexistent/lora.safetensors",
            },
        )
        assert r.status_code == 400

    @patch("ltx2_server.load_ic_lora_pipeline", side_effect=RuntimeError("GPU OOM"))
    def test_pipeline_error(self, _mock, server):
        self._setup_cv2_for_generate()

        video_path = ltx2_server.OUTPUTS_DIR / "input.mp4"
        video_path.write_bytes(b"\x00" * 100)
        lora_path = ltx2_server.IC_LORA_DIR / "test.safetensors"
        lora_path.write_bytes(b"\x00" * 100)

        r = requests.post(
            f"{server}/api/ic-lora/generate",
            json={
                "video_path": str(video_path),
                "lora_path": str(lora_path),
                "prompt": "test",
            },
        )
        assert r.status_code == 500
