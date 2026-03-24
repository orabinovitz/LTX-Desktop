"""Tests for timing support in FakeHTTPClient."""

from __future__ import annotations

from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_fake_http_client_records_elapsed_time_for_delayed_response() -> None:
    http = FakeHTTPClient()
    http.queue("post", FakeResponse(status_code=200, delay_ms=15))

    response = http.post("https://example.test")

    assert response.status_code == 200
    assert len(http.calls) == 1
    call = http.calls[0]
    assert call.started_at_ms is not None
    assert call.completed_at_ms is not None
    assert call.elapsed_ms is not None
    assert call.elapsed_ms >= 10
