"""Shared logging context and formatting helpers for backend logs."""

from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar, Token
from typing import Any

from fastapi import Request

_DEFAULT_VALUE = "-"

_request_id_var: ContextVar[str] = ContextVar("request_id", default=_DEFAULT_VALUE)
_trace_id_var: ContextVar[str] = ContextVar("trace_id", default=_DEFAULT_VALUE)
_agent_session_id_var: ContextVar[str] = ContextVar("agent_session_id", default=_DEFAULT_VALUE)
_task_id_var: ContextVar[str] = ContextVar("task_id", default=_DEFAULT_VALUE)
_tool_call_id_var: ContextVar[str] = ContextVar("tool_call_id", default=_DEFAULT_VALUE)

_CONTEXT_VARS: dict[str, ContextVar[str]] = {
    "request_id": _request_id_var,
    "trace_id": _trace_id_var,
    "agent_session_id": _agent_session_id_var,
    "task_id": _task_id_var,
    "tool_call_id": _tool_call_id_var,
}

_CONTEXT_FIELDS = (
    "request_id",
    "trace_id",
    "agent_session_id",
    "task_id",
    "tool_call_id",
    "status_code",
    "duration_ms",
    "provider",
    "retry_cause",
)


def _normalize(value: object) -> str:
    if value is None:
        return _DEFAULT_VALUE
    text = str(value).strip()
    return text or _DEFAULT_VALUE


def ensure_request_context(request: Request) -> tuple[str, str]:
    """Attach request/trace IDs to request.state and return them."""
    request_id = _normalize(
        getattr(request.state, "request_id", None)
        or request.headers.get("x-request-id")
        or uuid.uuid4().hex[:12],
    )
    trace_id = _normalize(
        getattr(request.state, "trace_id", None)
        or request.headers.get("x-trace-id")
        or request_id,
    )
    request.state.request_id = request_id  # type: ignore[attr-defined]
    request.state.trace_id = trace_id  # type: ignore[attr-defined]
    return request_id, trace_id


def bind_log_context(**context: object) -> dict[str, Token[str]]:
    """Bind log context vars for the current execution context."""
    tokens: dict[str, Token[str]] = {}
    for field, value in context.items():
        context_var = _CONTEXT_VARS.get(field)
        if context_var is None:
            continue
        tokens[field] = context_var.set(_normalize(value))
    return tokens


def reset_log_context(tokens: dict[str, Token[str]]) -> None:
    """Reset previously bound log context vars."""
    for field, token in tokens.items():
        context_var = _CONTEXT_VARS.get(field)
        if context_var is not None:
            context_var.reset(token)


def request_context_from_request(request: Request) -> tuple[str, str]:
    """Read normalized request/trace IDs from request.state or headers."""
    request_id = getattr(request.state, "request_id", None) or request.headers.get("x-request-id")
    trace_id = getattr(request.state, "trace_id", None) or request.headers.get("x-trace-id")
    return _normalize(request_id), _normalize(trace_id or request_id)


def current_log_context() -> dict[str, str]:
    """Return the currently bound structured log context values."""
    return {
        field: context_var.get()
        for field, context_var in _CONTEXT_VARS.items()
    }


def log_extra(
    *,
    category: str,
    request_id: object | None = None,
    trace_id: object | None = None,
    agent_session_id: object | None = None,
    task_id: object | None = None,
    tool_call_id: object | None = None,
    duration_ms: object | None = None,
    status_code: object | None = None,
    provider: object | None = None,
    retry_cause: object | None = None,
) -> dict[str, Any]:
    """Return normalized logging extras for the shared backend contract."""
    return {
        "log_category": category,
        "request_id": _normalize(request_id) if request_id is not None else _request_id_var.get(),
        "trace_id": _normalize(trace_id) if trace_id is not None else _trace_id_var.get(),
        "agent_session_id": _normalize(agent_session_id) if agent_session_id is not None else _agent_session_id_var.get(),
        "task_id": _normalize(task_id) if task_id is not None else _task_id_var.get(),
        "tool_call_id": _normalize(tool_call_id) if tool_call_id is not None else _tool_call_id_var.get(),
        "duration_ms": _normalize(duration_ms),
        "status_code": _normalize(status_code),
        "provider": _normalize(provider),
        "retry_cause": _normalize(retry_cause),
    }


class LogContextFilter(logging.Filter):
    """Populate log records with default structured context fields."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "log_category"):
            record.log_category = "general"
        for field, context_var in _CONTEXT_VARS.items():
            if not hasattr(record, field):
                setattr(record, field, context_var.get())
        for field in ("duration_ms", "status_code", "provider", "retry_cause"):
            if not hasattr(record, field):
                setattr(record, field, _DEFAULT_VALUE)
        return True


class LtxLogFormatter(logging.Formatter):
    """Compact log formatter with searchable key=value context suffixes."""

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        category = getattr(record, "log_category", "general")
        if category and category != "general":
            message = f"[{category}] {message}"

        context_parts = [
            f"{field}={value}"
            for field in _CONTEXT_FIELDS
            if (value := getattr(record, field, _DEFAULT_VALUE)) != _DEFAULT_VALUE
        ]
        if context_parts:
            message = f"{message} | {' '.join(context_parts)}"

        rendered = f"{self.formatTime(record, self.datefmt)} - {record.levelname} - [Backend] {message}"
        if record.exc_info:
            rendered = f"{rendered}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            rendered = f"{rendered}\n{self.formatStack(record.stack_info)}"
        return rendered
