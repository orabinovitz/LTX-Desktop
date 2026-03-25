"""Tests for Z-Image Turbo retry behavior."""

from __future__ import annotations

import pytest

from services.zit_api_client.zit_api_client_impl import ZitAPIClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_generate_text_to_image_retries_download_503_with_fresh_submit() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={"images": [{"url": "https://cdn.example.com/zit-first.png"}]},
        ),
        FakeResponse(
            status_code=200,
            json_payload={"images": [{"url": "https://cdn.example.com/zit-second.png"}]},
        ),
    )
    http.queue(
        "get",
        FakeResponse(status_code=503, text="provider busy"),
        FakeResponse(status_code=200, content=b"image-bytes"),
    )

    client = ZitAPIClientImpl(http=http)
    output = client.generate_text_to_image(
        api_key="test-key",
        prompt="Stormy beach survivors",
        width=1920,
        height=1080,
        seed=123,
        num_inference_steps=8,
    )

    assert output == b"image-bytes"
    assert [call.method for call in http.calls] == ["post", "get", "post", "get"]


def test_generate_text_to_image_exposes_fal_download_category() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        FakeResponse(
            status_code=200,
            json_payload={"images": [{"url": "https://cdn.example.com/zit.png"}]},
        ),
    )
    http.queue("get", FakeResponse(status_code=404, text="missing"))

    client = ZitAPIClientImpl(http=http)

    with pytest.raises(RuntimeError, match="category=fal_download_status"):
        client.generate_text_to_image(
            api_key="test-key",
            prompt="Stormy beach survivors",
            width=1920,
            height=1080,
            seed=123,
            num_inference_steps=8,
        )
