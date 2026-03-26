"""Helpers for attaching agent-specific context to backend logs."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

from log_context import bind_log_context, log_extra, reset_log_context


def agent_log_extra(
    *,
    category: str,
    session_id: str | None = None,
    task_id: str | None = None,
    tool_call_id: str | None = None,
    duration_ms: int | None = None,
    status_code: int | None = None,
    provider: str | None = None,
    retry_cause: str | None = None,
) -> dict[str, Any]:
    """Return normalized log extras for agent/orchestrator events."""
    return log_extra(
        category=category,
        agent_session_id=session_id,
        task_id=task_id,
        tool_call_id=tool_call_id,
        duration_ms=duration_ms,
        status_code=status_code,
        provider=provider,
        retry_cause=retry_cause,
    )


@contextmanager
def bound_agent_log_context(
    *,
    session_id: str | None = None,
    task_id: str | None = None,
    tool_call_id: str | None = None,
):
    """Bind agent context for the duration of a request-level operation."""
    tokens = bind_log_context(
        agent_session_id=session_id,
        task_id=task_id,
        tool_call_id=tool_call_id,
    )
    try:
        yield
    finally:
        reset_log_context(tokens)
