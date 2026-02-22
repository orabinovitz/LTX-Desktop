"""Flux image generation pipeline wrapper."""

from __future__ import annotations

from typing import cast

import torch
from diffusers.pipelines.flux2.pipeline_flux2_klein import Flux2KleinPipeline

from services.services_utils import FluxPipelineOutputLike, PILImageType, get_device_type


class FluxImageGenerationPipeline:
    @staticmethod
    def create(
        model_path: str,
        device: str | None = None,
    ) -> "FluxImageGenerationPipeline":
        return FluxImageGenerationPipeline(model_path=model_path, device=device)

    def __init__(self, model_path: str, device: str | None = None) -> None:
        self._device: str | None = None
        self.pipeline = Flux2KleinPipeline.from_pretrained(  # type: ignore[reportUnknownMemberType]
            model_path,
            torch_dtype=torch.bfloat16,
        )
        if device is not None:
            runtime_device = get_device_type(device)
            self.pipeline.to(runtime_device)  # type: ignore[reportUnknownMemberType]
            self._device = runtime_device

    def _resolve_generator_device(self) -> str:
        if self._device is not None:
            return self._device

        execution_device = getattr(self.pipeline, "_execution_device", None)
        return get_device_type(execution_device)

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        height: int,
        width: int,
        guidance_scale: float,
        num_inference_steps: int,
        seed: int,
    ) -> FluxPipelineOutputLike:
        generator = torch.Generator(device=self._resolve_generator_device()).manual_seed(seed)
        output = self.pipeline(  # type: ignore[reportUnknownMemberType]
            prompt=prompt,
            height=height,
            width=width,
            guidance_scale=guidance_scale,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )
        output_obj = cast(object, output)
        if not hasattr(output_obj, "images"):
            raise RuntimeError("Unexpected Flux pipeline output format")
        return cast(FluxPipelineOutputLike, output_obj)

    @torch.inference_mode()
    def generate_edit(
        self,
        prompt: str,
        image: PILImageType | list[PILImageType],
        height: int,
        width: int,
        guidance_scale: float,
        num_inference_steps: int,
        seed: int,
    ) -> FluxPipelineOutputLike:
        generator = torch.Generator(device=self._resolve_generator_device()).manual_seed(seed)
        output = self.pipeline(  # type: ignore[reportUnknownMemberType]
            prompt=prompt,
            image=image,
            height=height,
            width=width,
            guidance_scale=guidance_scale,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )
        output_obj = cast(object, output)
        if not hasattr(output_obj, "images"):
            raise RuntimeError("Unexpected Flux pipeline output format")
        return cast(FluxPipelineOutputLike, output_obj)

    def to(self, device: str) -> None:
        runtime_device = get_device_type(device)
        self.pipeline.to(runtime_device)  # type: ignore[reportUnknownMemberType]
        self._device = runtime_device
