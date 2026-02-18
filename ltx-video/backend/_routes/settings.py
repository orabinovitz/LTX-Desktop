"""Route handlers for GET/POST /api/settings."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def get_settings() -> dict[str, Any]:
    """GET /api/settings"""
    import ltx2_server as _mod

    return {
        "keepModelsLoaded": _mod.app_settings["keep_models_loaded"],
        "useTorchCompile": _mod.app_settings["use_torch_compile"],
        "loadOnStartup": _mod.app_settings["load_on_startup"],
        "ltxApiKey": _mod.app_settings.get("ltx_api_key", ""),
        "useLocalTextEncoder": _mod.app_settings.get("use_local_text_encoder", False),
        "fastModel": {
            "steps": _mod.app_settings["fast_model"]["steps"],
            "useUpscaler": _mod.app_settings["fast_model"]["use_upscaler"],
        },
        "proModel": {
            "steps": _mod.app_settings["pro_model"]["steps"],
            "useUpscaler": _mod.app_settings["pro_model"]["use_upscaler"],
        },
        "promptCacheSize": _mod.app_settings.get("prompt_cache_size", 100),
        "promptEnhancerEnabledT2V": _mod.app_settings.get("prompt_enhancer_enabled_t2v", True),
        "promptEnhancerEnabledI2V": _mod.app_settings.get("prompt_enhancer_enabled_i2v", False),
        "geminiApiKey": _mod.app_settings.get("gemini_api_key", ""),
        "t2vSystemPrompt": _mod.app_settings.get("t2v_system_prompt", _mod.DEFAULT_T2V_SYSTEM_PROMPT),
        "i2vSystemPrompt": _mod.app_settings.get("i2v_system_prompt", _mod.DEFAULT_I2V_SYSTEM_PROMPT),
        "seedLocked": _mod.app_settings.get("seed_locked", False),
        "lockedSeed": _mod.app_settings.get("locked_seed", 42),
    }


def post_settings(data: dict[str, Any]) -> dict[str, str]:
    """POST /api/settings"""
    import ltx2_server as _mod

    with _mod.settings_lock:
        if "keepModelsLoaded" in data:
            old_value = _mod.app_settings["keep_models_loaded"]
            _mod.app_settings["keep_models_loaded"] = bool(data["keepModelsLoaded"])
            if old_value != _mod.app_settings["keep_models_loaded"]:
                logger.info(f"Setting 'keep_models_loaded' changed to: {_mod.app_settings['keep_models_loaded']}")

        if "useTorchCompile" in data:
            old_value = _mod.app_settings["use_torch_compile"]
            _mod.app_settings["use_torch_compile"] = bool(data["useTorchCompile"])
            if old_value != _mod.app_settings["use_torch_compile"]:
                logger.info(f"Setting 'use_torch_compile' changed to: {_mod.app_settings['use_torch_compile']}")
                logger.info("Restart required for torch.compile changes to take effect")

        if "loadOnStartup" in data:
            old_value = _mod.app_settings["load_on_startup"]
            _mod.app_settings["load_on_startup"] = bool(data["loadOnStartup"])
            if old_value != _mod.app_settings["load_on_startup"]:
                logger.info(f"Setting 'load_on_startup' changed to: {_mod.app_settings['load_on_startup']}")
                logger.info("Restart required for this change to take effect")

        if "ltxApiKey" in data:
            old_value = _mod.app_settings.get("ltx_api_key", "")
            _mod.app_settings["ltx_api_key"] = str(data["ltxApiKey"])
            if old_value != _mod.app_settings["ltx_api_key"]:
                if _mod.app_settings["ltx_api_key"]:
                    logger.info("LTX API key configured - text encoding will use fast API (~1s)")
                else:
                    logger.info("LTX API key removed - text encoding will use local encoder (~23s)")

        if "useLocalTextEncoder" in data:
            old_value = _mod.app_settings.get("use_local_text_encoder", False)
            _mod.app_settings["use_local_text_encoder"] = bool(data["useLocalTextEncoder"])
            if old_value != _mod.app_settings["use_local_text_encoder"]:
                if _mod.app_settings["use_local_text_encoder"]:
                    logger.info("Switched to local text encoder")
                else:
                    logger.info("Switched to LTX API for text encoding")

        if "fastModel" in data and isinstance(data["fastModel"], dict):
            new_settings = {
                "steps": int(data["fastModel"].get("steps", 8)),
                "use_upscaler": bool(data["fastModel"].get("useUpscaler", True)),
            }
            if new_settings != _mod.app_settings["fast_model"]:
                _mod.app_settings["fast_model"] = new_settings
                logger.info(
                    f"Fast model settings updated: {new_settings['steps']} steps, "
                    f"upscaler={'on' if new_settings['use_upscaler'] else 'off'}"
                )

        if "proModel" in data and isinstance(data["proModel"], dict):
            new_settings = {
                "steps": int(data["proModel"].get("steps", 20)),
                "use_upscaler": bool(data["proModel"].get("useUpscaler", True)),
            }
            if new_settings != _mod.app_settings["pro_model"]:
                _mod.app_settings["pro_model"] = new_settings
                logger.info(
                    f"Pro model settings updated: {new_settings['steps']} steps, "
                    f"upscaler={'on' if new_settings['use_upscaler'] else 'off'}"
                )

        if "promptCacheSize" in data:
            new_size = max(0, min(1000, int(data["promptCacheSize"])))
            if new_size != _mod.app_settings.get("prompt_cache_size", 100):
                _mod.app_settings["prompt_cache_size"] = new_size
                while len(_mod._prompt_embeddings_cache) > new_size:
                    oldest_key = next(iter(_mod._prompt_embeddings_cache))
                    del _mod._prompt_embeddings_cache[oldest_key]
                logger.info(f"Prompt cache size set to {new_size}")

        if "promptEnhancerEnabledT2V" in data:
            old_value = _mod.app_settings.get("prompt_enhancer_enabled_t2v", True)
            _mod.app_settings["prompt_enhancer_enabled_t2v"] = bool(data["promptEnhancerEnabledT2V"])
            if old_value != _mod.app_settings["prompt_enhancer_enabled_t2v"]:
                state = "enabled" if _mod.app_settings["prompt_enhancer_enabled_t2v"] else "disabled"
                logger.info(f"T2V prompt enhancer {state}")

        if "promptEnhancerEnabledI2V" in data:
            old_value = _mod.app_settings.get("prompt_enhancer_enabled_i2v", False)
            _mod.app_settings["prompt_enhancer_enabled_i2v"] = bool(data["promptEnhancerEnabledI2V"])
            if old_value != _mod.app_settings["prompt_enhancer_enabled_i2v"]:
                state = "enabled" if _mod.app_settings["prompt_enhancer_enabled_i2v"] else "disabled"
                logger.info(f"I2V prompt enhancer {state}")

        if "geminiApiKey" in data:
            old_key = _mod.app_settings.get("gemini_api_key", "")
            _mod.app_settings["gemini_api_key"] = str(data["geminiApiKey"])
            if old_key != _mod.app_settings["gemini_api_key"]:
                if _mod.app_settings["gemini_api_key"]:
                    logger.info("Gemini API key configured for prompt enhancement")
                else:
                    logger.info("Gemini API key removed")

        if "t2vSystemPrompt" in data:
            _mod.app_settings["t2v_system_prompt"] = str(data["t2vSystemPrompt"])
            logger.info("T2V system prompt updated")

        if "i2vSystemPrompt" in data:
            _mod.app_settings["i2v_system_prompt"] = str(data["i2vSystemPrompt"])
            logger.info("I2V system prompt updated")

        if "seedLocked" in data:
            old_value = _mod.app_settings.get("seed_locked", False)
            _mod.app_settings["seed_locked"] = bool(data["seedLocked"])
            if old_value != _mod.app_settings["seed_locked"]:
                if _mod.app_settings["seed_locked"]:
                    logger.info(f"Seed locked to {_mod.app_settings.get('locked_seed', 42)}")
                else:
                    logger.info("Seed unlocked (random)")

        if "lockedSeed" in data:
            _mod.app_settings["locked_seed"] = int(data["lockedSeed"])
            if _mod.app_settings.get("seed_locked", False):
                logger.info(f"Locked seed updated to {_mod.app_settings['locked_seed']}")

    _mod.save_settings()
    return {"status": "ok"}
