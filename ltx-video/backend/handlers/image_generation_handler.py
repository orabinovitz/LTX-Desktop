"""Image generation and editing orchestration handler."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime
from io import BytesIO
from pathlib import Path
from threading import RLock

from PIL import Image

from api_types import GenerateImageRequest, GenerateImageResponse
from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from handlers.generation_handler import GenerationHandler
from handlers.pipelines_handler import PipelinesHandler
from state.app_state_types import AppState

logger = logging.getLogger(__name__)

MultipartForm = dict[str, list[bytes]]


class ImageGenerationHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        generation_handler: GenerationHandler,
        pipelines_handler: PipelinesHandler,
        outputs_dir: Path,
    ) -> None:
        super().__init__(state, lock)
        self._generation = generation_handler
        self._pipelines = pipelines_handler
        self._outputs_dir = outputs_dir

    def generate(self, req: GenerateImageRequest) -> GenerateImageResponse:
        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        width = (req.width // 16) * 16
        height = (req.height // 16) * 16
        num_images = max(1, min(12, req.numImages))

        generation_id = uuid.uuid4().hex[:8]
        settings = self.state.app_settings.model_copy(deep=True)
        if settings.seed_locked:
            seed = settings.locked_seed
            logger.info("Using locked seed for image: %s", seed)
        else:
            seed = int(time.time()) % 2147483647

        try:
            self._pipelines.load_flux_to_gpu()
            self._generation.start_generation(generation_id)
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
            logger.exception("Image generation failed")
            raise HTTPError(500, str(e))

    def edit(self, form: MultipartForm) -> GenerateImageResponse:
        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        def get_form_value(key: str, default: str) -> str:
            raw = form.get(key, [default.encode()])[0]
            return raw.decode()

        prompt = get_form_value("prompt", "Edit this image")
        width = int(get_form_value("width", "1024"))
        height = int(get_form_value("height", "1024"))
        num_steps = int(get_form_value("numSteps", "4"))

        width = (width // 16) * 16
        height = (height // 16) * 16

        input_images: list[Image.Image] = []
        image_data = form.get("image", [b""])[0]
        if image_data:
            input_images.append(Image.open(BytesIO(image_data)).convert("RGB"))

        for i in range(2, 9):
            extra_data = form.get(f"image{i}", [b""])[0]
            if extra_data:
                input_images.append(Image.open(BytesIO(extra_data)).convert("RGB"))

        if not input_images:
            raise HTTPError(400, "At least one input image is required for editing")

        logger.info("Image edit request: %s reference(s), %sx%s, %s steps", len(input_images), width, height, num_steps)

        generation_id = uuid.uuid4().hex[:8]
        settings = self.state.app_settings.model_copy(deep=True)
        if settings.seed_locked:
            seed = settings.locked_seed
            logger.info("Using locked seed for edit: %s", seed)
        else:
            seed = int(time.time()) % 2147483647

        try:
            self._pipelines.load_flux_to_gpu()
            self._generation.start_generation(generation_id)
            output_paths = self.edit_image(
                prompt=prompt,
                input_images=input_images,
                width=width,
                height=height,
                num_inference_steps=num_steps,
                seed=seed,
            )
            self._generation.complete_generation(output_paths)
            return GenerateImageResponse(status="complete", image_paths=output_paths)
        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Image edit cancelled by user")
                return GenerateImageResponse(status="cancelled")
            logger.exception("Image edit failed")
            raise HTTPError(500, str(e))

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
        flux = self._pipelines.load_flux_to_gpu()
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

            result = flux.generate(
                prompt=prompt,
                height=height,
                width=width,
                guidance_scale=1.0,
                num_inference_steps=num_inference_steps,
                seed=seed + i,
            )

            output_path = self._outputs_dir / f"flux_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
            result.images[0].save(str(output_path))
            outputs.append(str(output_path))

        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        self._generation.update_progress("complete", 100, num_images, num_images)
        return outputs

    def edit_image(
        self,
        prompt: str,
        input_images: list[Image.Image],
        width: int,
        height: int,
        num_inference_steps: int,
        seed: int | None,
    ) -> list[str]:
        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        self._generation.update_progress("loading_model", 5, 0, num_inference_steps)
        flux = self._pipelines.load_flux_to_gpu()
        self._generation.update_progress("inference", 15, 0, num_inference_steps)

        if seed is None:
            seed = int(time.time()) % 2147483647

        image_input: Image.Image | list[Image.Image] = input_images if len(input_images) > 1 else input_images[0]
        result = flux.generate_edit(
            prompt=prompt,
            image=image_input,
            height=height,
            width=width,
            guidance_scale=1.0,
            num_inference_steps=num_inference_steps,
            seed=seed,
        )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = self._outputs_dir / f"flux_edit_{timestamp}_{uuid.uuid4().hex[:8]}.png"
        result.images[0].save(str(output_path))

        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        self._generation.update_progress("complete", 100, 1, 1)
        return [str(output_path)]
