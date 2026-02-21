"""GPU info query service implementation."""

from __future__ import annotations

import torch

from services.gpu_info.gpu_info import GpuTelemetryPayload


class GpuInfoImpl:
    """Wraps pynvml and torch.cuda queries."""

    def get_gpu_info(self) -> GpuTelemetryPayload:
        try:
            import pynvml

            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            raw_name = pynvml.nvmlDeviceGetName(handle)
            name = raw_name.decode("utf-8", errors="replace") if isinstance(raw_name, bytes) else str(raw_name)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            pynvml.nvmlShutdown()
            return {
                "name": name,
                "vram": memory.total // (1024 * 1024),
                "vramUsed": memory.used // (1024 * 1024),
            }
        except Exception:
            return {"name": "Unknown", "vram": 0, "vramUsed": 0}

    def get_cuda_available(self) -> bool:
        return bool(torch.cuda.is_available())

    def get_device_name(self) -> str | None:
        if not torch.cuda.is_available():
            return None
        try:
            return str(torch.cuda.get_device_name(0))
        except Exception:
            return None

    def get_vram_total_gb(self) -> int | None:
        if not torch.cuda.is_available():
            return None
        try:
            return int(torch.cuda.get_device_properties(0).total_memory // (1024**3))
        except Exception:
            return None
