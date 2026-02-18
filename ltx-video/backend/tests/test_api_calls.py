"""Tests for /api/enhance-prompt, /api/suggest-gap-prompt, /api/upscale, /api/retake."""
import json
import sys
import uuid
from unittest.mock import MagicMock, patch

import requests

import ltx2_server

# Capture original functions BEFORE any @patch replaces them.
# @patch("ltx2_server.requests.post") patches the global requests module,
# so the test client needs these saved references to reach the real server.
_real_post = requests.post
_real_get = requests.get


# ── helpers ──────────────────────────────────────────────────────────

def _gemini_ok(text="Enhanced prompt text"):
    """Return a mock Response that looks like a successful Gemini reply."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "candidates": [{"content": {"parts": [{"text": text}]}}]
    }
    return resp


def _gemini_error(status=429, body="rate limited"):
    resp = MagicMock()
    resp.status_code = status
    resp.text = body
    return resp


def _gemini_empty_candidates():
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"candidates": []}
    return resp


def _setup_av_mock(width=640, height=480, duration_us=5_000_000):
    """Configure sys.modules['av'] so `av.open(...)` returns useful metadata."""
    av_mock = sys.modules["av"]
    ctx = MagicMock()
    stream = MagicMock()
    stream.width = width
    stream.height = height
    stream.duration = None
    stream.time_base = None
    ctx.streams.video = [stream]
    ctx.duration = duration_us
    ctx.__enter__ = MagicMock(return_value=ctx)
    ctx.__exit__ = MagicMock(return_value=False)
    av_mock.open.return_value = ctx
    return av_mock


# ═════════════════════════════════════════════════════════════════════
# POST /api/enhance-prompt
# ═════════════════════════════════════════════════════════════════════

class TestEnhancePrompt:
    """POST /api/enhance-prompt"""

    @patch("ltx2_server.requests.post")
    def test_happy_path_t2v(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "test-key"
        mock_post.return_value = _gemini_ok("A beautiful cinematic sunset")

        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "sunset", "mode": "t2v",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["enhanced_prompt"] == "A beautiful cinematic sunset"
        assert "skipped" not in data

    @patch("ltx2_server.requests.post")
    def test_happy_path_i2v(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "test-key"
        ltx2_server.app_settings["prompt_enhancer_enabled_i2v"] = True
        mock_post.return_value = _gemini_ok("Animated image")

        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "animate it", "mode": "i2v",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["enhanced_prompt"] == "Animated image"
        # Verify i2v system prompt was used in the Gemini call
        call_payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        sys_text = call_payload["systemInstruction"]["parts"][0]["text"]
        assert sys_text == ltx2_server.app_settings["i2v_system_prompt"]

    def test_skip_t2i_mode(self, server):
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "a cat", "mode": "t2i",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["skipped"] is True

    def test_skip_disabled_t2v(self, server):
        ltx2_server.app_settings["prompt_enhancer_enabled_t2v"] = False
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "a cat", "mode": "t2v",
        })
        assert r.status_code == 200
        assert r.json()["skipped"] is True

    def test_skip_disabled_i2v(self, server):
        # i2v is disabled by default
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "animate", "mode": "i2v",
        })
        assert r.status_code == 200
        assert r.json()["skipped"] is True

    def test_empty_prompt_400(self, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "", "mode": "t2v",
        })
        assert r.status_code == 400

    def test_missing_gemini_key_400(self, server):
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "hello", "mode": "t2v",
        })
        assert r.status_code == 400
        assert r.json()["error"] == "GEMINI_API_KEY_MISSING"

    @patch("ltx2_server.requests.post")
    def test_gemini_api_error_forwarded(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_error(429, "rate limited")

        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 429

    @patch("ltx2_server.requests.post")
    def test_gemini_parse_error(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_empty_candidates()

        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 500
        assert r.json()["error"] == "GEMINI_PARSE_ERROR"

    @patch("ltx2_server.requests.post", side_effect=requests.exceptions.Timeout)
    def test_timeout_504(self, _mock, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 504

    @patch("ltx2_server.requests.post", side_effect=RuntimeError("boom"))
    def test_generic_exception_500(self, _mock, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = _real_post(f"{server}/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 500


# ═════════════════════════════════════════════════════════════════════
# POST /api/suggest-gap-prompt
# ═════════════════════════════════════════════════════════════════════

class TestSuggestGapPrompt:
    """POST /api/suggest-gap-prompt"""

    @patch("ltx2_server.requests.post")
    def test_happy_path_with_prompts(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("A smooth transition scene")

        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "sunset on a beach",
            "afterPrompt": "sunrise over mountains",
            "gapDuration": 3,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "success"
        assert data["suggested_prompt"] == "A smooth transition scene"

    @patch("ltx2_server.requests.post")
    def test_happy_path_with_frames(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("Transition clip")

        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforeFrame": "base64data==",
            "afterFrame": "base64data==",
        })
        assert r.status_code == 200
        # Verify inlineData was sent in the Gemini payload
        call_payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        user_parts = call_payload["contents"][0]["parts"]
        inline_parts = [p for p in user_parts if "inlineData" in p]
        assert len(inline_parts) == 2

    def test_no_context_400(self, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = _real_post(f"{server}/api/suggest-gap-prompt", json={})
        assert r.status_code == 400

    def test_missing_gemini_key_400(self, server):
        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 400
        assert r.json()["error"] == "GEMINI_API_KEY_MISSING"

    @patch("ltx2_server.requests.post")
    def test_gemini_api_error(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_error(500, "internal")

        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 500

    @patch("ltx2_server.requests.post")
    def test_gemini_parse_error(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_empty_candidates()

        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 500
        assert r.json()["error"] == "GEMINI_PARSE_ERROR"

    @patch("ltx2_server.requests.post", side_effect=requests.exceptions.Timeout)
    def test_timeout_504(self, _mock, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 504

    @patch("ltx2_server.requests.post")
    def test_image_edit_mode(self, mock_post, server):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("Edit the background")

        r = _real_post(f"{server}/api/suggest-gap-prompt", json={
            "beforePrompt": "a park",
            "mode": "t2i",
            "inputImage": "base64imagedata==",
        })
        assert r.status_code == 200
        # Verify input image was included in payload
        call_payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        user_parts = call_payload["contents"][0]["parts"]
        inline_parts = [p for p in user_parts if "inlineData" in p]
        assert len(inline_parts) >= 1


# ═════════════════════════════════════════════════════════════════════
# POST /api/upscale
# ═════════════════════════════════════════════════════════════════════

class TestUpscale:
    """POST /api/upscale"""

    @patch("ltx2_server.requests.get")
    @patch("ltx2_server.requests.post")
    def test_happy_path_direct_video(self, mock_post, _mock_get, server):
        """API returns video/mp4 content-type directly."""
        _setup_av_mock(640, 480, 5_000_000)

        video_file = ltx2_server.OUTPUTS_DIR / "test_input.mp4"
        video_file.write_bytes(b"\x00" * 2048)

        # API returns non-JSON video bytes
        api_resp = MagicMock()
        api_resp.status_code = 200
        api_resp.text = "notjson"
        api_resp.json.side_effect = json.JSONDecodeError("", "", 0)
        api_resp.headers = {"Content-Type": "video/mp4"}
        api_resp.content = b"\x00\x00\x00\x1cftypisom" + b"\x00" * 1000
        mock_post.return_value = api_resp

        r = _real_post(f"{server}/api/upscale", json={
            "video_path": str(video_file),
        })
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert "upscaled_path" in data

    def test_missing_video_path(self, server):
        r = _real_post(f"{server}/api/upscale", json={})
        assert r.status_code == 400

    def test_video_not_found(self, server):
        r = _real_post(f"{server}/api/upscale", json={
            "video_path": "/nonexistent/video.mp4",
        })
        assert r.status_code == 400

    @patch("ltx2_server.requests.post")
    def test_api_error_forwarded(self, mock_post, server):
        _setup_av_mock()
        video_file = ltx2_server.OUTPUTS_DIR / "test_input.mp4"
        video_file.write_bytes(b"\x00" * 2048)

        api_resp = MagicMock()
        api_resp.status_code = 500
        api_resp.text = "Internal server error"
        mock_post.return_value = api_resp

        r = _real_post(f"{server}/api/upscale", json={
            "video_path": str(video_file),
        })
        assert r.status_code == 500

    @patch("ltx2_server.requests.post")
    def test_empty_api_response(self, mock_post, server):
        _setup_av_mock()
        video_file = ltx2_server.OUTPUTS_DIR / "test_input.mp4"
        video_file.write_bytes(b"\x00" * 2048)

        api_resp = MagicMock()
        api_resp.status_code = 200
        api_resp.text = ""
        mock_post.return_value = api_resp

        r = _real_post(f"{server}/api/upscale", json={
            "video_path": str(video_file),
        })
        assert r.status_code == 500

    @patch("ltx2_server.requests.post")
    def test_dimensions_doubled(self, mock_post, server):
        """640x480 input -> params should request 1280x960."""
        _setup_av_mock(640, 480, 5_000_000)
        video_file = ltx2_server.OUTPUTS_DIR / "test_input.mp4"
        video_file.write_bytes(b"\x00" * 2048)

        api_resp = MagicMock()
        api_resp.status_code = 200
        api_resp.text = '{"status": "ok"}'
        api_resp.json.return_value = {"status": "ok"}
        api_resp.headers = {"Content-Type": "application/json"}
        mock_post.return_value = api_resp

        _real_post(f"{server}/api/upscale", json={
            "video_path": str(video_file),
        })

        # Inspect the params JSON sent to the API
        call_kwargs = mock_post.call_args
        files_dict = call_kwargs.kwargs.get("files") or call_kwargs[1].get("files")
        params_json = files_dict["params"][1]
        params = json.loads(params_json)
        assert params["width"] == 1280
        assert params["height"] == 960

    @patch("ltx2_server.requests.post", side_effect=RuntimeError("boom"))
    def test_generic_exception_500(self, _mock, server):
        _setup_av_mock()
        video_file = ltx2_server.OUTPUTS_DIR / "test_input.mp4"
        video_file.write_bytes(b"\x00" * 2048)

        r = _real_post(f"{server}/api/upscale", json={
            "video_path": str(video_file),
        })
        assert r.status_code == 500


# ═════════════════════════════════════════════════════════════════════
# POST /api/retake
# ═════════════════════════════════════════════════════════════════════

def _upload_resp_ok():
    """Mock response for step 1: POST /v1/upload."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "upload_url": "https://storage.example.com/upload",
        "storage_uri": "gs://bucket/video.mp4",
        "required_headers": {},
    }
    return resp


