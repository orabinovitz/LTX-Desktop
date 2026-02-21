"""LTX IC-LoRA pipeline wrapper."""

from __future__ import annotations

import torch

from services.ltx_pipeline_common import default_tiling_config, encode_video_output, video_chunks_number
from services.services_utils import DeviceLike, TensorOrNone, TilingConfigType


class LTXIcLoraPipeline:
    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        lora_path: str,
        device: str | object,
    ) -> "LTXIcLoraPipeline":
        return LTXIcLoraPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            upsampler_path=upsampler_path,
            lora_path=lora_path,
            device=device,
        )

    def __init__(
        self,
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        lora_path: str,
        device: DeviceLike,
    ) -> None:
        from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
        from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
        from ltx_core.quantization import QuantizationPolicy
        from ltx_pipelines.ic_lora import ICLoraPipeline

        lora_entry = LoraPathStrengthAndSDOps(path=lora_path, strength=1.0, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP)
        self.pipeline = ICLoraPipeline(
            checkpoint_path=checkpoint_path,
            spatial_upsampler_path=upsampler_path,
            gemma_root=gemma_root,
            loras=[lora_entry],
            device=device,
            quantization=QuantizationPolicy.fp8_cast(),
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
        video_conditioning: list[tuple[str, float]],
        tiling_config: TilingConfigType,
    ) -> tuple[torch.Tensor, TensorOrNone] | torch.Tensor:
        return self.pipeline(
            prompt=prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            images=images,
            video_conditioning=video_conditioning,
            tiling_config=tiling_config,
        )

    @staticmethod
    def _normalize_generation_result(
        generation_result: tuple[torch.Tensor, TensorOrNone] | torch.Tensor,
    ) -> tuple[torch.Tensor, TensorOrNone]:
        if isinstance(generation_result, tuple):
            if len(generation_result) == 2:
                video, audio = generation_result
                return video, audio
            if len(generation_result) == 1:
                return generation_result[0], None
            raise RuntimeError("Unexpected IC-LoRA pipeline result shape")

        return generation_result, None

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
        video_conditioning: list[tuple[str, float]],
        output_path: str,
    ) -> None:
        tiling_config = default_tiling_config()
        generation_result = self._run_inference(
            prompt=prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            images=images,
            video_conditioning=video_conditioning,
            tiling_config=tiling_config,
        )

        video, audio = self._normalize_generation_result(generation_result)
        chunks = video_chunks_number(num_frames, tiling_config)
        encode_video_output(video=video, audio=audio, fps=int(frame_rate), output_path=output_path, video_chunks_number_value=chunks)
