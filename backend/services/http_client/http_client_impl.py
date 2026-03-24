"""HTTP client wrapper service using httpx with connection pooling."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping
from typing import Any

import httpx

from services.http_client.http_client import HttpConnectionError, HttpTimeoutError
from services.services_utils import JSONValue, RequestData


logger = logging.getLogger(__name__)

_MAX_RETRIES = 2
_RETRY_BACKOFF_SECONDS = (1.0, 2.0)

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

    Transient connection errors (EAGAIN, ConnectionTerminated) are retried
    up to _MAX_RETRIES times with exponential backoff before propagating.
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

    @staticmethod
    def _is_replayable_data(data: RequestData) -> bool:
        """Return whether a request body can be sent again safely.

        Raw bytes/strings and form mappings can be replayed because they live in
        memory. Open file handles and other streaming bodies cannot be assumed
        seekable after a transport failure, so callers must rebuild those
        requests explicitly.
        """
        return data is None or isinstance(data, bytes | str | Mapping)

    def _with_retry(
        self,
        method: str,
        url: str,
        fn: Callable[[], httpx.Response],
        *,
        can_retry: bool,
    ) -> _HttpxResponseAdapter:
        last_exc: httpx.HTTPError | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                return _HttpxResponseAdapter(fn())
            except httpx.TimeoutException as exc:
                logger.error("HTTP %s timed out: %s", method, url)
                raise HttpTimeoutError(str(exc)) from exc
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES and can_retry:
                    delay = _RETRY_BACKOFF_SECONDS[attempt]
                    logger.warning(
                        "HTTP %s transient error on %s (attempt %d/%d, retrying in %.1fs): %s",
                        method, url, attempt + 1, _MAX_RETRIES + 1, delay, exc,
                    )
                    time.sleep(delay)
                    continue
                if attempt == 0 and not can_retry:
                    logger.error(
                        "HTTP %s %s failed on a non-replayable request body: %s",
                        method, url, exc,
                    )
                    break
                else:
                    logger.error("HTTP %s %s failed after %d attempts: %s", method, url, attempt + 1, exc)
            except httpx.HTTPError as exc:
                logger.error("HTTP %s failed: %s (%s)", method, url, type(exc).__name__)
                raise HttpConnectionError(str(exc)) from exc

        raise HttpConnectionError(str(last_exc)) from last_exc

    def post(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        json_payload: Mapping[str, JSONValue] | None = None,
        data: RequestData = None,
        timeout: int = 30,
    ) -> _HttpxResponseAdapter:
        content, form_data = self._split_data(data)
        return self._with_retry("POST", url, lambda: self._client.post(
            url,
            headers=headers,
            json=dict(json_payload) if json_payload is not None else None,
            content=content,
            data=form_data,
            timeout=float(timeout),
        ), can_retry=self._is_replayable_data(data))

    def get(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        timeout: int = 30,
    ) -> _HttpxResponseAdapter:
        return self._with_retry("GET", url, lambda: self._client.get(
            url, headers=headers, timeout=float(timeout),
        ), can_retry=True)

    def put(
        self,
        url: str,
        data: RequestData = None,
        headers: dict[str, str] | None = None,
        timeout: int = 300,
    ) -> _HttpxResponseAdapter:
        content, form_data = self._split_data(data)
        return self._with_retry("PUT", url, lambda: self._client.put(
            url, content=content, data=form_data, headers=headers, timeout=float(timeout),
        ), can_retry=self._is_replayable_data(data))
