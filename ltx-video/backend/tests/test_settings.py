"""Tests for GET /api/settings and POST /api/settings."""
import requests
from unittest.mock import patch

import ltx2_server


class TestGetSettings:
    """GET /api/settings"""

    def test_default_settings(self, server):
        r = requests.get(f"{server}/api/settings")
        assert r.status_code == 200
        data = r.json()
        assert data["keepModelsLoaded"] is True
        assert data["useTorchCompile"] is False
        assert data["loadOnStartup"] is False
        assert data["ltxApiKey"] == ""
        assert data["useLocalTextEncoder"] is False
        assert data["fastModel"] == {"steps": 8, "useUpscaler": True}
        assert data["proModel"] == {"steps": 20, "useUpscaler": True}
        assert data["promptCacheSize"] == 100
        assert data["promptEnhancerEnabledT2V"] is True
        assert data["promptEnhancerEnabledI2V"] is False
        assert data["geminiApiKey"] == ""
        assert data["seedLocked"] is False
        assert data["lockedSeed"] == 42

    def test_reflects_changed_settings(self, server):
        ltx2_server.app_settings["keep_models_loaded"] = False
        ltx2_server.app_settings["use_torch_compile"] = True
        r = requests.get(f"{server}/api/settings")
        data = r.json()
        assert data["keepModelsLoaded"] is False
        assert data["useTorchCompile"] is True

    def test_system_prompt_defaults(self, server):
        r = requests.get(f"{server}/api/settings")
        data = r.json()
        assert data["t2vSystemPrompt"] == ltx2_server.DEFAULT_T2V_SYSTEM_PROMPT
        assert data["i2vSystemPrompt"] == ltx2_server.DEFAULT_I2V_SYSTEM_PROMPT

    def test_returns_api_key_when_set(self, server):
        ltx2_server.app_settings["ltx_api_key"] = "test-key-123"
        r = requests.get(f"{server}/api/settings")
        data = r.json()
        assert data["ltxApiKey"] == "test-key-123"


class TestPostSettings:
    """POST /api/settings"""

    @patch("ltx2_server.save_settings")
    def test_update_single_field(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={"keepModelsLoaded": False})
        assert r.status_code == 200
        assert ltx2_server.app_settings["keep_models_loaded"] is False

    @patch("ltx2_server.save_settings")
    def test_update_multiple_fields(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "keepModelsLoaded": False,
            "useTorchCompile": True,
            "loadOnStartup": True,
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["keep_models_loaded"] is False
        assert ltx2_server.app_settings["use_torch_compile"] is True
        assert ltx2_server.app_settings["load_on_startup"] is True

    @patch("ltx2_server.save_settings")
    def test_update_fast_model(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "fastModel": {"steps": 12, "useUpscaler": False},
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["fast_model"]["steps"] == 12
        assert ltx2_server.app_settings["fast_model"]["use_upscaler"] is False

    @patch("ltx2_server.save_settings")
    def test_update_pro_model(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "proModel": {"steps": 30, "useUpscaler": False},
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["pro_model"]["steps"] == 30
        assert ltx2_server.app_settings["pro_model"]["use_upscaler"] is False

    @patch("ltx2_server.save_settings")
    def test_prompt_cache_size_clamped_max(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={"promptCacheSize": 5000})
        assert r.status_code == 200
        assert ltx2_server.app_settings["prompt_cache_size"] <= 1000

    @patch("ltx2_server.save_settings")
    def test_prompt_cache_size_clamped_min(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={"promptCacheSize": -10})
        assert r.status_code == 200
        assert ltx2_server.app_settings["prompt_cache_size"] >= 0

    @patch("ltx2_server.save_settings")
    def test_prompt_cache_shrinks_cache(self, _save, server):
        # Pre-populate the cache with 5 entries
        for i in range(5):
            ltx2_server._prompt_embeddings_cache[f"key_{i}"] = f"value_{i}"
        assert len(ltx2_server._prompt_embeddings_cache) == 5

        r = requests.post(f"{server}/api/settings", json={"promptCacheSize": 2})
        assert r.status_code == 200
        assert len(ltx2_server._prompt_embeddings_cache) <= 2

    @patch("ltx2_server.save_settings")
    def test_update_api_keys(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "ltxApiKey": "ltx-key-abc",
            "geminiApiKey": "gemini-key-xyz",
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["ltx_api_key"] == "ltx-key-abc"
        assert ltx2_server.app_settings["gemini_api_key"] == "gemini-key-xyz"

    @patch("ltx2_server.save_settings")
    def test_update_system_prompts(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "t2vSystemPrompt": "Custom T2V prompt",
            "i2vSystemPrompt": "Custom I2V prompt",
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["t2v_system_prompt"] == "Custom T2V prompt"
        assert ltx2_server.app_settings["i2v_system_prompt"] == "Custom I2V prompt"

    @patch("ltx2_server.save_settings")
    def test_update_prompt_enhancer_flags(self, _save, server):
        r = requests.post(f"{server}/api/settings", json={
            "promptEnhancerEnabledT2V": False,
            "promptEnhancerEnabledI2V": True,
        })
        assert r.status_code == 200
        assert ltx2_server.app_settings["prompt_enhancer_enabled_t2v"] is False
        assert ltx2_server.app_settings["prompt_enhancer_enabled_i2v"] is True

    @patch("ltx2_server.save_settings")
    def test_partial_update_preserves_others(self, _save, server):
        original_compile = ltx2_server.app_settings["use_torch_compile"]
        original_startup = ltx2_server.app_settings["load_on_startup"]

        r = requests.post(f"{server}/api/settings", json={"keepModelsLoaded": False})
        assert r.status_code == 200
        assert ltx2_server.app_settings["keep_models_loaded"] is False
        assert ltx2_server.app_settings["use_torch_compile"] == original_compile
        assert ltx2_server.app_settings["load_on_startup"] == original_startup

    @patch("ltx2_server.save_settings")
    def test_calls_save_settings(self, mock_save, server):
        requests.post(f"{server}/api/settings", json={"keepModelsLoaded": False})
        mock_save.assert_called_once()

    @patch("ltx2_server.save_settings")
    def test_empty_body_noop(self, _save, server):
        snapshot = ltx2_server.app_settings.copy()
        r = requests.post(f"{server}/api/settings", json={})
        assert r.status_code == 200
        # Core fields unchanged
        assert ltx2_server.app_settings["keep_models_loaded"] == snapshot["keep_models_loaded"]
        assert ltx2_server.app_settings["use_torch_compile"] == snapshot["use_torch_compile"]
