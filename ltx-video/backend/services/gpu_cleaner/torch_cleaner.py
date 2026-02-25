"""GPU cleanup helper service."""

from __future__ import annotations

import gc

from services.services_utils import empty_device_cache


class TorchCleaner:
    """Wraps GPU memory cleanup operations."""

    def __init__(self, device: str = "cpu") -> None:
        self._device = device

    def cleanup(self) -> None:
        empty_device_cache(self._device)
        gc.collect()
