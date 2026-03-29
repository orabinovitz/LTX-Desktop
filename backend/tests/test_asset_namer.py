"""Tests for non-blocking asset naming retries."""

from __future__ import annotations

import json

from agent import asset_namer
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _asset_namer_response(name: str = "Crash Survivors", tags: list[str] | None = None) -> FakeResponse:
    payload = {
        "name": name,
        "tags": tags or ["crash", "beach"],
    }
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [
                {
                    "content": {
                        "parts": [{"text": json.dumps(payload)}],
                    },
                },
            ],
        },
    )


def test_suggest_asset_meta_retries_once_on_503_then_succeeds(monkeypatch) -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(status_code=503, text="provider busy"),
        _asset_namer_response(),
    )
    monkeypatch.setattr(asset_namer, "_SOFT_PROVIDER_RETRY_DELAYS", (0.0,))

    result = asset_namer.suggest_asset_meta(
        prompt="Survivors emerge from wreckage on a beach",
        asset_type="video",
        existing_tags=[],
        gemini_api_key="test-key",
        http_client=http,
    )

    assert result is not None
    assert result.name == "Crash Survivors"
    assert result.tags == ["crash", "beach"]
    assert len(http.calls) == 2


def test_suggest_asset_meta_returns_none_after_retryable_provider_exhaustion(monkeypatch) -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(status_code=503, text="provider busy"),
        FakeResponse(status_code=503, text="provider still busy"),
    )
    monkeypatch.setattr(asset_namer, "_SOFT_PROVIDER_RETRY_DELAYS", (0.0,))

    result = asset_namer.suggest_asset_meta(
        prompt="Survivors emerge from wreckage on a beach",
        asset_type="video",
        existing_tags=[],
        gemini_api_key="test-key",
        http_client=http,
    )

    assert result is None
    assert len(http.calls) == 2
