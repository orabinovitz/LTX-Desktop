"""HTTP client wrapper service."""

from __future__ import annotations

import logging
from collections.abc import Mapping

import requests

from services.http_client.http_client import HttpConnectionError, HttpTimeoutError
from services.services_utils import JSONValue, RequestData

logger = logging.getLogger(__name__)


class HTTPClientImpl:
    """Wraps requests.* for external API calls."""

    def post(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        json_payload: Mapping[str, JSONValue] | None = None,
        data: RequestData = None,
        timeout: int = 30,
    ) -> requests.Response:
        try:
            return requests.post(url, headers=headers, json=json_payload, data=data, timeout=timeout)
        except requests.exceptions.Timeout as exc:
            logger.error("HTTP POST timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except requests.exceptions.ConnectionError as exc:
            logger.error("HTTP POST connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except requests.exceptions.RequestException as exc:
            logger.error("HTTP POST failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc

    def get(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        timeout: int = 30,
    ) -> requests.Response:
        try:
            return requests.get(url, headers=headers, timeout=timeout)
        except requests.exceptions.Timeout as exc:
            logger.error("HTTP GET timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except requests.exceptions.ConnectionError as exc:
            logger.error("HTTP GET connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except requests.exceptions.RequestException as exc:
            logger.error("HTTP GET failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc

    def put(
        self,
        url: str,
        data: RequestData = None,
        headers: dict[str, str] | None = None,
        timeout: int = 300,
    ) -> requests.Response:
        try:
            return requests.put(url, data=data, headers=headers, timeout=timeout)
        except requests.exceptions.Timeout as exc:
            logger.error("HTTP PUT timed out: %s", url)
            raise HttpTimeoutError(str(exc)) from exc
        except requests.exceptions.ConnectionError as exc:
            logger.error("HTTP PUT connection failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
        except requests.exceptions.RequestException as exc:
            logger.error("HTTP PUT failed: %s (%s)", url, type(exc).__name__)
            raise HttpConnectionError(str(exc)) from exc
