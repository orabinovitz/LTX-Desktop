"""GPU cleanup helper service."""

from __future__ import annotations

import gc

import torch


class TorchCleaner:
    """Wraps GPU memory cleanup operations."""

    def cleanup(self) -> None:
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        gc.collect()
