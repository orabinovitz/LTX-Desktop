"""Text encoder service protocol definitions."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol


class TextEncoder(Protocol):
    def install_patches(self, state_getter: Callable[[], object]) -> None:
        ...

    def encode_via_api(self, prompt: str, api_key: str, checkpoint_path: str) -> object | None:
        ...
