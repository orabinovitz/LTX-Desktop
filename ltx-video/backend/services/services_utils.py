"""Shared types/protocols for backend service modules."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, BinaryIO, Protocol, TypeAlias, cast

if TYPE_CHECKING:
    import torch
else:
    try:
        import torch as _torch
    except Exception:
        class _TorchStub:
            class Tensor:  # pragma: no cover - structural fallback for type aliases
                pass

            class device:  # pragma: no cover - structural fallback for type aliases
                pass

        _torch = cast(Any, _TorchStub())

    torch = _torch
from PIL.Image import Image as PILImage

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

    from ltx_core.model.video_vae import TilingConfig


JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
RequestFieldValue: TypeAlias = str | bytes | int | float | bool | None
RequestData: TypeAlias = bytes | str | Mapping[str, RequestFieldValue] | BinaryIO | None
PromptInput: TypeAlias = str | Sequence[str]

DeviceLike: TypeAlias = str | torch.device
TensorType: TypeAlias = torch.Tensor
PILImageType: TypeAlias = PILImage

if TYPE_CHECKING:
    FrameArray: TypeAlias = NDArray[np.uint8]
    TilingConfigType: TypeAlias = TilingConfig
else:
    FrameArray: TypeAlias = object
    TilingConfigType: TypeAlias = object

TensorOrNone: TypeAlias = TensorType | None


def get_device_type(device: DeviceLike | object | None) -> str:
    if device is None:
        return "cpu"

    device_type = getattr(device, "type", None)
    if isinstance(device_type, str):
        return device_type

    if isinstance(device, str):
        try:
            return str(torch.device(device).type)
        except Exception:
            return device

    return "cpu"


def device_supports_fp8(device: DeviceLike | object | None) -> bool:
    return get_device_type(device) == "cuda"


def sync_device(device: DeviceLike | object | None) -> None:
    device_type = get_device_type(device)
    if device_type == "cuda":
        try:
            torch.cuda.synchronize()
        except Exception:
            pass
        return

    if device_type == "mps" and hasattr(torch, "mps"):
        try:
            torch.mps.synchronize()
        except Exception:
            pass


def empty_device_cache(device: DeviceLike | object | None) -> None:
    device_type = get_device_type(device)
    if device_type == "cuda":
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        return

    if device_type == "mps" and hasattr(torch, "mps"):
        try:
            torch.mps.empty_cache()
        except Exception:
            pass


class LatentStateLike(Protocol):
    latent: torch.Tensor


class VideoCaptureLike(Protocol):
    def get(self, prop_id: int) -> float:
        ...

    def set(self, prop_id: int, value: float) -> bool:
        ...

    def read(self) -> tuple[bool, FrameArray | None]:
        ...

    def release(self) -> None:
        ...

    def isOpened(self) -> bool:
        ...


class VideoWriterLike(Protocol):
    def write(self, frame: FrameArray) -> None:
        ...

    def release(self) -> None:
        ...


class FluxPipelineOutputLike(Protocol):
    images: Sequence[PILImageType]
