"""Tests for GET /api/settings and POST /api/settings."""

from __future__ import annotations

import json

from state.app_settings import AppSettings, UpdateSettingsRequest
from state import build_initial_state
from app_handler import ServiceBundle
from tests.fakes.services import FakeServices


class TestGetSettings:
    def test_default_settings(self, client, default_app_settings):
        r = client.get("/api/settings")
        assert r.status_code == 200
        data = r.json()
        assert data["useTorchCompile"] is False
        assert data["loadOnStartup"] is False
        assert data["ltxApiKey"] == ""
        assert data["useLocalTextEncoder"] is False
        assert data["fastModel"] == {"useUpscaler": True}
        assert data["proModel"] == {"steps": 20, "useUpscaler": True}
        assert data["promptCacheSize"] == 100
        assert data["promptEnhancerEnabledT2V"] is True
        assert data["promptEnhancerEnabledI2V"] is False
        assert data["geminiApiKey"] == ""
        assert data["seedLocked"] is False
        assert data["lockedSeed"] == 42
        assert data["t2vSystemPrompt"] == default_app_settings.t2v_system_prompt
        assert data["i2vSystemPrompt"] == default_app_settings.i2v_system_prompt

    def test_reflects_changed_settings(self, client, test_state):
        test_state.state.app_settings.use_torch_compile = True
        r = client.get("/api/settings")
        assert r.json()["useTorchCompile"] is True

    def test_returns_api_key_when_set(self, client, test_state):
        test_state.state.app_settings.ltx_api_key = "test-key-123"
        r = client.get("/api/settings")
        assert r.json()["ltxApiKey"] == "test-key-123"


class TestPostSettings:
    def test_update_single_field(self, client, test_state):
        r = client.post("/api/settings", json={"useTorchCompile": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.use_torch_compile is True

    def test_update_multiple_fields(self, client, test_state):
        r = client.post("/api/settings", json={"useTorchCompile": True, "loadOnStartup": True})
        assert r.status_code == 200
        assert test_state.state.app_settings.use_torch_compile is True
        assert test_state.state.app_settings.load_on_startup is True

    def test_update_fast_model(self, client, test_state):
        r = client.post("/api/settings", json={"fastModel": {"useUpscaler": False}})
        assert r.status_code == 200
        assert test_state.state.app_settings.fast_model.use_upscaler is False

    def test_update_pro_model(self, client, test_state):
        r = client.post("/api/settings", json={"proModel": {"steps": 30, "useUpscaler": False}})
        assert r.status_code == 200
        assert test_state.state.app_settings.pro_model.steps == 30
        assert test_state.state.app_settings.pro_model.use_upscaler is False

    def test_deep_partial_patch_preserves_nested_fields(self, client, test_state):
        assert test_state.state.app_settings.pro_model.use_upscaler is True
        r = client.post("/api/settings", json={"proModel": {"steps": 30}})
        assert r.status_code == 200
        assert test_state.state.app_settings.pro_model.steps == 30
        assert test_state.state.app_settings.pro_model.use_upscaler is True

    def test_prompt_cache_size_clamped_max(self, client, test_state):
        r = client.post("/api/settings", json={"promptCacheSize": 5000})
        assert r.status_code == 200
        assert test_state.state.app_settings.prompt_cache_size <= 1000

    def test_prompt_cache_size_clamped_min(self, client, test_state):
        r = client.post("/api/settings", json={"promptCacheSize": -10})
        assert r.status_code == 200
        assert test_state.state.app_settings.prompt_cache_size >= 0

    def test_locked_seed_clamped_range(self, client, test_state):
        r = client.post("/api/settings", json={"lockedSeed": 9_999_999_999})
        assert r.status_code == 200
        assert test_state.state.app_settings.locked_seed == 2_147_483_647

    def test_prompt_cache_shrinks_cache(self, client, test_state):
        te = test_state.state.text_encoder
        assert te is not None
        for i in range(5):
            te.prompt_cache[f"key_{i}"] = f"value_{i}"  # type: ignore[assignment]

        r = client.post("/api/settings", json={"promptCacheSize": 2})
        assert r.status_code == 200
        assert len(te.prompt_cache) <= 2

    def test_update_api_keys(self, client, test_state):
        r = client.post("/api/settings", json={"ltxApiKey": "ltx-key-abc", "geminiApiKey": "gemini-key-xyz"})
        assert r.status_code == 200
        assert test_state.state.app_settings.ltx_api_key == "ltx-key-abc"
        assert test_state.state.app_settings.gemini_api_key == "gemini-key-xyz"

    def test_update_system_prompts(self, client, test_state):
        r = client.post(
            "/api/settings",
            json={"t2vSystemPrompt": "Custom T2V prompt", "i2vSystemPrompt": "Custom I2V prompt"},
        )
        assert r.status_code == 200
        assert test_state.state.app_settings.t2v_system_prompt == "Custom T2V prompt"
        assert test_state.state.app_settings.i2v_system_prompt == "Custom I2V prompt"

    def test_unknown_field_rejected(self, client):
        r = client.post("/api/settings", json={"unknownSetting": True})
        assert r.status_code == 422


class TestSettingsPersistence:
    def _new_state(self, test_state, default_app_settings):
        fake_services = FakeServices()
        bundle = ServiceBundle(
            http=fake_services.http,
            gpu_cleaner=fake_services.gpu_cleaner,
            model_downloader=fake_services.model_downloader,
            gpu_info=fake_services.gpu_info,
            video_processor=fake_services.video_processor,
            text_encoder=fake_services.text_encoder,
            task_runner=fake_services.task_runner,
            fast_video_pipeline_class=type(fake_services.fast_video_pipeline),
            fast_native_video_pipeline_class=type(fake_services.fast_native_video_pipeline),
            pro_video_pipeline_class=type(fake_services.pro_video_pipeline),
            pro_native_video_pipeline_class=type(fake_services.pro_native_video_pipeline),
            image_generation_pipeline_class=type(fake_services.image_generation_pipeline),
            ic_lora_pipeline_class=type(fake_services.ic_lora_pipeline),
            ic_lora_model_downloader=fake_services.ic_lora_model_downloader,
        )
        return build_initial_state(test_state.config, default_app_settings.model_copy(deep=True), service_bundle=bundle)

    def test_load_settings_clamps_from_disk(self, test_state, default_app_settings):
        test_state.config.settings_file.write_text(
            json.dumps(
                {
                    "prompt_cache_size": 5000,
                    "locked_seed": -55,
                    "pro_model": {"steps": 999},
                }
            ),
            encoding="utf-8",
        )

        loaded = self._new_state(test_state, default_app_settings)
        assert loaded.state.app_settings.prompt_cache_size == 1000
        assert loaded.state.app_settings.locked_seed == 0
        assert loaded.state.app_settings.pro_model.steps == 100

    def test_legacy_prompt_enhancer_key_migrates(self, test_state, default_app_settings):
        test_state.config.settings_file.write_text(
            json.dumps({"prompt_enhancer_enabled": False}),
            encoding="utf-8",
        )

        loaded = self._new_state(test_state, default_app_settings)
        assert loaded.state.app_settings.prompt_enhancer_enabled_t2v is False
        assert loaded.state.app_settings.prompt_enhancer_enabled_i2v is False


class TestSettingsSchemaDrift:
    def test_update_request_tracks_app_settings_fields(self):
        assert set(AppSettings.model_fields) == set(UpdateSettingsRequest.model_fields)
