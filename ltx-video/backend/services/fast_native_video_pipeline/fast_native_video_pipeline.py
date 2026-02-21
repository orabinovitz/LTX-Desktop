"""Fast native video pipeline protocol definitions."""

from __future__ import annotations

from typing import Literal, Protocol


class FastNativeVideoPipeline(Protocol):
    pipeline_kind: Literal["fast-native"]

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        device: str | object,
    ) -> "FastNativeVideoPipeline":
        ...

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
        ...

    def warmup(self, output_path: str) -> None:
        ...

    def compile_transformer(self) -> None:
        ...
