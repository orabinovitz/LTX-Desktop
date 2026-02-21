"""LTX pro-native video pipeline wrapper."""

from __future__ import annotations

import os
from typing import Final

import torch

from services.ltx_pipeline_common import CompileMixin, default_guiders, encode_video_output, video_chunks_number
from services.services_utils import DeviceLike, TensorOrNone, device_supports_fp8


class LTXProNativeVideoPipeline(CompileMixin):
    pipeline_kind: Final = "pro-native"

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        device: str | object,
    ) -> "LTXProNativeVideoPipeline":
        return LTXProNativeVideoPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            device=device,
        )

    def __init__(self, checkpoint_path: str, gemma_root: str | None, device: DeviceLike) -> None:
        from ltx_core.quantization import QuantizationPolicy
        from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline

        self.pipeline = TI2VidOneStagePipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            loras=[],
            device=device,
            quantization=QuantizationPolicy.fp8_cast() if device_supports_fp8(device) else None,
        )

    def _run_inference(
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        num_inference_steps: int,
        images: list[tuple[str, int, float]],
    ) -> tuple[torch.Tensor, TensorOrNone]:
        video_guider_params, audio_guider_params = default_guiders()
        return self.pipeline(
            prompt=prompt,
            negative_prompt=negative_prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            num_inference_steps=num_inference_steps,
            video_guider_params=video_guider_params,
            audio_guider_params=audio_guider_params,
            images=images,
        )

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        num_inference_steps: int,
        images: list[tuple[str, int, float]],
        output_path: str,
    ) -> None:
        video, audio = self._run_inference(
            prompt=prompt,
            negative_prompt=negative_prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            num_inference_steps=num_inference_steps,
            images=images,
        )
        chunks = video_chunks_number(num_frames, None)
        encode_video_output(video=video, audio=audio, fps=int(frame_rate), output_path=output_path, video_chunks_number_value=chunks)

    @torch.inference_mode()
    def warmup(self, output_path: str) -> None:
        try:
            video, audio = self._run_inference(
                prompt="test warmup",
                negative_prompt="",
                seed=42,
                height=256,
                width=384,
                num_frames=9,
                frame_rate=8,
                num_inference_steps=5,
                images=[],
            )
            encode_video_output(video=video, audio=audio, fps=8, output_path=output_path, video_chunks_number_value=1)
        finally:
            if os.path.exists(output_path):
                os.unlink(output_path)

    def compile_transformer(self) -> None:
        self._compile_transformer()