def _put_ok():
    """Mock response for step 2: PUT upload."""
    resp = MagicMock()
    resp.status_code = 200
    return resp


def _retake_binary_resp():
    """Mock response for step 3: binary video."""
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"Content-Type": "video/mp4"}
    resp.content = b"\x00\x00\x00\x1cftypisom" + b"\x00" * 500
    return resp


def _retake_json_resp(video_url="https://cdn.example.com/retake.mp4"):
    """Mock response for step 3: JSON with video_url."""
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"Content-Type": "application/json"}
    resp.json.return_value = {"video_url": video_url}
    return resp


class TestRetake:
    """POST /api/retake"""

    def _make_video(self):
        """Create a dummy video file and return its path."""
        video_file = ltx2_server.OUTPUTS_DIR / f"retake_input_{uuid.uuid4().hex[:6]}.mp4"
        video_file.write_bytes(b"\x00" * 2048)
        return str(video_file)

    def _base_payload(self, video_path):
        return {
            "video_path": video_path,
            "start_time": 1.0,
            "duration": 3.0,
            "prompt": "make it dramatic",
        }

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_happy_path_binary_response(self, mock_post, mock_put, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_binary_resp()]
        mock_put.return_value = _put_ok()

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert "video_path" in data

    @patch("ltx2_server.requests.get")
    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_happy_path_json_video_url(self, mock_post, mock_put, mock_get, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_json_resp()]
        mock_put.return_value = _put_ok()

        # Mock the video download
        dl_resp = MagicMock()
        dl_resp.status_code = 200
        dl_resp.content = b"\x00\x00\x00\x1cftypisom" + b"\x00" * 500
        mock_get.return_value = dl_resp

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"

    def test_missing_video_path(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        r = _real_post(f"{server}/api/retake", json={
            "start_time": 1.0, "duration": 3.0,
        })
        assert r.status_code == 400

    def test_missing_start_time(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = _real_post(f"{server}/api/retake", json={
            "video_path": video_path, "duration": 3.0,
        })
        assert r.status_code == 400

    def test_missing_duration(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = _real_post(f"{server}/api/retake", json={
            "video_path": video_path, "start_time": 1.0,
        })
        assert r.status_code == 400

    def test_duration_too_short(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = _real_post(f"{server}/api/retake", json={
            "video_path": video_path, "start_time": 0, "duration": 1,
        })
        assert r.status_code == 400

    def test_video_not_found(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        r = _real_post(f"{server}/api/retake", json={
            "video_path": "/nonexistent/video.mp4",
            "start_time": 0, "duration": 3,
        })
        assert r.status_code == 400

    def test_no_api_key(self, server):
        video_path = self._make_video()
        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 400

    @patch("ltx2_server.requests.post")
    def test_upload_url_failure(self, mock_post, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        fail_resp = MagicMock()
        fail_resp.status_code = 401
        fail_resp.text = "Unauthorized"
        mock_post.return_value = fail_resp

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 401

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_video_upload_failure(self, mock_post, mock_put, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.return_value = _upload_resp_ok()
        fail_put = MagicMock()
        fail_put.status_code = 500
        fail_put.text = "Storage error"
        mock_put.return_value = fail_put

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 500

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_retake_api_422_safety_filter(self, mock_post, mock_put, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        safety_resp = MagicMock()
        safety_resp.status_code = 422
        safety_resp.text = "Content filtered"
        mock_post.side_effect = [_upload_resp_ok(), safety_resp]
        mock_put.return_value = _put_ok()

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 422

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_retake_api_other_error(self, mock_post, mock_put, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        error_resp = MagicMock()
        error_resp.status_code = 503
        error_resp.text = "Service unavailable"
        mock_post.side_effect = [_upload_resp_ok(), error_resp]
        mock_put.return_value = _put_ok()

        r = _real_post(f"{server}/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 503

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_prompt_and_mode_forwarded(self, mock_post, mock_put, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_binary_resp()]
        mock_put.return_value = _put_ok()

        _real_post(f"{server}/api/retake", json={
            "video_path": video_path,
            "start_time": 2.0,
            "duration": 4.0,
            "prompt": "epic explosion",
            "mode": "replace_video_only",
        })

        # The second post call is the retake API call
        retake_call = mock_post.call_args_list[1]
        payload = retake_call.kwargs.get("json") or retake_call[1].get("json")
        assert payload["prompt"] == "epic explosion"
        assert payload["mode"] == "replace_video_only"
