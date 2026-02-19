"""Tests for /api/enhance-prompt, /api/suggest-gap-prompt, /api/retake."""
import json
import uuid
from unittest.mock import MagicMock, patch

import requests

import ltx2_server


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


# ═════════════════════════════════════════════════════════════════════
# POST /api/enhance-prompt
# ═════════════════════════════════════════════════════════════════════

class TestEnhancePrompt:
    """POST /api/enhance-prompt"""

    @patch("ltx2_server.requests.post")
    def test_happy_path_t2v(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "test-key"
        mock_post.return_value = _gemini_ok("A beautiful cinematic sunset")

        r = client.post("/api/enhance-prompt", json={
            "prompt": "sunset", "mode": "t2v",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["enhanced_prompt"] == "A beautiful cinematic sunset"
        assert data.get("skipped") is None

    @patch("ltx2_server.requests.post")
    def test_happy_path_i2v(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "test-key"
        ltx2_server.app_settings["prompt_enhancer_enabled_i2v"] = True
        mock_post.return_value = _gemini_ok("Animated image")

        r = client.post("/api/enhance-prompt", json={
            "prompt": "animate it", "mode": "i2v",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["enhanced_prompt"] == "Animated image"
        # Verify i2v system prompt was used in the Gemini call
        call_payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        sys_text = call_payload["systemInstruction"]["parts"][0]["text"]
        assert sys_text == ltx2_server.app_settings["i2v_system_prompt"]

    def test_skip_t2i_mode(self, client):
        r = client.post("/api/enhance-prompt", json={
            "prompt": "a cat", "mode": "t2i",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["skipped"] is True

    def test_skip_disabled_t2v(self, client):
        ltx2_server.app_settings["prompt_enhancer_enabled_t2v"] = False
        r = client.post("/api/enhance-prompt", json={
            "prompt": "a cat", "mode": "t2v",
        })
        assert r.status_code == 200
        assert r.json()["skipped"] is True

    def test_skip_disabled_i2v(self, client):
        # i2v is disabled by default
        r = client.post("/api/enhance-prompt", json={
            "prompt": "animate", "mode": "i2v",
        })
        assert r.status_code == 200
        assert r.json()["skipped"] is True

    def test_empty_prompt_400(self, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = client.post("/api/enhance-prompt", json={
            "prompt": "", "mode": "t2v",
        })
        assert r.status_code == 400

    def test_missing_gemini_key_400(self, client):
        r = client.post("/api/enhance-prompt", json={
            "prompt": "hello", "mode": "t2v",
        })
        assert r.status_code == 400
        assert r.json()["error"] == "GEMINI_API_KEY_MISSING"

    @patch("ltx2_server.requests.post")
    def test_gemini_api_error_forwarded(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_error(429, "rate limited")

        r = client.post("/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 429

    @patch("ltx2_server.requests.post")
    def test_gemini_parse_error(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_empty_candidates()

        r = client.post("/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 500
        assert r.json()["error"] == "GEMINI_PARSE_ERROR"

    @patch("ltx2_server.requests.post", side_effect=requests.exceptions.Timeout)
    def test_timeout_504(self, _mock, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = client.post("/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 504

    @patch("ltx2_server.requests.post", side_effect=RuntimeError("boom"))
    def test_generic_exception_500(self, _mock, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = client.post("/api/enhance-prompt", json={
            "prompt": "test", "mode": "t2v",
        })
        assert r.status_code == 500


# ═════════════════════════════════════════════════════════════════════
# POST /api/suggest-gap-prompt
# ═════════════════════════════════════════════════════════════════════

class TestSuggestGapPrompt:
    """POST /api/suggest-gap-prompt"""

    @patch("ltx2_server.requests.post")
    def test_happy_path_with_prompts(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("A smooth transition scene")

        r = client.post("/api/suggest-gap-prompt", json={
            "beforePrompt": "sunset on a beach",
            "afterPrompt": "sunrise over mountains",
            "gapDuration": 3,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "success"
        assert data["suggested_prompt"] == "A smooth transition scene"

    @patch("ltx2_server.requests.post")
    def test_happy_path_with_frames(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("Transition clip")

        r = client.post("/api/suggest-gap-prompt", json={
            "beforeFrame": "base64data==",
            "afterFrame": "base64data==",
        })
        assert r.status_code == 200
        # Verify inlineData was sent in the Gemini payload
        call_payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        user_parts = call_payload["contents"][0]["parts"]
        inline_parts = [p for p in user_parts if "inlineData" in p]
        assert len(inline_parts) == 2

    def test_no_context_400(self, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = client.post("/api/suggest-gap-prompt", json={})
        assert r.status_code == 400

    def test_missing_gemini_key_400(self, client):
        r = client.post("/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 400
        assert r.json()["error"] == "GEMINI_API_KEY_MISSING"

    @patch("ltx2_server.requests.post")
    def test_gemini_api_error(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_error(500, "internal")

        r = client.post("/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 500

    @patch("ltx2_server.requests.post")
    def test_gemini_parse_error(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_empty_candidates()

        r = client.post("/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 500
        assert r.json()["error"] == "GEMINI_PARSE_ERROR"

    @patch("ltx2_server.requests.post", side_effect=requests.exceptions.Timeout)
    def test_timeout_504(self, _mock, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        r = client.post("/api/suggest-gap-prompt", json={
            "beforePrompt": "test",
        })
        assert r.status_code == 504

    @patch("ltx2_server.requests.post")
    def test_image_edit_mode(self, mock_post, client):
        ltx2_server.app_settings["gemini_api_key"] = "key"
        mock_post.return_value = _gemini_ok("Edit the background")

        r = client.post("/api/suggest-gap-prompt", json={
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
    def test_happy_path_binary_response(self, mock_post, mock_put, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_binary_resp()]
        mock_put.return_value = _put_ok()

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"
        assert "video_path" in data

    @patch("ltx2_server.requests.get")
    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_happy_path_json_video_url(self, mock_post, mock_put, mock_get, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_json_resp()]
        mock_put.return_value = _put_ok()

        # Mock the video download
        dl_resp = MagicMock()
        dl_resp.status_code = 200
        dl_resp.content = b"\x00\x00\x00\x1cftypisom" + b"\x00" * 500
        mock_get.return_value = dl_resp

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "complete"

    def test_missing_video_path(self, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        r = client.post("/api/retake", json={
            "start_time": 1.0, "duration": 3.0,
        })
        assert r.status_code == 422

    def test_missing_start_time(self, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = client.post("/api/retake", json={
            "video_path": video_path, "duration": 3.0,
        })
        assert r.status_code == 422

    def test_missing_duration(self, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = client.post("/api/retake", json={
            "video_path": video_path, "start_time": 1.0,
        })
        assert r.status_code == 422

    def test_duration_too_short(self, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()
        r = client.post("/api/retake", json={
            "video_path": video_path, "start_time": 0, "duration": 1,
        })
        assert r.status_code == 400

    def test_video_not_found(self, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        r = client.post("/api/retake", json={
            "video_path": "/nonexistent/video.mp4",
            "start_time": 0, "duration": 3,
        })
        assert r.status_code == 400

    def test_no_api_key(self, client):
        video_path = self._make_video()
        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 400

    @patch("ltx2_server.requests.post")
    def test_upload_url_failure(self, mock_post, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        fail_resp = MagicMock()
        fail_resp.status_code = 401
        fail_resp.text = "Unauthorized"
        mock_post.return_value = fail_resp

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 401

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_video_upload_failure(self, mock_post, mock_put, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.return_value = _upload_resp_ok()
        fail_put = MagicMock()
        fail_put.status_code = 500
        fail_put.text = "Storage error"
        mock_put.return_value = fail_put

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 500

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_retake_api_422_safety_filter(self, mock_post, mock_put, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        safety_resp = MagicMock()
        safety_resp.status_code = 422
        safety_resp.text = "Content filtered"
        mock_post.side_effect = [_upload_resp_ok(), safety_resp]
        mock_put.return_value = _put_ok()

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 422

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_retake_api_other_error(self, mock_post, mock_put, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        error_resp = MagicMock()
        error_resp.status_code = 503
        error_resp.text = "Service unavailable"
        mock_post.side_effect = [_upload_resp_ok(), error_resp]
        mock_put.return_value = _put_ok()

        r = client.post("/api/retake", json=self._base_payload(video_path))
        assert r.status_code == 503

    @patch("ltx2_server.requests.put")
    @patch("ltx2_server.requests.post")
    def test_prompt_and_mode_forwarded(self, mock_post, mock_put, client):
        ltx2_server.app_settings["ltx_api_key"] = "test-key"
        video_path = self._make_video()

        mock_post.side_effect = [_upload_resp_ok(), _retake_binary_resp()]
        mock_put.return_value = _put_ok()

        client.post("/api/retake", json={
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
