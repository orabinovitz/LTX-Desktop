"""LTX pro video pipeline wrapper."""

from __future__ import annotations

import os

import torch

from services.ltx_pipeline_common import (
    CompileMixin,
    default_guiders,
    default_tiling_config,
    encode_video_output,
    video_chunks_number,
)
from services.services_utils import DeviceLike, TensorOrNone, TilingConfigType


class LTXProVideoPipeline(CompileMixin):
    pipeline_kind = "pro"

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        distilled_lora_path: str,
        device: str | object,
    ) -> "LTXProVideoPipeline":
        return LTXProVideoPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            upsampler_path=upsampler_path,
            distilled_lora_path=distilled_lora_path,
            device=device,
        )

    def __init__(
        self,
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        distilled_lora_path: str,
        device: DeviceLike,
    ) -> None:
        from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
        from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
        from ltx_core.quantization import QuantizationPolicy
        from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline

        self.pipeline = TI2VidTwoStagesPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            spatial_upsampler_path=upsampler_path,
            distilled_lora=[
                LoraPathStrengthAndSDOps(distilled_lora_path, 1.0, LTXV_LORA_COMFY_RENAMING_MAP),
            ],
            loras=[],
            device=device,
            quantization=QuantizationPolicy.fp8_cast(),
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
        tiling_config: TilingConfigType,
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
            tiling_config=tiling_config,
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
        tiling_config = default_tiling_config()
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
                negative_prompt="",
                seed=42,
                height=256,
                width=384,
                num_frames=warmup_frames,
                frame_rate=8,
                num_inference_steps=5,
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
