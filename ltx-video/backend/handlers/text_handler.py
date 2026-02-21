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
    def get_cached_prompt(self, prompt: str) -> TextEncodingResult | None:
        te = self.state.text_encoder
        if te is None:
            return None
        return te.prompt_cache.get(prompt.strip())

    @with_state_lock
    def cache_prompt(self, prompt: str, result: TextEncodingResult) -> None:
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
    def set_api_embeddings(self, result: TextEncodingResult | None) -> None:
        if self.state.text_encoder is not None:
            self.state.text_encoder.api_embeddings = result

    def clear_api_embeddings(self) -> None:
        self.set_api_embeddings(None)

    def resolve_gemma_root(self) -> str | None:
        settings = self.state.app_settings.model_copy(deep=True)
        text_encoder_dir = self._config.model_path("text_encoder")
        text_encoder_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())

        if (settings.use_local_text_encoder or not settings.ltx_api_key) and text_encoder_available:
            return str(self._config.models_dir)
        return None

    def prepare_api_embeddings(self, prompt: str) -> TextEncodingResult | None:
        settings = self.state.app_settings.model_copy(deep=True)
        if not settings.ltx_api_key or settings.use_local_text_encoder:
            self.clear_api_embeddings()
            return None

        cached = self.get_cached_prompt(prompt)
        if cached is not None:
            self.set_api_embeddings(cached)
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
            self.cache_prompt(prompt, encoded)
            self.set_api_embeddings(encoded)
        return encoded
