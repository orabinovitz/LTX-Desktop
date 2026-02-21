"""GPU cleanup helper service."""

from __future__ import annotations

import gc

from services.services_utils import empty_device_cache


class TorchCleaner:
    """Wraps GPU memory cleanup operations."""

    def cleanup(self) -> None:
        empty_device_cache("cuda")
        empty_device_cache("mps")
        gc.collect()
