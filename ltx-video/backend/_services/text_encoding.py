"""Text encoding via LTX API, model ledger patching, and prompt embedding caching."""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


class DummyTextEncoder:
    """Dummy text encoder returned when using API embeddings.

    The pipeline calls model_ledger.text_encoder() unconditionally,
    but when we have API embeddings, we don't need the real encoder.
    This dummy is passed to encode_text() which will use the API embeddings instead.
    """

    pass


def get_model_id_from_checkpoint_impl(checkpoint_path: str) -> str | None:
    """Extract the model_id from checkpoint metadata for LTX API."""
    try:
        from safetensors import safe_open

        with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
            metadata = f.metadata()
            if metadata and "encrypted_wandb_properties" in metadata:
                return metadata["encrypted_wandb_properties"]
    except Exception as e:
        logger.warning(f"Could not extract model_id from checkpoint: {e}")
    return None


def encode_text_via_api_impl(prompt: str, api_key: str, model_id: str) -> tuple[Any, Any] | None:
    """Encode text using the LTX API (free, ~1s instead of 23s local).

    Uses an in-memory cache to skip API calls for repeated prompts.

    Returns:
        Tuple of (video_context, audio_context) tensors, or None if failed
    """
    import ltx2_server as _mod
    import torch

    if not model_id:
        logger.warning("No model_id available for API encoding")
        return None

    cache_key = prompt.strip()
    if cache_key in _mod._prompt_embeddings_cache:
        logger.info("Using cached prompt embeddings (skipping API call)")
        return _mod._prompt_embeddings_cache[cache_key]

    try:
        logger.info("Encoding text via LTX API...")
        start = time.time()

        response = _mod.requests.post(
            f"{_mod.LTX_API_BASE_URL}/v1/prompt-embedding",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "prompt": prompt,
                "model_id": model_id,
            },
            timeout=60,
        )

        if response.status_code == 401:
            logger.warning("LTX API: Invalid API key")
            return None

        if response.status_code != 200:
            logger.warning(f"LTX API error {response.status_code}: {response.text}")
            return None

        import io
        import pickle

        conditioning = pickle.load(io.BytesIO(response.content))

        if conditioning and len(conditioning) > 0:
            embeddings = conditioning[0][0]
            if embeddings.shape[-1] > 3840:
                video_context = embeddings[..., :3840].to(dtype=torch.bfloat16, device=_mod.DEVICE)
                audio_context = embeddings[..., 3840:].to(dtype=torch.bfloat16, device=_mod.DEVICE)
            else:
                video_context = embeddings.to(dtype=torch.bfloat16, device=_mod.DEVICE)
                audio_context = None

            elapsed = time.time() - start
            logger.info(f"Text encoded via API in {elapsed:.1f}s")

            max_cache_size = _mod.app_settings.get("prompt_cache_size", 100)
            if max_cache_size > 0:
                if len(_mod._prompt_embeddings_cache) >= max_cache_size:
                    oldest_key = next(iter(_mod._prompt_embeddings_cache))
                    del _mod._prompt_embeddings_cache[oldest_key]

                _mod._prompt_embeddings_cache[cache_key] = (video_context, audio_context)
                logger.info(f"Cached prompt ({len(_mod._prompt_embeddings_cache)}/{max_cache_size})")

            return (video_context, audio_context)

        logger.warning("LTX API returned unexpected conditioning format")
        return None

    except Exception as e:
        logger.warning(f"LTX API encoding failed: {e}, falling back to local encoder")
        return None


def patch_model_ledger_class_impl() -> None:
    """Patch the ModelLedger class globally to support API embeddings and caching."""
    import ltx2_server as _mod
    import torch

    if _mod._model_ledger_patched:
        return

    try:
        from ltx_core.model.model_ledger import ModelLedger

        original_text_encoder = ModelLedger.text_encoder

        def patched_text_encoder(self: Any) -> Any:
            if _mod._api_embeddings is not None:
                logger.info("API embeddings set - returning dummy encoder (skipping load)")
                return DummyTextEncoder()

            if _mod.cached_text_encoder is not None:
                logger.info("Moving cached text encoder from CPU to GPU...")
                start = time.time()
                _mod.cached_text_encoder.to(_mod.DEVICE)
                torch.cuda.synchronize()
                logger.info(f"Text encoder ready in {time.time() - start:.1f}s (vs 23s from disk)")
                return _mod.cached_text_encoder

            logger.info("Loading text encoder from disk (first time, ~23s)...")
            _mod.cached_text_encoder = original_text_encoder(self)
            logger.info("Text encoder loaded and cached in CPU RAM")
            return _mod.cached_text_encoder

        ModelLedger.text_encoder = patched_text_encoder
        _mod._model_ledger_patched = True
        logger.info("ModelLedger.text_encoder patched globally for API embeddings support")

        from ltx_pipelines import utils as ltx_utils

        original_cleanup = ltx_utils.cleanup_memory

        def patched_cleanup_memory() -> None:
            if _mod.cached_text_encoder is not None:
                try:
                    _mod.cached_text_encoder.to("cpu")
                    logger.debug("Moved cached text encoder to CPU during cleanup")
                except Exception:
                    pass
            original_cleanup()

        ltx_utils.cleanup_memory = patched_cleanup_memory

    except Exception as e:
        logger.warning(f"Failed to patch ModelLedger class: {e}")


def patch_encode_text_for_api_impl() -> None:
    """Patch the encode_text function to use pre-computed API embeddings when available."""
    import ltx2_server as _mod
    import torch

    if _mod._encode_text_patched:
        return

    try:
        from ltx_pipelines import pipeline_utils
        from ltx_pipelines import distilled as distilled_module

        original_encode_text = pipeline_utils.encode_text

        def patched_encode_text(text_encoder: Any, prompts: Any, *args: Any, **kwargs: Any) -> list[tuple[Any, Any]]:
            if _mod._api_embeddings is not None:
                video_context, audio_context = _mod._api_embeddings
                logger.info("Using API embeddings (patched encode_text)")
                num_prompts = len(prompts) if isinstance(prompts, list) else 1
                results: list[tuple[Any, Any]] = []
                for i in range(num_prompts):
                    if i == 0:
                        results.append((video_context, audio_context))
                    else:
                        zero_video = torch.zeros_like(video_context)
                        zero_audio = torch.zeros_like(audio_context) if audio_context is not None else None
                        results.append((zero_video, zero_audio))
                return results
            return original_encode_text(text_encoder, prompts, *args, **kwargs)

        pipeline_utils.encode_text = patched_encode_text
        distilled_module.encode_text = patched_encode_text

        try:
            from ltx_pipelines import ti2vid_one_stage as one_stage_module
            one_stage_module.encode_text = patched_encode_text
        except ImportError:
            pass

        try:
            from ltx_pipelines import ti2vid_two_stages as two_stages_module
            two_stages_module.encode_text = patched_encode_text
        except ImportError:
            pass

        try:
            from ltx_pipelines import ic_lora as ic_lora_module
            ic_lora_module.encode_text = patched_encode_text
        except ImportError:
            pass

        _mod._encode_text_patched = True
        logger.info("Patched encode_text for API embeddings injection (all pipeline modules)")
    except Exception as e:
        logger.warning(f"Could not patch encode_text: {e}")
