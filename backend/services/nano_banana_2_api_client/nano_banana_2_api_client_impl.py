"""Nano Banana 2 API client implementation for FAL endpoints."""

from __future__ import annotations

import logging
import random
import re
import time
from typing import Any, cast

from services.http_client.http_client import HTTPClient, HttpTimeoutError
from services.services_utils import JSONValue

logger = logging.getLogger(__name__)

FAL_API_BASE_URL = "https://fal.run"
FAL_NB2_TEXT_TO_IMAGE_ENDPOINT = "/fal-ai/nano-banana-2"
FAL_NB2_EDIT_ENDPOINT = "/fal-ai/nano-banana-2/edit"

DEFAULT_OUTPUT_FORMAT = "png"

_RETRYABLE_STATUS_CODES = {429, 502, 503}
_MAX_RETRIES = 2
_BASE_DELAY_SECONDS = 1.0
_STATUS_CODE_PATTERN = re.compile(r"\((\d{3})\)")


class NanoBanana2APIClientImpl:
    def __init__(self, http: HTTPClient, *, fal_api_base_url: str = FAL_API_BASE_URL) -> None:
        self._http = http
        self._base_url = fal_api_base_url.rstrip("/")

    def generate_text_to_image(
        self,
        *,
        api_key: str,
        prompt: str,
        aspect_ratio: str,
        resolution: str,
        seed: int,
    ) -> bytes:
        payload: dict[str, JSONValue] = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "seed": seed,
            "num_images": 1,
            "output_format": DEFAULT_OUTPUT_FORMAT,
            "limit_generations": True,
        }
        return self._submit_and_download(
            endpoint=FAL_NB2_TEXT_TO_IMAGE_ENDPOINT,
            api_key=api_key,
            payload=payload,
        )

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
        image_urls_value: list[JSONValue] = list(image_urls)
        payload: dict[str, JSONValue] = {
            "prompt": prompt,
            "image_urls": image_urls_value,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "seed": seed,
            "num_images": 1,
            "output_format": DEFAULT_OUTPUT_FORMAT,
            "limit_generations": True,
        }
        return self._submit_and_download(
            endpoint=FAL_NB2_EDIT_ENDPOINT,
            api_key=api_key,
            payload=payload,
        )

    def _submit_and_download(
        self,
        *,
        endpoint: str,
        api_key: str,
        payload: dict[str, JSONValue],
    ) -> bytes:
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                return self._do_submit_and_download(
                    endpoint=endpoint, api_key=api_key, payload=payload,
                )
            except RuntimeError as exc:
                if not self._is_retryable(exc):
                    raise
                last_exc = exc
            except HttpTimeoutError as exc:
                last_exc = exc

            delay = _BASE_DELAY_SECONDS * (2 ** attempt) + random.uniform(0, 0.5)
            logger.warning(
                "FAL request failed, retry %d/%d after %.1fs: %s",
                attempt + 1, _MAX_RETRIES, delay, last_exc,
            )
            time.sleep(delay)

        assert last_exc is not None
        raise last_exc

    def _do_submit_and_download(
        self,
        *,
        endpoint: str,
        api_key: str,
        payload: dict[str, JSONValue],
    ) -> bytes:
        response = self._http.post(
            f"{self._base_url}{endpoint}",
            headers=self._json_headers(api_key),
            json_payload=payload,
            timeout=180,
        )
        if response.status_code != 200:
            detail = response.text[:500] if response.text else "Unknown error"
            raise RuntimeError(f"FAL submit failed ({response.status_code}): {detail}")

        response_payload = self._json_object(response.json(), context="submit")
        image_url = self._extract_image_url(response_payload)

        download = self._http.get(image_url, timeout=120)
        if download.status_code != 200:
            detail = download.text[:500] if download.text else "Unknown error"
            raise RuntimeError(f"FAL image download failed ({download.status_code}): {detail}")
        if not download.content:
            raise RuntimeError("FAL image download returned empty body")
        return download.content

    @staticmethod
    def _is_retryable(exc: RuntimeError) -> bool:
        match = _STATUS_CODE_PATTERN.search(str(exc))
        if not match:
            return False
        return int(match.group(1)) in _RETRYABLE_STATUS_CODES

    @staticmethod
    def _json_headers(api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Key {api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _extract_image_url(payload: dict[str, Any]) -> str:
        images = payload.get("images")
        if isinstance(images, list) and images:
            images_list = cast(list[object], images)
            first = images_list[0]
            if isinstance(first, dict):
                first_payload = cast(dict[str, Any], first)
                url = first_payload.get("url")
                if isinstance(url, str) and url:
                    return url
            if isinstance(first, str) and first:
                return first

        for key in ("image_url", "imageUrl", "url"):
            url = payload.get(key)
            if isinstance(url, str) and url:
                return url

        raise RuntimeError("FAL response missing image url")

    @staticmethod
    def _json_object(payload: object, *, context: str) -> dict[str, Any]:
        if isinstance(payload, dict):
            return cast(dict[str, Any], payload)
        raise RuntimeError(f"Unexpected FAL {context} response format")
