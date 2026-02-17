"""Tests for generation endpoints."""
import requests
from unittest.mock import patch, MagicMock

import ltx2_server


class TestGenerate:
    """POST /api/generate"""

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_t2v_happy_path(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "A beautiful sunset"),
                "resolution": (None, "1080p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
                "cameraMotion": (None, "none"),
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["video_path"] == "/tmp/test.mp4"
        mock_gen.assert_called_once()

    def test_already_running(self, server):
        ltx2_server.current_generation["status"] = "running"
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 409

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_i2v_with_image(self, mock_gen, server, make_test_image):
        img_buf = make_test_image(100, 100)
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "Animate this"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
                "image": ("test.png", img_buf, "image/png"),
            },
        )
        assert r.status_code == 200
        # Verify image was passed to generate_video
        call_kwargs = mock_gen.call_args.kwargs
        assert call_kwargs["image"] is not None

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_resolution_mapping_540p(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        assert kw["model_type"] == "fast-native"
        assert kw["width"] == 960
        assert kw["height"] == 544

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_resolution_mapping_720p(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "720p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        assert kw["model_type"] == "fast-native"
        assert kw["width"] == 1280
        assert kw["height"] == 704

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_resolution_mapping_1080p(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "1080p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        # 1080p stays "fast" (2-stage with upsampler)
        assert kw["model_type"] == "fast"
        assert kw["width"] == 960
        assert kw["height"] == 544

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_frame_calculation(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        # duration=2, fps=24 -> (48 // 8) * 8 + 1 = 49
        assert kw["num_frames"] == 49

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_locked_seed(self, mock_gen, server):
        ltx2_server.app_settings["seed_locked"] = True
        ltx2_server.app_settings["locked_seed"] = 123
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        assert kw["seed"] == 123

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_camera_motion_forwarded(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
                "cameraMotion": (None, "dolly_in"),
            },
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        assert kw["camera_motion"] == "dolly_in"

    @patch("ltx2_server.generate_video", side_effect=RuntimeError("GPU OOM"))
    def test_error_sets_state(self, _mock, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 500
        assert ltx2_server.current_generation["status"] == "error"

    @patch("ltx2_server.generate_video", side_effect=RuntimeError("cancelled"))
    def test_cancelled_response(self, _mock, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "cancelled"

    @patch("ltx2_server.generate_video", return_value="/tmp/test.mp4")
    def test_state_reset_before_generation(self, _mock, server):
        r = requests.post(
            f"{server}/api/generate",
            files={
                "prompt": (None, "test"),
                "resolution": (None, "540p"),
                "model": (None, "fast"),
                "duration": (None, "2"),
                "fps": (None, "24"),
            },
        )
        assert r.status_code == 200
        # A new generation ID should have been assigned
        assert ltx2_server.current_generation["id"] is not None


class TestGenerateCancel:
    """POST /api/generate/cancel"""

    def test_cancel_active(self, server):
        ltx2_server.current_generation["status"] = "running"
        ltx2_server.current_generation["id"] = "test123"
        r = requests.post(f"{server}/api/generate/cancel")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "cancelling"

    def test_cancel_no_active(self, server):
        r = requests.post(f"{server}/api/generate/cancel")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "no_active_generation"


class TestGenerationProgress:
    """GET /api/generation/progress"""

    def test_idle(self, server):
        r = requests.get(f"{server}/api/generation/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "idle"

    def test_running(self, server):
        ltx2_server.current_generation["status"] = "running"
        ltx2_server.current_generation["phase"] = "inference"
        ltx2_server.current_generation["progress"] = 50
        ltx2_server.current_generation["current_step"] = 4
        ltx2_server.current_generation["total_steps"] = 8

        r = requests.get(f"{server}/api/generation/progress")
        data = r.json()
        assert data["status"] == "running"
        assert data["phase"] == "inference"
        assert data["progress"] == 50
        assert data["currentStep"] == 4
        assert data["totalSteps"] == 8


class TestGenerateImage:
    """POST /api/generate-image"""

    @patch("ltx2_server.generate_image", return_value=["/tmp/img1.png"])
    def test_happy_path(self, _mock, server):
        r = requests.post(
            f"{server}/api/generate-image",
            json={"prompt": "A cat", "width": 1024, "height": 1024, "numSteps": 4},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["image_paths"] == ["/tmp/img1.png"]

    def test_already_running(self, server):
        ltx2_server.current_generation["status"] = "running"
        r = requests.post(f"{server}/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 409

    @patch("ltx2_server.generate_image", return_value=["/tmp/img.png"])
    def test_dimension_clamping(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate-image",
            json={"prompt": "test", "width": 1023, "height": 1023},
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        # 1023 // 16 * 16 = 1008
        assert kw["width"] == 1008
        assert kw["height"] == 1008

    @patch("ltx2_server.generate_image", return_value=["/tmp/img.png"])
    def test_num_images_clamped(self, mock_gen, server):
        r = requests.post(
            f"{server}/api/generate-image",
            json={"prompt": "test", "numImages": 20},
        )
        assert r.status_code == 200
        kw = mock_gen.call_args.kwargs
        assert kw["num_images"] == 12

    @patch("ltx2_server.generate_image", side_effect=RuntimeError("GPU OOM"))
    def test_error(self, _mock, server):
        r = requests.post(f"{server}/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 500

    @patch("ltx2_server.generate_image", side_effect=RuntimeError("cancelled"))
    def test_cancelled(self, _mock, server):
        r = requests.post(f"{server}/api/generate-image", json={"prompt": "test"})
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "cancelled"


class TestEditImage:
    """POST /api/edit-image"""

    @patch("ltx2_server.edit_image", return_value=["/tmp/edited.png"])
    def test_happy_path(self, _mock, server, make_test_image):
        img_buf = make_test_image(100, 100)
        r = requests.post(
            f"{server}/api/edit-image",
            files={
                "prompt": (None, "Make it blue"),
                "width": (None, "1024"),
                "height": (None, "1024"),
                "image": ("test.png", img_buf, "image/png"),
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert data["image_paths"] == ["/tmp/edited.png"]

    def test_no_image(self, server):
        r = requests.post(
            f"{server}/api/edit-image",
            files={
                "prompt": (None, "Make it blue"),
                "width": (None, "1024"),
                "height": (None, "1024"),
            },
        )
        assert r.status_code == 400

    def test_already_running(self, server, make_test_image):
        ltx2_server.current_generation["status"] = "running"
        img_buf = make_test_image(100, 100)
        r = requests.post(
            f"{server}/api/edit-image",
            files={
                "prompt": (None, "test"),
                "image": ("test.png", img_buf, "image/png"),
            },
        )
        assert r.status_code == 409

    @patch("ltx2_server.edit_image", return_value=["/tmp/edited.png"])
    def test_multiple_reference_images(self, mock_edit, server, make_test_image):
        r = requests.post(
            f"{server}/api/edit-image",
            files={
                "prompt": (None, "Combine styles"),
                "width": (None, "1024"),
                "height": (None, "1024"),
                "image": ("img1.png", make_test_image(100, 100), "image/png"),
                "image2": ("img2.png", make_test_image(100, 100), "image/png"),
                "image3": ("img3.png", make_test_image(100, 100), "image/png"),
            },
        )
        assert r.status_code == 200
        kw = mock_edit.call_args.kwargs
        assert len(kw["input_images"]) == 3
