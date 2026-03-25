"""Tests for Gemini upload retry behavior in the video analyzer."""

from __future__ import annotations

import pytest

from agent.video_analyzer import _do_upload
from services.http_client.http_client import HttpConnectionError, HttpTimeoutError
from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_do_upload_retries_with_fresh_resumable_session_after_transport_failure(tmp_path) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")

    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-1"},
        ),
        HttpConnectionError("stream reset"),
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-2"},
        ),
        FakeResponse(
            status_code=200,
            json_payload={"file": {"uri": "gs://files/video", "name": "files/abc123"}},
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"state": "ACTIVE"}))

    file_uri = _do_upload(
        upload_path=str(video_path),
        original_path=str(video_path),
        gemini_api_key="test-key",
        http_client=http,
    )

    assert file_uri == "gs://files/video"
    assert [call.method for call in http.calls] == ["post", "post", "post", "post", "get"]
    assert http.calls[0].url == "https://generativelanguage.googleapis.com/upload/v1beta/files"
    assert http.calls[1].url == "https://upload.example.com/session-1"
    assert http.calls[2].url == "https://generativelanguage.googleapis.com/upload/v1beta/files"
    assert http.calls[3].url == "https://upload.example.com/session-2"
    assert http.calls[1].data is not http.calls[3].data


def test_do_upload_retries_with_fresh_resumable_session_after_timeout(tmp_path) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")

    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-1"},
        ),
        HttpTimeoutError("timed out"),
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-2"},
        ),
        FakeResponse(
            status_code=200,
            json_payload={"file": {"uri": "gs://files/video", "name": "files/abc123"}},
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"state": "ACTIVE"}))

    file_uri = _do_upload(
        upload_path=str(video_path),
        original_path=str(video_path),
        gemini_api_key="test-key",
        http_client=http,
    )

    assert file_uri == "gs://files/video"
    assert [call.method for call in http.calls] == ["post", "post", "post", "post", "get"]


def test_do_upload_failure_message_includes_transport_category(tmp_path) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")

    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-1"},
        ),
        HttpConnectionError("stream reset"),
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-2"},
        ),
        HttpConnectionError("stream reset"),
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-3"},
        ),
        HttpConnectionError("stream reset"),
    )

    with pytest.raises(RuntimeError) as exc_info:
        _do_upload(
            upload_path=str(video_path),
            original_path=str(video_path),
            gemini_api_key="test-key",
            http_client=http,
        )

    assert "category=transport_session_restart" in str(exc_info.value)
