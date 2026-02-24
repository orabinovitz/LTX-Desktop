"""Canonical model download specs and required-model policy."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import cast

from state.app_state_types import ModelFileType


@dataclass(frozen=True, slots=True)
class ModelFileDownloadSpec:
    relative_path: Path
    expected_size_bytes: int
    is_folder: bool
    repo_id: str
    description: str
    snapshot_allow_patterns: tuple[str, ...] | None = None

    @property
    def name(self) -> str:
        return self.relative_path.name


MODEL_FILE_ORDER: tuple[ModelFileType, ...] = (
    "checkpoint",
    "upsampler",
    "distilled_lora",
    "text_encoder",
    "flux",
)


DEFAULT_MODEL_DOWNLOAD_SPECS: dict[ModelFileType, ModelFileDownloadSpec] = {
    "checkpoint": ModelFileDownloadSpec(
        relative_path=Path("ltx-2-19b-distilled-fp8.safetensors"),
        expected_size_bytes=19_000_000_000,
        is_folder=False,
        repo_id="Lightricks/LTX-2",
        description="Main transformer model (FP8)",
    ),
    "upsampler": ModelFileDownloadSpec(
        relative_path=Path("ltx-2-spatial-upscaler-x2-1.0.safetensors"),
        expected_size_bytes=1_000_000_000,
        is_folder=False,
        repo_id="Lightricks/LTX-2",
        description="2x Upscaler",
    ),
    "distilled_lora": ModelFileDownloadSpec(
        relative_path=Path("ltx-2-19b-distilled-lora-384.safetensors"),
        expected_size_bytes=400_000_000,
        is_folder=False,
        repo_id="Lightricks/LTX-2",
        description="LoRA for Pro model",
    ),
    "text_encoder": ModelFileDownloadSpec(
        relative_path=Path("text_encoder"),
        expected_size_bytes=8_000_000_000,
        is_folder=True,
        repo_id="Lightricks/LTX-2",
        description="Gemma text encoder",
        snapshot_allow_patterns=("text_encoder/*", "tokenizer/*"),
    ),
    "flux": ModelFileDownloadSpec(
        relative_path=Path("FLUX.2-klein-4B"),
        expected_size_bytes=15_000_000_000,
        is_folder=True,
        repo_id="black-forest-labs/FLUX.2-klein-4B",
        description="Flux model for text-to-image",
    ),
}


DEFAULT_REQUIRED_MODEL_TYPES: frozenset[ModelFileType] = frozenset(
    {"checkpoint", "upsampler", "distilled_lora", "flux"}
)


def resolve_required_model_types(base_required: frozenset[ModelFileType], has_api_key: bool, use_local_text_encoder: bool = False) -> frozenset[ModelFileType]:
    if has_api_key and not use_local_text_encoder:
        return base_required
    return cast(frozenset[ModelFileType], base_required | {"text_encoder"})
