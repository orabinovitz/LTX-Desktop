"""Tests for Gemini upload retry behavior in the video analyzer."""

from __future__ import annotations

import pytest

from agent import video_analyzer
from agent.types import AnalysisStatus, VideoMetadata
from agent.video_analyzer import _do_upload
from services.http_client.http_client import HttpConnectionError, HttpTimeoutError
from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_do_upload_retries_with_fresh_resumable_session_after_transport_failure(tmp_path, monkeypatch) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")
    monkeypatch.setattr(video_analyzer, "_REPLAYABLE_UPLOAD_MAX_BYTES", 0)

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


def test_do_upload_buffers_small_files_for_replayable_uploads(tmp_path, monkeypatch) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")
    monkeypatch.setattr(video_analyzer, "_REPLAYABLE_UPLOAD_MAX_BYTES", 1024)

    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            headers={"X-Goog-Upload-URL": "https://upload.example.com/session-1"},
        ),
        FakeResponse(
            status_code=200,
            json_payload={"file": {"uri": "gs://files/video", "name": "files/abc123"}},
        ),
    )
    http.queue("get", FakeResponse(status_code=200, json_payload={"state": "ACTIVE"}))

    _do_upload(
        upload_path=str(video_path),
        original_path=str(video_path),
        gemini_api_key="test-key",
        http_client=http,
    )

    assert isinstance(http.calls[1].data, bytes)
    assert http.calls[1].data == b"video-bytes"


def test_run_analysis_records_failure_details_in_metadata(tmp_path, monkeypatch) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"video-bytes")
    asset_id = "asset-1"

    def _raise_upload_failure(*_args, **_kwargs) -> None:
        raise RuntimeError("upload blew up")

    callbacks: list[tuple[str, VideoMetadata | None]] = []

    def _capture_callback(cb_asset_id: str, cb_metadata: VideoMetadata | None) -> None:
        callbacks.append((cb_asset_id, cb_metadata))

    monkeypatch.setattr(video_analyzer, "_on_analysis_complete_callbacks", [_capture_callback])
    monkeypatch.setattr(
        video_analyzer,
        "get_structural_metadata",
        lambda _file_path: {"duration": 1.0, "resolution": (1920, 1080), "fps": 24.0},
    )
    monkeypatch.setattr(video_analyzer, "_LONG_VIDEO_THRESHOLD_SECONDS", 999)
    monkeypatch.setattr(video_analyzer, "_run_singlepass_analysis", _raise_upload_failure)

    with video_analyzer._cache_lock:
        video_analyzer._cache_put(
            asset_id,
            VideoMetadata(
                asset_id=asset_id,
                duration=0.0,
                resolution=(0, 0),
                fps=0.0,
                analysis_status=AnalysisStatus.PENDING,
            ),
        )

    video_analyzer._run_analysis(
        asset_id=asset_id,
        file_path=str(video_path),
        gemini_api_key="test-key",
        http_client=FakeHTTPClient(),
    )

    metadata = video_analyzer.get_metadata(asset_id)
    assert metadata is not None
    assert metadata.analysis_status == AnalysisStatus.FAILED
    assert metadata.analysis_error == "upload blew up"
    assert callbacks == [(asset_id, metadata)]
