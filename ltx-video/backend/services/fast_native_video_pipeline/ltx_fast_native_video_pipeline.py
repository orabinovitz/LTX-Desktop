"""LTX fast-native video pipeline wrapper."""

from __future__ import annotations

import os

import torch

from services.ltx_pipeline_common import (
    CompileMixin,
    DistilledNativePipeline,
    default_tiling_config,
    encode_video_output,
    video_chunks_number,
)
from services.services_utils import DeviceLike, TensorOrNone, TilingConfigType


class LTXFastNativeVideoPipeline(CompileMixin):
    pipeline_kind = "fast-native"

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        device: str | object,
    ) -> "LTXFastNativeVideoPipeline":
        return LTXFastNativeVideoPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            device=device,
        )

    def __init__(self, checkpoint_path: str, gemma_root: str | None, device: DeviceLike) -> None:
        self.pipeline = DistilledNativePipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            device=device,
            fp8transformer=True,
        )

    def _run_inference(
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[tuple[str, int, float]],
        tiling_config: TilingConfigType,
    ) -> tuple[torch.Tensor, TensorOrNone]:
        return self.pipeline(
            prompt=prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            images=images,
            tiling_config=tiling_config,
        )

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[tuple[str, int, float]],
        output_path: str,
    ) -> None:
        tiling_config = default_tiling_config()
        video, audio = self._run_inference(
            prompt=prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            images=images,
            tiling_config=tiling_config,
        )
        chunks = video_chunks_number(num_frames, tiling_config)
        encode_video_output(video=video, audio=audio, fps=int(frame_rate), output_path=output_path, video_chunks_number_value=chunks)

    @torch.inference_mode()
    def warmup(self, output_path: str) -> None:
        warmup_frames = 9
        tiling_config = default_tiling_config()

        try:
            video, audio = self._run_inference(
                prompt="test warmup",
                seed=42,
                height=256,
                width=384,
                num_frames=warmup_frames,
                frame_rate=8,
                images=[],
                tiling_config=tiling_config,
            )
            chunks = video_chunks_number(warmup_frames, tiling_config)
            encode_video_output(video=video, audio=audio, fps=8, output_path=output_path, video_chunks_number_value=chunks)
        finally:
            if os.path.exists(output_path):
                os.unlink(output_path)

    def compile_transformer(self) -> None:
        self._compile_transformer()
