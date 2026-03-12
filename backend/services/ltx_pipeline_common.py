"""Shared helpers and primitives for LTX video pipeline wrappers."""

from __future__ import annotations

from collections.abc import Iterator
import torch

from services.services_utils import AudioOrNone, TilingConfigType


def default_tiling_config() -> TilingConfigType:
    from ltx_core.model.video_vae import TilingConfig

    return TilingConfig.default()


def video_chunks_number(num_frames: int, tiling_config: TilingConfigType | None) -> int:
    from ltx_core.model.video_vae import get_video_chunks_number

    return int(get_video_chunks_number(num_frames, tiling_config))


def encode_video_output(
    video: torch.Tensor | Iterator[torch.Tensor],
    audio: AudioOrNone,
    fps: int,
    output_path: str,
    video_chunks_number_value: int,
) -> None:
    from ltx_pipelines.utils.media_io import encode_video

    encode_video(
        video=video,
        fps=fps,
        audio=audio,
        output_path=output_path,
        video_chunks_number=video_chunks_number_value,
    )
