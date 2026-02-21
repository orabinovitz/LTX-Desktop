"""Flux image generation pipeline wrapper."""

from __future__ import annotations

import torch

from services.services_utils import FluxPipelineOutputLike, PILImageType


class FluxImageGenerationPipeline:
    @staticmethod
    def create(
        model_path: str,
        device: str | None = None,
    ) -> "FluxImageGenerationPipeline":
        return FluxImageGenerationPipeline(model_path=model_path, device=device)

    def __init__(self, model_path: str, device: str | None = None) -> None:
        from diffusers import Flux2KleinPipeline

        self.pipeline = Flux2KleinPipeline.from_pretrained(model_path, torch_dtype=torch.bfloat16)
        if device is not None:
            self.pipeline.to(device)

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
        generator = torch.Generator(device="cuda").manual_seed(seed)
        return self.pipeline(
            prompt=prompt,
            height=height,
            width=width,
            guidance_scale=guidance_scale,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )

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
        generator = torch.Generator(device="cuda").manual_seed(seed)
        return self.pipeline(
            prompt=prompt,
            image=image,
            height=height,
            width=width,
            guidance_scale=guidance_scale,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )

    def to(self, device: str) -> None:
        self.pipeline.to(device)
