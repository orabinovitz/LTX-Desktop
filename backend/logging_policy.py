"""Centralized logging policy for request and background exception paths."""

from __future__ import annotations

import logging

from fastapi import Request
from fastapi.exceptions import RequestValidationError

from _routes._errors import HTTPError
from log_context import log_extra, request_context_from_request

logger = logging.getLogger(__name__)


def log_http_error(request: Request, exc: HTTPError) -> None:
    """Log typed HTTP errors with policy-based traceback behavior."""
    request_id, trace_id = request_context_from_request(request)
    if 500 <= exc.status_code <= 599:
        logger.error(
            "HTTP error on %s %s: [%s] %s",
            request.method,
            request.url.path,
            exc.status_code,
            exc.detail,
            exc_info=(type(exc), exc, exc.__traceback__),
            extra=log_extra(
                category="http.error",
                request_id=request_id,
                trace_id=trace_id,
                status_code=exc.status_code,
            ),
        )
        return

    logger.warning(
        "HTTP error on %s %s: [%s] %s",
        request.method,
        request.url.path,
        exc.status_code,
        exc.detail,
        extra=log_extra(
            category="http.error",
            request_id=request_id,
            trace_id=trace_id,
            status_code=exc.status_code,
        ),
    )


def log_unhandled_exception(request: Request, exc: Exception) -> None:
    """Log unhandled request exceptions with full traceback."""
    request_id, trace_id = request_context_from_request(request)
    logger.error(
        "Unhandled error on %s %s",
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
        extra=log_extra(
            category="http.unhandled",
            request_id=request_id,
            trace_id=trace_id,
            status_code=500,
        ),
    )


def log_validation_error(request: Request, exc: RequestValidationError) -> None:
    """Log request validation failures without a traceback."""
    request_id, trace_id = request_context_from_request(request)
    logger.warning(
        "Request validation error on %s %s: %d issue(s)",
        request.method,
        request.url.path,
        len(exc.errors()),
        extra=log_extra(
            category="http.validation",
            request_id=request_id,
            trace_id=trace_id,
            status_code=422,
        ),
    )


def log_background_exception(task_name: str, exc: Exception) -> None:
    """Log unhandled background task exceptions with full traceback."""
    logger.error(
        "Unhandled background error in task '%s'",
        task_name,
        exc_info=(type(exc), exc, exc.__traceback__),
        extra=log_extra(category="background.error"),
    )
