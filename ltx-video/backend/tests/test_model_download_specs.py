"""Tests for model download spec consistency and RuntimeConfig path derivation."""

from __future__ import annotations

from typing import get_args

from state import RuntimeConfig
from runtime_config.model_download_specs import (
    DEFAULT_MODEL_DOWNLOAD_SPECS,
    DEFAULT_REQUIRED_MODEL_TYPES,
    MODEL_FILE_ORDER,
    resolve_required_model_types,
)
from state.app_state_types import ModelFileType


def _build_config(tmp_path):
    models_dir = tmp_path / "models"
    return RuntimeConfig(
        device="cpu",
        models_dir=models_dir,
        model_download_specs=DEFAULT_MODEL_DOWNLOAD_SPECS,
        required_model_types=DEFAULT_REQUIRED_MODEL_TYPES,
        outputs_dir=tmp_path / "outputs",
        ic_lora_dir=models_dir / "ic-loras",
        settings_file=tmp_path / "settings.json",
        ltx_api_base_url="https://api.ltx.video",
        use_sage_attention=False,
        camera_motion_prompts={},
        default_negative_prompt="",
    )


def test_specs_cover_all_model_types():
    expected_types = set(get_args(ModelFileType))
    assert set(DEFAULT_MODEL_DOWNLOAD_SPECS.keys()) == expected_types
    assert set(MODEL_FILE_ORDER) == expected_types


def test_model_path_resolves_from_relative_path(tmp_path):
    config = _build_config(tmp_path)
    spec = config.spec_for("text_encoder")
    assert config.model_path("text_encoder") == config.models_dir / spec.relative_path


def test_download_local_dir_is_derived_from_specs(tmp_path):
    config = _build_config(tmp_path)

    assert config.download_local_dir("checkpoint") == config.models_dir
    assert config.download_local_dir("flux") == config.model_path("flux")
    assert config.download_local_dir("text_encoder") == config.models_dir


def test_required_model_types_remain_dynamic_for_text_encoder():
    required_with_api = resolve_required_model_types(DEFAULT_REQUIRED_MODEL_TYPES, has_api_key=True)
    required_without_api = resolve_required_model_types(DEFAULT_REQUIRED_MODEL_TYPES, has_api_key=False)

    assert "text_encoder" not in required_with_api
    assert "text_encoder" in required_without_api
