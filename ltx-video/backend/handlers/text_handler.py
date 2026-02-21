"""Text encoding cache and API embedding handler."""

from __future__ import annotations

from threading import RLock
from typing import TYPE_CHECKING

from handlers.base import StateHandlerBase, with_state_lock
from state.app_state_types import AppState, TextEncodingResult

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig


class TextHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, config: RuntimeConfig) -> None:
        super().__init__(state, lock)
        self._config = config

    @with_state_lock
    def _get_cached_prompt(self, prompt: str) -> TextEncodingResult | None:
        te = self.state.text_encoder
        if te is None:
            return None
        return te.prompt_cache.get(prompt.strip())

    @with_state_lock
    def _cache_prompt(self, prompt: str, result: TextEncodingResult) -> None:
        te = self.state.text_encoder
        if te is None:
            return

        max_size = self.state.app_settings.prompt_cache_size
        if max_size <= 0:
            return

        key = prompt.strip()
        if key in te.prompt_cache:
            del te.prompt_cache[key]
        elif len(te.prompt_cache) >= max_size:
            oldest = next(iter(te.prompt_cache))
            del te.prompt_cache[oldest]
        te.prompt_cache[key] = result

    @with_state_lock
    def _set_api_embeddings(self, result: TextEncodingResult | None) -> None:
        if self.state.text_encoder is not None:
            self.state.text_encoder.api_embeddings = result

    def clear_api_embeddings(self) -> None:
        self._set_api_embeddings(None)

    def prepare_text_encoding(self, prompt: str) -> None:
        """Validate settings and prepare text embeddings for a generation run.

        Raises RuntimeError with a prefixed message if text encoding is
        misconfigured, the local encoder is missing, or API encoding fails
        with no local fallback.
        """
        settings = self.state.app_settings.model_copy(deep=True)

        if not settings.use_local_text_encoder and not settings.ltx_api_key:
            raise RuntimeError(
                "TEXT_ENCODING_NOT_CONFIGURED: To generate videos, you need to configure text encoding. "
                "Either enter an LTX API Key in Settings, or enable the Local Text Encoder."
            )

        if settings.use_local_text_encoder:
            text_encoder_path = self._config.model_path("text_encoder")
            if not text_encoder_path.exists() or not any(text_encoder_path.iterdir()):
                raise RuntimeError(
                    "TEXT_ENCODER_NOT_DOWNLOADED: Local text encoder is enabled but not downloaded. "
                    "Please download it from Settings (~8 GB), or switch to using the LTX API."
                )

        gemma_root = self.resolve_gemma_root()
        embeddings = self._prepare_api_embeddings(prompt)

        if settings.ltx_api_key and not settings.use_local_text_encoder and embeddings is None and gemma_root is None:
            raise RuntimeError(
                "LTX API text encoding failed and local text encoder is not available. "
                "Please download the text encoder from Settings or check your API key."
            )

    def resolve_gemma_root(self) -> str | None:
        settings = self.state.app_settings.model_copy(deep=True)
        text_encoder_dir = self._config.model_path("text_encoder")
        text_encoder_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())

        if (settings.use_local_text_encoder or not settings.ltx_api_key) and text_encoder_available:
            return str(self._config.models_dir)
        return None

    def _prepare_api_embeddings(self, prompt: str) -> TextEncodingResult | None:
        settings = self.state.app_settings.model_copy(deep=True)
        if not settings.ltx_api_key or settings.use_local_text_encoder:
            self.clear_api_embeddings()
            return None

        cached = self._get_cached_prompt(prompt)
        if cached is not None:
            self._set_api_embeddings(cached)
            return cached

        te = self.state.text_encoder
        if te is None:
            return None

        encoded = te.service.encode_via_api(
            prompt=prompt,
            api_key=settings.ltx_api_key,
            checkpoint_path=str(self._config.model_path("checkpoint")),
        )
        if encoded is not None:
            self._cache_prompt(prompt, encoded)
            self._set_api_embeddings(encoded)
        return encoded
