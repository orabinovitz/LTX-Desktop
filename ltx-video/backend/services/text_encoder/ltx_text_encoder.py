"""Text encoder patching and API embedding service."""

from __future__ import annotations

import io
import logging
import pickle
import time
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Protocol, cast

import torch

from services.http_client.http_client_impl import HTTPClientImpl
from services.services_utils import DeviceLike, PromptInput, TensorOrNone, sync_device
from state.app_state_types import CachedTextEncoder, TextEncodingResult

if TYPE_CHECKING:
    from state.app_state_types import AppState

logger = logging.getLogger(__name__)


class StateCarrier(Protocol):
    state: "AppState"


class LTXTextEncoder:
    """Stateless text encoding operations with idempotent monkey-patching."""

    def __init__(self, device: DeviceLike, http: HTTPClientImpl, ltx_api_base_url: str) -> None:
        self.device = device
        self.http = http
        self.ltx_api_base_url = ltx_api_base_url
        self._model_ledger_patched = False
        self._encode_text_patched = False

    def install_patches(self, state_getter: Callable[[], StateCarrier]) -> None:
        self._install_model_ledger_patch(state_getter)
        self._install_encode_text_patch(state_getter)

    def _install_model_ledger_patch(self, state_getter: Callable[[], StateCarrier]) -> None:
        if self._model_ledger_patched:
            return

        try:
            from ltx_pipelines.utils import ModelLedger
            from ltx_pipelines.utils import helpers as ltx_utils

            original_text_encoder = ModelLedger.text_encoder
            original_cleanup_memory = ltx_utils.cleanup_memory

            def patched_text_encoder(this: object) -> CachedTextEncoder | DummyTextEncoder:
                state = state_getter()
                te_state = state.state.text_encoder
                if te_state is None:
                    return cast(CachedTextEncoder, original_text_encoder(this))

                if te_state.api_embeddings is not None:
                    return DummyTextEncoder()

                if te_state.cached_encoder is not None:
                    try:
                        te_state.cached_encoder.to(self.device)
                        sync_device(self.device)
                    except Exception:
                        logger.warning("Failed to move cached text encoder to %s", self.device, exc_info=True)
                    return te_state.cached_encoder

                te_state.cached_encoder = cast(CachedTextEncoder, original_text_encoder(this))
                return te_state.cached_encoder

            def patched_cleanup_memory() -> None:
                state = state_getter()
                te_state = state.state.text_encoder
                if te_state is not None and te_state.cached_encoder is not None:
                    try:
                        te_state.cached_encoder.to("cpu")
                    except Exception:
                        logger.warning("Failed to move cached text encoder to CPU", exc_info=True)
                original_cleanup_memory()

            ModelLedger.text_encoder = patched_text_encoder
            ltx_utils.cleanup_memory = patched_cleanup_memory
            self._model_ledger_patched = True
            logger.info("Installed ModelLedger text encoder patch")
        except Exception as exc:
            logger.warning("Failed to patch ModelLedger: %s", exc, exc_info=True)

    def _install_encode_text_patch(self, state_getter: Callable[[], StateCarrier]) -> None:
        if self._encode_text_patched:
            return

        try:
            from ltx_core.text_encoders import gemma as text_enc_module
            from ltx_pipelines import distilled as distilled_module

            original_encode_text = text_enc_module.encode_text

            def patched_encode_text(
                text_encoder: CachedTextEncoder | DummyTextEncoder,
                prompts: PromptInput,
                *args: object,
                **kwargs: object,
            ) -> list[tuple[torch.Tensor, TensorOrNone]]:
                state = state_getter()
                te_state = state.state.text_encoder
                if te_state is not None and te_state.api_embeddings is not None:
                    video_context = te_state.api_embeddings.video_context
                    audio_context = te_state.api_embeddings.audio_context
                    num_prompts = len(prompts) if isinstance(prompts, Sequence) and not isinstance(prompts, str) else 1
                    out: list[tuple[torch.Tensor, TensorOrNone]] = []
                    for i in range(num_prompts):
                        if i == 0:
                            out.append((video_context, audio_context))
                        else:
                            zero_video = torch.zeros_like(video_context)
                            zero_audio = torch.zeros_like(audio_context) if audio_context is not None else None
                            out.append((zero_video, zero_audio))
                    return out

                return cast(
                    list[tuple[torch.Tensor, TensorOrNone]],
                    original_encode_text(text_encoder, prompts, *args, **kwargs),
                )

            text_enc_module.encode_text = patched_encode_text
            distilled_module.encode_text = patched_encode_text

            for module_name in (
                "ltx_pipelines.ti2vid_one_stage",
                "ltx_pipelines.ti2vid_two_stages",
                "ltx_pipelines.ic_lora",
            ):
                try:
                    module = __import__(module_name, fromlist=["encode_text"])
                    module.encode_text = patched_encode_text
                except Exception:
                    logger.warning("Failed to patch encode_text for module %s", module_name, exc_info=True)

            self._encode_text_patched = True
            logger.info("Installed encode_text API embeddings patch")
        except Exception as exc:
            logger.warning("Failed to patch encode_text: %s", exc, exc_info=True)

    def get_model_id_from_checkpoint(self, checkpoint_path: str) -> str | None:
        try:
            from safetensors import safe_open

            with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
                metadata = f.metadata()
                if metadata and "encrypted_wandb_properties" in metadata:
                    return metadata["encrypted_wandb_properties"]
        except Exception as exc:
            logger.warning("Could not extract model_id from checkpoint: %s", exc, exc_info=True)
        return None

    def encode_via_api(self, prompt: str, api_key: str, checkpoint_path: str) -> TextEncodingResult | None:
        model_id = self.get_model_id_from_checkpoint(checkpoint_path)
        if not model_id:
            return None

        try:
            start = time.time()
            response = self.http.post(
                f"{self.ltx_api_base_url}/v1/prompt-embedding",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json_payload={
                    "prompt": prompt,
                    "model_id": model_id,
                },
                timeout=60,
            )

            if response.status_code != 200:
                logger.warning("LTX API error %s: %s", response.status_code, response.text)
                return None

            conditioning = pickle.load(io.BytesIO(response.content))
            if not conditioning or len(conditioning) == 0:
                logger.warning("LTX API returned unexpected conditioning format")
                return None

            embeddings = conditioning[0][0]
            if embeddings.shape[-1] > 3840:
                video_context = embeddings[..., :3840].to(dtype=torch.bfloat16, device=self.device)
                audio_context = embeddings[..., 3840:].to(dtype=torch.bfloat16, device=self.device)
            else:
                video_context = embeddings.to(dtype=torch.bfloat16, device=self.device)
                audio_context = None

            logger.info("Text encoded via API in %.1fs", time.time() - start)
            return TextEncodingResult(video_context=video_context, audio_context=audio_context)

        except Exception as exc:
            logger.warning("LTX API encoding failed: %s", exc, exc_info=True)
            return None


class DummyTextEncoder:
    pass
