"""Image generation pipeline protocol definitions."""

from __future__ import annotations

from typing import Protocol

from services.services_utils import FluxPipelineOutputLike, PILImageType


class ImageGenerationPipeline(Protocol):
    @staticmethod
    def create(
        model_path: str,
        device: str | None = None,
    ) -> "ImageGenerationPipeline":
        ...

    def generate(
        self,
        prompt: str,
        height: int,
        width: int,
        guidance_scale: float,
        num_inference_steps: int,
        seed: int,
    ) -> FluxPipelineOutputLike:
        ...

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
        ...

    def to(self, device: str) -> None:
        ...
