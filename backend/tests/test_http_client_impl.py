"""Unit tests for HTTP client retry behavior."""

from __future__ import annotations

import httpx
import pytest

from services.http_client.http_client import HttpConnectionError
from services.http_client.http_client_impl import HTTPClientImpl


def _make_client(handler: httpx.MockTransport) -> HTTPClientImpl:
    client = HTTPClientImpl(http2=False)
    client._client.close()
    client._client = httpx.Client(transport=handler)
    return client


def test_put_does_not_retry_streaming_file_body_after_transport_error(tmp_path) -> None:
    payload_path = tmp_path / "upload.bin"
    payload_path.write_bytes(b"payload")
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.RemoteProtocolError("stream reset")

    client = _make_client(httpx.MockTransport(handler))
    try:
        with open(payload_path, "rb") as file_handle:
            with pytest.raises(HttpConnectionError, match="stream reset"):
                client.put("https://example.test/upload", data=file_handle)
    finally:
        client._client.close()

    assert attempts == 1


def test_post_retries_replayable_in_memory_body_after_transport_error() -> None:
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.RemoteProtocolError("stream reset")
        return httpx.Response(status_code=200, json={"ok": True})

    client = _make_client(httpx.MockTransport(handler))
    try:
        response = client.post("https://example.test/upload", data=b"payload")
    finally:
        client._client.close()

    assert response.status_code == 200
    assert attempts == 3


def test_post_retries_write_error_for_replayable_in_memory_body() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.WriteError("Resource temporarily unavailable", request=request)
        return httpx.Response(status_code=200, json={"ok": True})

    client = _make_client(httpx.MockTransport(handler))
    try:
        response = client.post("https://example.test/upload", data=b"payload")
    finally:
        client._client.close()

    assert response.status_code == 200
    assert attempts == 3


def test_post_does_not_retry_streaming_file_body_after_transport_error(tmp_path) -> None:
    payload_path = tmp_path / "upload.bin"
    payload_path.write_bytes(b"payload")
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.RemoteProtocolError("stream reset")

    client = _make_client(httpx.MockTransport(handler))
    try:
        with open(payload_path, "rb") as file_handle:
            with pytest.raises(HttpConnectionError, match="stream reset"):
                client.post("https://example.test/upload", data=file_handle)
    finally:
        client._client.close()

    assert attempts == 1
