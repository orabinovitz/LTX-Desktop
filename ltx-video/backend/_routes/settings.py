"""Route handlers for GET/POST /api/settings."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from _models import UpdateSettingsRequest, SettingsResponse, StatusResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings", response_model=SettingsResponse)
async def route_get_settings():
    return get_settings()


@router.post("/settings", response_model=StatusResponse)
async def route_post_settings(req: UpdateSettingsRequest):
    return post_settings(req)


def get_settings() -> dict[str, Any]:
    """GET /api/settings"""
    import ltx2_server as _mod

    return {
        "useTorchCompile": _mod.app_settings["use_torch_compile"],
        "loadOnStartup": _mod.app_settings["load_on_startup"],
        "ltxApiKey": _mod.app_settings.get("ltx_api_key", ""),
        "useLocalTextEncoder": _mod.app_settings.get("use_local_text_encoder", False),
        "fastModel": {
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


def post_settings(req: UpdateSettingsRequest) -> dict[str, str]:
    """POST /api/settings"""
    import ltx2_server as _mod

    with _mod.settings_lock:
        if req.useTorchCompile is not None:
            old_value = _mod.app_settings["use_torch_compile"]
            _mod.app_settings["use_torch_compile"] = bool(req.useTorchCompile)
            if old_value != _mod.app_settings["use_torch_compile"]:
                logger.info(f"Setting 'use_torch_compile' changed to: {_mod.app_settings['use_torch_compile']}")
                logger.info("Restart required for torch.compile changes to take effect")

        if req.loadOnStartup is not None:
            old_value = _mod.app_settings["load_on_startup"]
            _mod.app_settings["load_on_startup"] = bool(req.loadOnStartup)
            if old_value != _mod.app_settings["load_on_startup"]:
                logger.info(f"Setting 'load_on_startup' changed to: {_mod.app_settings['load_on_startup']}")
                logger.info("Restart required for this change to take effect")

        if req.ltxApiKey is not None:
            old_value = _mod.app_settings.get("ltx_api_key", "")
            _mod.app_settings["ltx_api_key"] = str(req.ltxApiKey)
            if old_value != _mod.app_settings["ltx_api_key"]:
                if _mod.app_settings["ltx_api_key"]:
                    logger.info("LTX API key configured - text encoding will use fast API (~1s)")
                else:
                    logger.info("LTX API key removed - text encoding will use local encoder (~23s)")

        if req.useLocalTextEncoder is not None:
            old_value = _mod.app_settings.get("use_local_text_encoder", False)
            _mod.app_settings["use_local_text_encoder"] = bool(req.useLocalTextEncoder)
            if old_value != _mod.app_settings["use_local_text_encoder"]:
                if _mod.app_settings["use_local_text_encoder"]:
                    logger.info("Switched to local text encoder")
                else:
                    logger.info("Switched to LTX API for text encoding")

        if req.fastModel is not None and isinstance(req.fastModel, dict):
            new_settings = {
                "use_upscaler": bool(req.fastModel.get("useUpscaler", True)),
            }
            if new_settings != _mod.app_settings["fast_model"]:
                _mod.app_settings["fast_model"] = new_settings
                logger.info(
                    f"Fast model settings updated: "
                    f"upscaler={'on' if new_settings['use_upscaler'] else 'off'}"
                )

        if req.proModel is not None and isinstance(req.proModel, dict):
            new_settings = {
                "steps": int(req.proModel.get("steps", 20)),
                "use_upscaler": bool(req.proModel.get("useUpscaler", True)),
            }
            if new_settings != _mod.app_settings["pro_model"]:
                _mod.app_settings["pro_model"] = new_settings
                logger.info(
                    f"Pro model settings updated: {new_settings['steps']} steps, "
                    f"upscaler={'on' if new_settings['use_upscaler'] else 'off'}"
                )

        if req.promptCacheSize is not None:
            new_size = max(0, min(1000, int(req.promptCacheSize)))
            if new_size != _mod.app_settings.get("prompt_cache_size", 100):
                _mod.app_settings["prompt_cache_size"] = new_size
                while len(_mod._prompt_embeddings_cache) > new_size:
                    oldest_key = next(iter(_mod._prompt_embeddings_cache))
                    del _mod._prompt_embeddings_cache[oldest_key]
                logger.info(f"Prompt cache size set to {new_size}")

        if req.promptEnhancerEnabledT2V is not None:
            old_value = _mod.app_settings.get("prompt_enhancer_enabled_t2v", True)
            _mod.app_settings["prompt_enhancer_enabled_t2v"] = bool(req.promptEnhancerEnabledT2V)
            if old_value != _mod.app_settings["prompt_enhancer_enabled_t2v"]:
                state = "enabled" if _mod.app_settings["prompt_enhancer_enabled_t2v"] else "disabled"
                logger.info(f"T2V prompt enhancer {state}")

        if req.promptEnhancerEnabledI2V is not None:
            old_value = _mod.app_settings.get("prompt_enhancer_enabled_i2v", False)
            _mod.app_settings["prompt_enhancer_enabled_i2v"] = bool(req.promptEnhancerEnabledI2V)
            if old_value != _mod.app_settings["prompt_enhancer_enabled_i2v"]:
                state = "enabled" if _mod.app_settings["prompt_enhancer_enabled_i2v"] else "disabled"
                logger.info(f"I2V prompt enhancer {state}")

        if req.geminiApiKey is not None:
            old_key = _mod.app_settings.get("gemini_api_key", "")
            _mod.app_settings["gemini_api_key"] = str(req.geminiApiKey)
            if old_key != _mod.app_settings["gemini_api_key"]:
                if _mod.app_settings["gemini_api_key"]:
                    logger.info("Gemini API key configured for prompt enhancement")
                else:
                    logger.info("Gemini API key removed")

        if req.t2vSystemPrompt is not None:
            _mod.app_settings["t2v_system_prompt"] = str(req.t2vSystemPrompt)
            logger.info("T2V system prompt updated")

        if req.i2vSystemPrompt is not None:
            _mod.app_settings["i2v_system_prompt"] = str(req.i2vSystemPrompt)
            logger.info("I2V system prompt updated")

        if req.seedLocked is not None:
            old_value = _mod.app_settings.get("seed_locked", False)
            _mod.app_settings["seed_locked"] = bool(req.seedLocked)
            if old_value != _mod.app_settings["seed_locked"]:
                if _mod.app_settings["seed_locked"]:
                    logger.info(f"Seed locked to {_mod.app_settings.get('locked_seed', 42)}")
                else:
                    logger.info("Seed unlocked (random)")

        if req.lockedSeed is not None:
            _mod.app_settings["locked_seed"] = int(req.lockedSeed)
            if _mod.app_settings.get("seed_locked", False):
                logger.info(f"Locked seed updated to {_mod.app_settings['locked_seed']}")

    _mod.save_settings()
    return {"status": "ok"}
