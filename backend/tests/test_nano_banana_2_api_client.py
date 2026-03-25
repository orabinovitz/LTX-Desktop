from __future__ import annotations

from services.http_client.http_client import HttpConnectionError
from services.nano_banana_2_api_client.nano_banana_2_api_client_impl import NanoBanana2APIClientImpl
from tests.fakes.services import FakeHTTPClient, FakeResponse


def test_edit_images_retries_connection_failures() -> None:
    http = FakeHTTPClient()
    http.queue(
        "post",
        HttpConnectionError("Resource temporarily unavailable"),
        FakeResponse(
            status_code=200,
            json_payload={"images": [{"url": "https://cdn.example.com/nb2.png"}]},
        ),
    )
    http.queue(
        "get",
        FakeResponse(status_code=200, content=b"image-bytes"),
    )

    client = NanoBanana2APIClientImpl(http=http)
    output = client.edit_images(
        api_key="test-key",
        prompt="Stormy beach survivors",
        image_urls=["data:image/png;base64,abc123"],
        aspect_ratio="16:9",
        resolution="1K",
        seed=123,
    )

    assert output == b"image-bytes"
    assert len(http.calls) == 3
