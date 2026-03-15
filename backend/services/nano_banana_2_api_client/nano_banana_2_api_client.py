"""Nano Banana 2 API client protocol for FAL endpoints."""

from __future__ import annotations

from typing import Protocol


class NanoBanana2APIClient(Protocol):
    def generate_text_to_image(
        self,
        *,
        api_key: str,
        prompt: str,
        aspect_ratio: str,
        resolution: str,
        seed: int,
    ) -> bytes:
        ...

    def edit_images(
        self,
        *,
        api_key: str,
        prompt: str,
        image_urls: list[str],
        aspect_ratio: str,
        resolution: str,
        seed: int,
    ) -> bytes:
        ...
