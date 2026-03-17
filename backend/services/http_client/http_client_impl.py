"""HTTP client wrapper service using httpx with connection pooling."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import httpx

from services.http_client.http_client import HttpConnectionError, HttpTimeoutError
from services.services_utils import JSONValue, RequestData


logger = logging.getLogger(__name__)


class _HttpxResponseAdapter:
    """Thin adapter so httpx.Response satisfies the HttpResponseLike protocol."""

    __slots__ = ("_resp",)

    def __init__(self, resp: httpx.Response) -> None:
        self._resp = resp

    @property
    def status_code(self) -> int:
        return self._resp.status_code

    @property
    def text(self) -> str:
        return self._resp.text

    @property
    def headers(self) -> Mapping[str, str]:
        return self._resp.headers

    @property
    def content(self) -> bytes:
        return self._resp.content

    def json(self) -> Any:
        return self._resp.json()


class HTTPClientImpl:
    """Wraps httpx.Client for external API calls with connection pooling.

    httpx provides HTTP/2 support and persistent connection pooling out of
    the box, reducing TCP+TLS handshake overhead across repeated calls to
    the same host (e.g. Gemini API).
    """

    def __init__(self) -> None:
        self._client = httpx.Client(
            http2=True,
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
                keepalive_expiry=120,
            ),
            follow_redirects=True,
        )

    @staticmethod
    def _split_data(data: RequestData) -> tuple[Any, Any]:
        """Split RequestData into (content, data) kwargs for httpx.

        Mapping values go to ``data=`` (form encoding), everything else
        (bytes, str, file-like) goes to ``content=`` (raw body).
        """
        if data is None:
            return None, None
        if isinstance(data, Mapping):
            return None, dict(data)
        return data, None

    def post(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        json_payload: Mapping[str, JSONValue] | None = None,
        data: RequestData = None,
        timeout: int = 30,
    ) -> _HttpxResponseAdapter:
        content, form_data = self._split_data(data)
        try:
            resp = self._client.post(
                url,
                headers=headers,
                json=dict(json_payload) if json_payload is not None else None,
                content=content,
                data=form_data,
                timeout=float(timeout),
            )
            return _HttpxResponseAdapter(resp)
        except httpx.TimeoutException as exc:
            logger.error("HTTP POST timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except httpx.ConnectError as exc:
            logger.error("HTTP POST connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except httpx.HTTPError as exc:
            logger.error("HTTP POST failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc

    def get(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        timeout: int = 30,
    ) -> _HttpxResponseAdapter:
        try:
            resp = self._client.get(url, headers=headers, timeout=float(timeout))
            return _HttpxResponseAdapter(resp)
        except httpx.TimeoutException as exc:
            logger.error("HTTP GET timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except httpx.ConnectError as exc:
            logger.error("HTTP GET connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except httpx.HTTPError as exc:
            logger.error("HTTP GET failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc

    def put(
        self,
        url: str,
        data: RequestData = None,
        headers: dict[str, str] | None = None,
        timeout: int = 300,
    ) -> _HttpxResponseAdapter:
        content, form_data = self._split_data(data)
        try:
            resp = self._client.put(url, content=content, data=form_data, headers=headers, timeout=float(timeout))
            return _HttpxResponseAdapter(resp)
        except httpx.TimeoutException as exc:
            logger.error("HTTP PUT timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except httpx.ConnectError as exc:
            logger.error("HTTP PUT connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except httpx.HTTPError as exc:
            logger.error("HTTP PUT failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
