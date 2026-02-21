"""Pro video pipeline protocol definitions."""

from __future__ import annotations

from typing import Literal, Protocol


class ProVideoPipeline(Protocol):
    pipeline_kind: Literal["pro"]

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        distilled_lora_path: str,
        device: str | object,
    ) -> "ProVideoPipeline":
        ...

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
        ...

    def warmup(self, output_path: str) -> None:
        ...

    def compile_transformer(self) -> None:
        ...
