"""Image generation orchestration handler."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING

from _routes._errors import HTTPError
from api_types import GenerateImageRequest, GenerateImageResponse
from handlers.base import StateHandlerBase
from handlers.generation_handler import GenerationHandler
from handlers.pipelines_handler import PipelinesHandler
from services.interfaces import NanoBanana2APIClient, ZitAPIClient
from state.app_state_types import AppState

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)


class ImageGenerationHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        generation_handler: GenerationHandler,
        pipelines_handler: PipelinesHandler,
        config: RuntimeConfig,
        zit_api_client: ZitAPIClient,
        nano_banana_2_api_client: NanoBanana2APIClient,
    ) -> None:
        super().__init__(state, lock, config)
        self._generation = generation_handler
        self._pipelines = pipelines_handler
        self._zit_api_client = zit_api_client
        self._nb2_api_client = nano_banana_2_api_client

    def generate(self, req: GenerateImageRequest) -> GenerateImageResponse:
        width = (req.width // 16) * 16
        height = (req.height // 16) * 16
        num_images = max(1, min(12, req.numImages))

        settings = self.state.app_settings.model_copy(deep=True)
        if settings.seed_locked:
            seed = settings.locked_seed
            logger.info("Using locked seed for image: %s", seed)
        else:
            seed = int(time.time()) % 2147483647

        if req.model == "nano-banana-2":
            return self._generate_via_nb2_api(
                prompt=req.prompt,
                aspect_ratio=req.aspectRatio or "16:9",
                resolution=req.resolution or "1K",
                seed=seed,
                num_images=num_images,
                image_urls=req.imageUrls,
            )

        if self.config.force_api_generations:
            return self._generate_via_zit_api(
                prompt=req.prompt,
                width=width,
                height=height,
                num_inference_steps=req.numSteps,
                seed=seed,
                num_images=num_images,
            )

        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        try:
            self._pipelines.load_zit_to_gpu()
            self._generation.start_generation(uuid.uuid4().hex[:8])
            output_paths = self.generate_image(
                prompt=req.prompt,
                width=width,
                height=height,
                num_inference_steps=req.numSteps,
                seed=seed,
                num_images=num_images,
            )
            self._generation.complete_generation(output_paths)
            return GenerateImageResponse(status="complete", image_paths=output_paths)
        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Image generation cancelled by user")
                return GenerateImageResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e

    def generate_image(
        self,
        prompt: str,
        width: int,
        height: int,
        num_inference_steps: int,
        seed: int | None,
        num_images: int,
    ) -> list[str]:
        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        self._generation.update_progress("loading_model", 5, 0, num_inference_steps)
        zit = self._pipelines.load_zit_to_gpu()
        self._generation.update_progress("inference", 15, 0, num_inference_steps)

        if seed is None:
            seed = int(time.time()) % 2147483647

        outputs: list[str] = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        for i in range(num_images):
            if self._generation.is_generation_cancelled():
                raise RuntimeError("Generation was cancelled")

            progress = 15 + int((i / num_images) * 80)
            self._generation.update_progress("inference", progress, i, num_images)

            result = zit.generate(
                prompt=prompt,
                height=height,
                width=width,
                guidance_scale=0.0,
                num_inference_steps=num_inference_steps,
                seed=seed + i,
            )

            output_path = self.config.outputs_dir / f"zit_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
            result.images[0].save(str(output_path))
            outputs.append(str(output_path))

        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        self._generation.update_progress("complete", 100, num_images, num_images)
        return outputs

    def _generate_via_nb2_api(
        self,
        *,
        prompt: str,
        aspect_ratio: str,
        resolution: str,
        seed: int,
        num_images: int,
        image_urls: list[str] | None,
    ) -> GenerateImageResponse:
        """Generate images via the FAL NB2 API.

        Unlike GPU and ZIT-API paths, this does NOT use the shared
        single-slot generation state (start/complete/fail) because
        multiple NB2 requests run concurrently and would overwrite
        each other.  Cancellation is still honoured via the global
        cancellation flag.
        """
        output_paths: list[Path] = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        settings = self.state.app_settings.model_copy(deep=True)
        has_images = bool(image_urls)

        if not settings.fal_api_key.strip():
            raise HTTPError(500, "FAL_API_KEY_NOT_CONFIGURED")

        try:
            for idx in range(num_images):
                if self._generation.is_generation_cancelled():
                    raise RuntimeError("Generation was cancelled")

                if has_images:
                    image_bytes = self._nb2_api_client.edit_images(
                        api_key=settings.fal_api_key,
                        prompt=prompt,
                        image_urls=image_urls or [],
                        aspect_ratio=aspect_ratio,
                        resolution=resolution,
                        seed=seed + idx,
                    )
                else:
                    image_bytes = self._nb2_api_client.generate_text_to_image(
                        api_key=settings.fal_api_key,
                        prompt=prompt,
                        aspect_ratio=aspect_ratio,
                        resolution=resolution,
                        seed=seed + idx,
                    )

                if self._generation.is_generation_cancelled():
                    raise RuntimeError("Generation was cancelled")

                output_path = self.config.outputs_dir / f"nb2_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
                output_path.write_bytes(image_bytes)
                output_paths.append(output_path)

            return GenerateImageResponse(status="complete", image_paths=[str(p) for p in output_paths])
        except Exception as e:
            if "cancelled" in str(e).lower():
                for path in output_paths:
                    path.unlink(missing_ok=True)
                logger.info("NB2 image generation cancelled by user")
                return GenerateImageResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e

    def _generate_via_zit_api(
        self,
        *,
        prompt: str,
        width: int,
        height: int,
        num_inference_steps: int,
        seed: int,
        num_images: int,
    ) -> GenerateImageResponse:
        generation_id = uuid.uuid4().hex[:8]
        output_paths: list[Path] = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        settings = self.state.app_settings.model_copy(deep=True)

        try:
            self._generation.start_api_generation(generation_id)
            self._generation.update_progress("validating_request", 5, None, None)

            if not settings.fal_api_key.strip():
                raise HTTPError(500, "FAL_API_KEY_NOT_CONFIGURED")

            for idx in range(num_images):
                if self._generation.is_generation_cancelled():
                    raise RuntimeError("Generation was cancelled")

                inference_progress = 15 + int((idx / num_images) * 60)
                self._generation.update_progress("inference", inference_progress, None, None)
                image_bytes = self._zit_api_client.generate_text_to_image(
                    api_key=settings.fal_api_key,
                    prompt=prompt,
                    width=width,
                    height=height,
                    seed=seed + idx,
                    num_inference_steps=num_inference_steps,
                )

                if self._generation.is_generation_cancelled():
                    raise RuntimeError("Generation was cancelled")

                download_progress = 75 + int(((idx + 1) / num_images) * 20)
                self._generation.update_progress("downloading_output", download_progress, None, None)

                output_path = self.config.outputs_dir / f"zit_api_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
                output_path.write_bytes(image_bytes)
                output_paths.append(output_path)

            self._generation.update_progress("complete", 100, None, None)
            self._generation.complete_generation([str(path) for path in output_paths])
            return GenerateImageResponse(status="complete", image_paths=[str(path) for path in output_paths])
        except HTTPError as e:
            self._generation.fail_generation(e.detail)
            raise
        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                for path in output_paths:
                    path.unlink(missing_ok=True)
                logger.info("Image generation cancelled by user")
                return GenerateImageResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e
