"""Centralized logging policy for request and background exception paths."""

from __future__ import annotations

import logging

from fastapi import Request

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)


def _request_id(request: Request) -> str:
    return request.headers.get("x-request-id", "-")


def log_http_error(request: Request, exc: HTTPError) -> None:
    """Log typed HTTP errors with policy-based traceback behavior."""
    rid = _request_id(request)
    if 500 <= exc.status_code <= 599:
        logger.error(
            "HTTP error on %s %s [rid=%s]: [%s] %s",
            request.method,
            request.url.path,
            rid,
            exc.status_code,
            exc.detail,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return

    logger.warning(
        "HTTP error on %s %s [rid=%s]: [%s] %s",
        request.method,
        request.url.path,
        rid,
        exc.status_code,
        exc.detail,
    )


def log_unhandled_exception(request: Request, exc: Exception) -> None:
    """Log unhandled request exceptions with full traceback."""
    rid = _request_id(request)
    logger.error(
        "Unhandled error on %s %s [rid=%s]",
        request.method,
        request.url.path,
        rid,
        exc_info=(type(exc), exc, exc.__traceback__),
    )


def log_background_exception(task_name: str, exc: Exception) -> None:
    """Log unhandled background task exceptions with full traceback."""
    logger.error(
        "Unhandled background error in task '%s'",
        task_name,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
