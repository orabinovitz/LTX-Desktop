"""Shared base types for state handlers."""

from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from threading import RLock
from typing import Concatenate, ParamSpec, TypeVar

from state.app_state_types import AppState

_P = ParamSpec("_P")
_R = TypeVar("_R")


class StateHandlerBase:
    """Base handler with shared state and lock references."""

    def __init__(self, state: AppState, lock: RLock) -> None:
        self._state = state
        self._lock = lock

    @property
    def state(self) -> AppState:
        return self._state


def with_state_lock(
    method: Callable[Concatenate[StateHandlerBase, _P], _R],
) -> Callable[Concatenate[StateHandlerBase, _P], _R]:
    @wraps(method)
    def wrapped(self: StateHandlerBase, *args: _P.args, **kwargs: _P.kwargs) -> _R:
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapped
