"""Pro native video pipeline protocol definitions."""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar, Literal, Protocol

if TYPE_CHECKING:
    import torch


class ProNativeVideoPipeline(Protocol):
    pipeline_kind: ClassVar[Literal["pro-native"]]

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        device: torch.device,
    ) -> "ProNativeVideoPipeline":
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
