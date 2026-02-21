"""Video generation orchestration handler."""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, cast

from PIL import Image

from api_types import GenerateVideoRequest, GenerateVideoResponse
from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from handlers.generation_handler import GenerationHandler
from handlers.pipelines_handler import PipelinesHandler
from handlers.text_handler import TextHandler
from services.interfaces import (
    FastNativeVideoPipeline,
    FastVideoPipeline,
    ProNativeVideoPipeline,
    ProVideoPipeline,
    VideoPipelineModelType,
)
from state.app_state_types import AppState

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)


class VideoGenerationHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        generation_handler: GenerationHandler,
        pipelines_handler: PipelinesHandler,
        text_handler: TextHandler,
        outputs_dir: Path,
        config: RuntimeConfig,
        camera_motion_prompts: dict[str, str],
        default_negative_prompt: str,
    ) -> None:
        super().__init__(state, lock)
        self._generation = generation_handler
        self._pipelines = pipelines_handler
        self._text = text_handler
        self._outputs_dir = outputs_dir
        self._config = config
        self._camera_motion_prompts = camera_motion_prompts
        self._default_negative_prompt = default_negative_prompt

    def generate(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        resolution = req.resolution
        model_type = req.model

        duration = int(float(req.duration))
        fps = int(float(req.fps))

        use_upsampler = resolution == "1080p"
        if not use_upsampler:
            if model_type == "fast":
                model_type = "fast-native"
                logger.info("Resolution %s - using fast-native pipeline (no upsampler)", resolution)
            elif model_type == "pro":
                model_type = "pro-native"
                logger.info("Resolution %s - using pro-native pipeline (no upsampler)", resolution)
        else:
            logger.info("Resolution %s - using 2-stage pipeline with upsampler", resolution)

        resolution_map = {
            "540p": (960, 544),
            "720p": (1280, 704),
            "1080p": (960, 544),
        }
        width, height = resolution_map.get(resolution, (960, 544))

        num_frames = ((duration * fps) // 8) * 8 + 1
        if num_frames < 9:
            num_frames = 9

        image = None
        if req.imagePath:
            if not os.path.isfile(req.imagePath):
                raise HTTPError(400, f"Image file not found: {req.imagePath}")

            img = Image.open(req.imagePath).convert("RGB")
            img_w, img_h = img.size
            target_ratio = width / height
            img_ratio = img_w / img_h

            if img_ratio > target_ratio:
                new_h = height
                new_w = int(img_w * (height / img_h))
            else:
                new_w = width
                new_h = int(img_h * (width / img_w))

            resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
            left = (new_w - width) // 2
            top = (new_h - height) // 2
            image = resized.crop((left, top, left + width, top + height))
            logger.info("Image: %s %sx%s -> %sx%s", req.imagePath, img_w, img_h, width, height)

        generation_id = uuid.uuid4().hex[:8]

        settings = self.state.app_settings.model_copy(deep=True)
        if settings.seed_locked:
            seed = settings.locked_seed
            logger.info("Using locked seed: %s", seed)
        else:
            seed = int(time.time()) % 2147483647

        try:
            self._pipelines.load_gpu_pipeline(cast(VideoPipelineModelType, model_type), should_warm=False)
            self._generation.start_generation(generation_id)

            output_path = self.generate_video(
                prompt=req.prompt,
                image=image,
                height=height,
                width=width,
                num_frames=num_frames,
                fps=fps,
                seed=seed,
                model_type=cast(VideoPipelineModelType, model_type),
                camera_motion=req.cameraMotion,
                negative_prompt=req.negativePrompt,
            )

            self._generation.complete_generation(output_path)
            return GenerateVideoResponse(status="complete", video_path=output_path)

        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")

            raise HTTPError(500, str(e)) from e

    def generate_video(
        self,
        prompt: str,
        image: Image.Image | None,
        height: int,
        width: int,
        num_frames: int,
        fps: float,
        seed: int,
        model_type: VideoPipelineModelType,
        camera_motion: str,
        negative_prompt: str,
    ) -> str:
        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        if not self._config.model_path("checkpoint").exists():
            raise RuntimeError("Models not downloaded. Please download the AI models first using the Model Status menu.")

        total_steps = 8 if model_type in ("fast", "fast-native") else self.state.app_settings.pro_model.steps

        self._generation.update_progress("loading_model", 5, 0, total_steps)
        pipeline_state = self._pipelines.load_gpu_pipeline(model_type, should_warm=False)
        self._generation.update_progress("encoding_text", 10, 0, total_steps)

        enhanced_prompt = prompt + self._camera_motion_prompts.get(camera_motion, "")

        images: list[tuple[str, int, float]] = []
        temp_image_path: str | None = None
        if image is not None:
            temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
            image.save(temp_image_path)
            images = [(temp_image_path, 0, 1.0)]

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = self._outputs_dir / f"ltx2_video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"

        try:
            self._text.prepare_text_encoding(enhanced_prompt)

            self._generation.update_progress("inference", 15, 0, total_steps)

            divisor = 32 if model_type == "pro-native" else 64
            height = round(height / divisor) * divisor
            width = round(width / divisor) * divisor

            pro_steps = self.state.app_settings.pro_model.steps
            neg = negative_prompt if negative_prompt else self._default_negative_prompt

            if model_type in {"fast", "fast-native"}:
                fast_pipeline = cast(FastVideoPipeline | FastNativeVideoPipeline, pipeline_state.pipeline)
                fast_pipeline.generate(
                    prompt=enhanced_prompt,
                    seed=seed,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    frame_rate=fps,
                    images=images,
                    output_path=str(output_path),
                )
            else:
                pro_pipeline = cast(ProVideoPipeline | ProNativeVideoPipeline, pipeline_state.pipeline)
                pro_pipeline.generate(
                    prompt=enhanced_prompt,
                    negative_prompt=neg,
                    seed=seed,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    frame_rate=fps,
                    num_inference_steps=pro_steps,
                    images=images,
                    output_path=str(output_path),
                )

            if self._generation.is_generation_cancelled():
                if output_path.exists():
                    output_path.unlink()
                raise RuntimeError("Generation was cancelled")

            self._generation.update_progress("complete", 100, total_steps, total_steps)
            return str(output_path)
        finally:
            self._text.clear_api_embeddings()
            if temp_image_path and os.path.exists(temp_image_path):
                os.unlink(temp_image_path)
