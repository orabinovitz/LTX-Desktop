"""Video generation orchestration handler."""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from threading import BoundedSemaphore, RLock
from typing import TYPE_CHECKING

from PIL import Image

from api_types import (
    GenerateVideoRequest,
    GenerateVideoResponse,
    GenerationBatchResponse,
    GenerationBatchStatusResponse,
    GenerationJobResponse,
    GenerationJobStatusResponse,
    ImageConditioningInput,
    VideoCameraMotion,
)
from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from handlers.generation_handler import GenerationHandler
from handlers.pipelines_handler import PipelinesHandler
from handlers.text_handler import TextHandler
from runtime_config.model_download_specs import resolve_model_path
from server_utils.media_validation import (
    normalize_optional_path,
    validate_audio_file,
    validate_image_file,
)
from services.interfaces import LTXAPIClient, TaskRunner
from state.app_state_types import AppState, GenerationCancelled, GenerationComplete, GenerationError, GenerationQueued, GenerationRunning
from state.app_settings import should_video_generate_with_ltx_api

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)

FORCED_API_MODEL_MAP: dict[str, str] = {
    "fast": "ltx-2-3-fast",
    "pro": "ltx-2-3-pro",
}
FORCED_API_RESOLUTION_MAP: dict[str, dict[str, str]] = {
    "1080p": {"16:9": "1920x1080", "9:16": "1080x1920"},
    "1440p": {"16:9": "2560x1440", "9:16": "1440x2560"},
    "2160p": {"16:9": "3840x2160", "9:16": "2160x3840"},
}
A2V_FORCED_API_RESOLUTION = "1920x1080"
FORCED_API_ALLOWED_ASPECT_RATIOS = {"16:9", "9:16"}
FORCED_API_ALLOWED_FPS = {24, 25, 48, 50}
MAX_PARALLEL_API_GENERATIONS = 10
API_GENERATION_WAIT_POLL_SECONDS = 0.05


def _get_allowed_durations(model_id: str, resolution_label: str, fps: int) -> set[int]:
    if model_id == "ltx-2-3-fast" and resolution_label == "1080p" and fps in {24, 25}:
        return {6, 8, 10, 12, 14, 16, 18, 20}
    return {6, 8, 10}


class VideoGenerationHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        generation_handler: GenerationHandler,
        task_runner: TaskRunner,
        pipelines_handler: PipelinesHandler,
        text_handler: TextHandler,
        ltx_api_client: LTXAPIClient,
        config: RuntimeConfig,
    ) -> None:
        super().__init__(state, lock, config)
        self._generation = generation_handler
        self._task_runner = task_runner
        self._pipelines = pipelines_handler
        self._text = text_handler
        self._ltx_api_client = ltx_api_client
        self._api_generation_semaphore = BoundedSemaphore(value=MAX_PARALLEL_API_GENERATIONS)

    def generate(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        if should_video_generate_with_ltx_api(
            force_api_generations=self.config.force_api_generations,
            settings=self.state.app_settings,
        ):
            return self._generate_forced_api(req)

        if self._generation.is_generation_running():
            raise HTTPError(409, "Generation already in progress")

        resolution = req.resolution

        duration = int(float(req.duration))
        fps = int(float(req.fps))

        audio_path = normalize_optional_path(req.audioPath)
        if audio_path:
            return self._generate_a2v(req, duration, fps, audio_path=audio_path)

        logger.info("Resolution %s - using fast pipeline", resolution)

        RESOLUTION_MAP_16_9: dict[str, tuple[int, int]] = {
            "540p": (960, 544),
            "720p": (1280, 704),
            "1080p": (1920, 1088),
        }

        def get_16_9_size(res: str) -> tuple[int, int]:
            return RESOLUTION_MAP_16_9.get(res, (960, 544))

        def get_9_16_size(res: str) -> tuple[int, int]:
            w, h = get_16_9_size(res)
            return h, w

        match req.aspectRatio:
            case "9:16":
                width, height = get_9_16_size(resolution)
            case "16:9":
                width, height = get_16_9_size(resolution)

        num_frames = self._compute_num_frames(duration, fps)

        image = None
        image_path = normalize_optional_path(req.imagePath)
        if image_path:
            image = self._prepare_image(image_path, width, height)
            logger.info("Image: %s -> %sx%s", image_path, width, height)

        generation_id = self._make_generation_id()
        seed = self._resolve_seed()

        try:
            self._pipelines.load_gpu_pipeline("fast", should_warm=False)
            self._generation.start_generation(generation_id)

            output_path = self.generate_video(
                prompt=req.prompt,
                image=image,
                height=height,
                width=width,
                num_frames=num_frames,
                fps=fps,
                seed=seed,
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

    def submit_async_generation(self, req: GenerateVideoRequest, *, batch_id: str | None = None) -> GenerationJobResponse:
        if not should_video_generate_with_ltx_api(
            force_api_generations=self.config.force_api_generations,
            settings=self.state.app_settings,
        ):
            raise HTTPError(400, "ASYNC_API_GENERATIONS_REQUIRE_LTX_API")

        generation_id = self._make_generation_id()
        self._generation.queue_api_generation(generation_id, batch_id=batch_id)
        self._task_runner.run_background(
            lambda: self._run_async_api_generation_worker(generation_id, req, batch_id=batch_id),
            task_name=f"ltx-api-generation-{generation_id}",
            daemon=True,
        )
        return GenerationJobResponse(status="queued", generationId=generation_id, batchId=batch_id)

    def submit_generation_batch(self, requests: list[GenerateVideoRequest]) -> GenerationBatchResponse:
        if not should_video_generate_with_ltx_api(
            force_api_generations=self.config.force_api_generations,
            settings=self.state.app_settings,
        ):
            raise HTTPError(400, "ASYNC_API_GENERATIONS_REQUIRE_LTX_API")
        if not 1 <= len(requests) <= MAX_PARALLEL_API_GENERATIONS:
            raise HTTPError(400, f"BATCH_SIZE_MUST_BE_BETWEEN_1_AND_{MAX_PARALLEL_API_GENERATIONS}")

        batch_id = f"batch-{self._make_generation_id()}"
        generation_ids = [self._make_generation_id() for _ in requests]
        self._generation.start_api_batch(batch_id, generation_ids)

        for generation_id, request in zip(generation_ids, requests, strict=True):
            self._generation.queue_api_generation(generation_id, batch_id=batch_id)
            self._task_runner.run_background(
                lambda generation_id=generation_id, request=request: self._run_async_api_generation_worker(
                    generation_id,
                    request,
                    batch_id=batch_id,
                ),
                task_name=f"ltx-api-generation-{generation_id}",
                daemon=True,
            )

        return GenerationBatchResponse(status="queued", batchId=batch_id, generationIds=generation_ids)

    def get_async_generation_status(self, generation_id: str) -> GenerationJobStatusResponse:
        state = self._generation.get_api_generation_state(generation_id)
        if state is None:
            raise HTTPError(404, "GENERATION_NOT_FOUND")
        return self._build_generation_status_response(
            generation_id,
            state,
            batch_id=self._generation.get_api_generation_batch_id(generation_id),
        )

    def get_generation_batch_status(self, batch_id: str) -> GenerationBatchStatusResponse:
        generation_ids = self._generation.get_api_batch_generation_ids(batch_id)
        if generation_ids is None:
            raise HTTPError(404, "GENERATION_BATCH_NOT_FOUND")

        jobs = [self.get_async_generation_status(generation_id) for generation_id in generation_ids]
        queued_jobs = sum(job.status == "queued" for job in jobs)
        running_jobs = sum(job.status == "running" for job in jobs)
        completed_jobs = sum(job.status == "complete" for job in jobs)
        failed_jobs = sum(job.status == "error" for job in jobs)
        cancelled_jobs = sum(job.status == "cancelled" for job in jobs)

        if completed_jobs == len(jobs):
            status = "complete"
        elif failed_jobs == len(jobs):
            status = "error"
        elif cancelled_jobs == len(jobs):
            status = "cancelled"
        elif failed_jobs > 0:
            status = "partial_error"
        elif running_jobs > 0 or queued_jobs > 0:
            status = "running"
        else:
            status = "idle"

        return GenerationBatchStatusResponse(
            batchId=batch_id,
            status=status,
            totalJobs=len(jobs),
            queuedJobs=queued_jobs,
            runningJobs=running_jobs,
            completedJobs=completed_jobs,
            failedJobs=failed_jobs,
            cancelledJobs=cancelled_jobs,
            jobs=jobs,
        )

    def generate_video(
        self,
        prompt: str,
        image: Image.Image | None,
        height: int,
        width: int,
        num_frames: int,
        fps: float,
        seed: int,
        camera_motion: VideoCameraMotion,
        negative_prompt: str,
    ) -> str:
        t_total_start = time.perf_counter()
        gen_mode = "i2v" if image is not None else "t2v"
        logger.info("[%s] Generation started (model=fast, %dx%d, %d frames, %d fps)", gen_mode, width, height, num_frames, int(fps))

        if self._generation.is_generation_cancelled():
            raise RuntimeError("Generation was cancelled")

        if not resolve_model_path(self.models_dir, self.config.model_download_specs,"checkpoint").exists():
            raise RuntimeError("Models not downloaded. Please download the AI models first using the Model Status menu.")

        total_steps = 8

        self._generation.update_progress("loading_model", 5, 0, total_steps)
        t_load_start = time.perf_counter()
        pipeline_state = self._pipelines.load_gpu_pipeline("fast", should_warm=False)
        t_load_end = time.perf_counter()
        logger.info("[%s] Pipeline load: %.2fs", gen_mode, t_load_end - t_load_start)

        self._generation.update_progress("encoding_text", 10, 0, total_steps)

        enhanced_prompt = prompt + self.config.camera_motion_prompts.get(camera_motion, "")

        images: list[ImageConditioningInput] = []
        temp_image_path: str | None = None
        if image is not None:
            temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
            image.save(temp_image_path)
            images = [ImageConditioningInput(path=temp_image_path, frame_idx=0, strength=1.0)]

        output_path = self._make_output_path()

        try:
            settings = self.state.app_settings
            use_api_encoding = not self._text.should_use_local_encoding()
            if image is not None:
                enhance = use_api_encoding and settings.prompt_enhancer_enabled_i2v
            else:
                enhance = use_api_encoding and settings.prompt_enhancer_enabled_t2v

            encoding_method = "api" if use_api_encoding else "local"
            t_text_start = time.perf_counter()
            self._text.prepare_text_encoding(enhanced_prompt, enhance_prompt=enhance)
            t_text_end = time.perf_counter()
            logger.info("[%s] Text encoding (%s): %.2fs", gen_mode, encoding_method, t_text_end - t_text_start)

            self._generation.update_progress("inference", 15, 0, total_steps)

            height = round(height / 64) * 64
            width = round(width / 64) * 64

            t_inference_start = time.perf_counter()
            pipeline_state.pipeline.generate(
                prompt=enhanced_prompt,
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                images=images,
                output_path=str(output_path),
            )
            t_inference_end = time.perf_counter()
            logger.info("[%s] Inference: %.2fs", gen_mode, t_inference_end - t_inference_start)

            if self._generation.is_generation_cancelled():
                if output_path.exists():
                    output_path.unlink()
                raise RuntimeError("Generation was cancelled")

            t_total_end = time.perf_counter()
            logger.info("[%s] Total generation: %.2fs (load=%.2fs, text=%.2fs, inference=%.2fs)",
                        gen_mode, t_total_end - t_total_start,
                        t_load_end - t_load_start, t_text_end - t_text_start, t_inference_end - t_inference_start)

            self._generation.update_progress("complete", 100, total_steps, total_steps)
            return str(output_path)
        finally:
            self._text.clear_api_embeddings()
            if temp_image_path and os.path.exists(temp_image_path):
                os.unlink(temp_image_path)

    def _generate_a2v(
        self, req: GenerateVideoRequest, duration: int, fps: int, *, audio_path: str
    ) -> GenerateVideoResponse:
        if req.model != "pro":
            logger.warning("A2V local requested with model=%s; A2V always uses pro pipeline", req.model)
        validated_audio_path = validate_audio_file(audio_path)
        audio_path_str = str(validated_audio_path)

        RESOLUTION_MAP: dict[str, tuple[int, int]] = {
            "540p": (960, 576),
            "720p": (1280, 704),
            "1080p": (1920, 1088),
        }
        width, height = RESOLUTION_MAP.get(req.resolution, (960, 576))

        num_frames = self._compute_num_frames(duration, fps)

        image = None
        temp_image_path: str | None = None
        image_path = normalize_optional_path(req.imagePath)
        if image_path:
            image = self._prepare_image(image_path, width, height)

        seed = self._resolve_seed()

        generation_id = self._make_generation_id()

        try:
            a2v_state = self._pipelines.load_a2v_pipeline()
            self._generation.start_generation(generation_id)

            enhanced_prompt = req.prompt + self.config.camera_motion_prompts.get(req.cameraMotion, "")
            neg = req.negativePrompt if req.negativePrompt else self.config.default_negative_prompt

            images: list[ImageConditioningInput] = []
            if image is not None:
                temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
                image.save(temp_image_path)
                images = [ImageConditioningInput(path=temp_image_path, frame_idx=0, strength=1.0)]

            output_path = self._make_output_path()

            total_steps = 11  # distilled: 8 steps (stage 1) + 3 steps (stage 2)

            a2v_settings = self.state.app_settings
            a2v_use_api = not self._text.should_use_local_encoding()
            if image is not None:
                a2v_enhance = a2v_use_api and a2v_settings.prompt_enhancer_enabled_i2v
            else:
                a2v_enhance = a2v_use_api and a2v_settings.prompt_enhancer_enabled_t2v

            self._generation.update_progress("loading_model", 5, 0, total_steps)
            self._generation.update_progress("encoding_text", 10, 0, total_steps)
            self._text.prepare_text_encoding(enhanced_prompt, enhance_prompt=a2v_enhance)
            self._generation.update_progress("inference", 15, 0, total_steps)

            a2v_state.pipeline.generate(
                prompt=enhanced_prompt,
                negative_prompt=neg,
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                num_inference_steps=total_steps,
                images=images,
                audio_path=audio_path_str,
                audio_start_time=0.0,
                audio_max_duration=None,
                output_path=str(output_path),
            )

            if self._generation.is_generation_cancelled():
                if output_path.exists():
                    output_path.unlink()
                raise RuntimeError("Generation was cancelled")

            self._generation.update_progress("complete", 100, total_steps, total_steps)
            self._generation.complete_generation(str(output_path))
            return GenerateVideoResponse(status="complete", video_path=str(output_path))

        except Exception as e:
            self._generation.fail_generation(str(e))
            if "cancelled" in str(e).lower():
                logger.info("Generation cancelled by user")
                return GenerateVideoResponse(status="cancelled")
            raise HTTPError(500, str(e)) from e
        finally:
            self._text.clear_api_embeddings()
            if temp_image_path and os.path.exists(temp_image_path):
                os.unlink(temp_image_path)

    def _prepare_image(self, image_path: str, width: int, height: int) -> Image.Image:
        validated_path = validate_image_file(image_path)
        try:
            img = Image.open(validated_path).convert("RGB")
        except Exception:
            raise HTTPError(400, f"Invalid image file: {image_path}") from None
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
        return resized.crop((left, top, left + width, top + height))

    @staticmethod
    def _make_generation_id() -> str:
        return uuid.uuid4().hex[:8]

    @staticmethod
    def _compute_num_frames(duration: int, fps: int) -> int:
        n = ((duration * fps) // 8) * 8 + 1
        return max(n, 9)

    def _resolve_seed(self) -> int:
        settings = self.state.app_settings
        if settings.seed_locked:
            logger.info("Using locked seed: %s", settings.locked_seed)
            return settings.locked_seed
        return int(time.time()) % 2147483647

    def _make_output_path(self) -> Path:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return self.config.outputs_dir / f"ltx2_video_{timestamp}_{self._make_generation_id()}.mp4"

    def _generate_forced_api(self, req: GenerateVideoRequest) -> GenerateVideoResponse:
        queued = self.submit_async_generation(req)
        return self._wait_for_api_generation(queued.generationId)

    def _wait_for_api_generation(self, generation_id: str) -> GenerateVideoResponse:
        while True:
            state = self._generation.get_api_generation_state(generation_id)
            if state is None:
                raise HTTPError(500, "GENERATION_NOT_FOUND")

            match state:
                case GenerationQueued() | GenerationRunning():
                    time.sleep(API_GENERATION_WAIT_POLL_SECONDS)
                case GenerationComplete(result=result):
                    video_path = result if isinstance(result, str) else None
                    return GenerateVideoResponse(status="complete", video_path=video_path)
                case GenerationCancelled():
                    return GenerateVideoResponse(status="cancelled")
                case GenerationError(error=error, status_code=status_code):
                    raise HTTPError(status_code, error)

    def _build_generation_status_response(
        self,
        generation_id: str,
        state: GenerationQueued | GenerationRunning | GenerationComplete | GenerationCancelled | GenerationError,
        *,
        batch_id: str | None,
    ) -> GenerationJobStatusResponse:
        match state:
            case GenerationQueued(progress=progress):
                return GenerationJobStatusResponse(
                    generationId=generation_id,
                    status="queued",
                    phase=progress.phase,
                    progress=int(progress.progress),
                    currentStep=progress.current_step,
                    totalSteps=progress.total_steps,
                    batchId=batch_id,
                )
            case GenerationRunning(progress=progress):
                return GenerationJobStatusResponse(
                    generationId=generation_id,
                    status="running",
                    phase=progress.phase,
                    progress=int(progress.progress),
                    currentStep=progress.current_step,
                    totalSteps=progress.total_steps,
                    batchId=batch_id,
                )
            case GenerationComplete(result=result):
                video_path = result if isinstance(result, str) else None
                return GenerationJobStatusResponse(
                    generationId=generation_id,
                    status="complete",
                    phase="complete",
                    progress=100,
                    currentStep=0,
                    totalSteps=0,
                    videoPath=video_path,
                    batchId=batch_id,
                )
            case GenerationCancelled():
                return GenerationJobStatusResponse(
                    generationId=generation_id,
                    status="cancelled",
                    phase="cancelled",
                    progress=0,
                    currentStep=0,
                    totalSteps=0,
                    batchId=batch_id,
                )
            case GenerationError(error=error):
                return GenerationJobStatusResponse(
                    generationId=generation_id,
                    status="error",
                    phase="error",
                    progress=0,
                    currentStep=0,
                    totalSteps=0,
                    error=error,
                    batchId=batch_id,
                )

    def _run_async_api_generation_worker(
        self,
        generation_id: str,
        req: GenerateVideoRequest,
        *,
        batch_id: str | None = None,
    ) -> None:
        if self._generation.is_generation_cancelled(generation_id):
            return

        with self._api_generation_semaphore:
            if self._generation.is_generation_cancelled(generation_id):
                return

            self._generation.start_api_generation(generation_id, batch_id=batch_id)

            try:
                output_path = self._run_forced_api_generation(generation_id, req)
                if self._generation.is_generation_cancelled(generation_id):
                    Path(output_path).unlink(missing_ok=True)
                    return
                self._generation.update_progress("complete", 100, None, None, generation_id=generation_id)
                self._generation.complete_generation(output_path, generation_id=generation_id)
            except HTTPError as exc:
                self._generation.fail_generation(exc.detail, generation_id=generation_id, status_code=exc.status_code)
            except Exception as exc:  # noqa: BLE001
                if "cancelled" in str(exc).lower():
                    logger.info("Generation %s cancelled by user", generation_id)
                    self._generation.cancel_generation(generation_id=generation_id)
                    return
                self._generation.fail_generation(str(exc), generation_id=generation_id)

    def _run_forced_api_generation(self, generation_id: str, req: GenerateVideoRequest) -> str:
        audio_path = normalize_optional_path(req.audioPath)
        image_path = normalize_optional_path(req.imagePath)
        has_input_audio = bool(audio_path)
        has_input_image = bool(image_path)

        self._generation.update_progress("validating_request", 5, None, None, generation_id=generation_id)

        api_key = self.state.app_settings.ltx_api_key.strip()
        logger.info("Forced API generation route selected (key_present=%s)", bool(api_key))
        if not api_key:
            raise HTTPError(400, "PRO_API_KEY_REQUIRED")

        requested_model = req.model.strip().lower()
        api_model_id = FORCED_API_MODEL_MAP.get(requested_model)
        if api_model_id is None:
            raise HTTPError(400, "INVALID_FORCED_API_MODEL")

        resolution_label = req.resolution
        resolution_by_aspect = FORCED_API_RESOLUTION_MAP.get(resolution_label)
        if resolution_by_aspect is None:
            raise HTTPError(400, "INVALID_FORCED_API_RESOLUTION")

        aspect_ratio = req.aspectRatio.strip()
        if aspect_ratio not in FORCED_API_ALLOWED_ASPECT_RATIOS:
            raise HTTPError(400, "INVALID_FORCED_API_ASPECT_RATIO")

        api_resolution = resolution_by_aspect[aspect_ratio]
        prompt = req.prompt

        if self._generation.is_generation_cancelled(generation_id):
            raise RuntimeError("Generation was cancelled")

        if has_input_audio:
            if requested_model != "pro":
                logger.warning("A2V requested with model=%s; overriding to 'pro'", requested_model)
            api_model_id = FORCED_API_MODEL_MAP["pro"]
            if api_resolution != A2V_FORCED_API_RESOLUTION:
                logger.warning(
                    "A2V requested with resolution=%s; overriding to '%s'",
                    api_resolution,
                    A2V_FORCED_API_RESOLUTION,
                )
            api_resolution = A2V_FORCED_API_RESOLUTION
            validated_audio_path = validate_audio_file(audio_path)
            validated_image_path: Path | None = None
            if image_path is not None:
                validated_image_path = validate_image_file(image_path)

            self._generation.update_progress("uploading_audio", 20, None, None, generation_id=generation_id)
            audio_uri = self._ltx_api_client.upload_file(
                api_key=api_key,
                file_path=str(validated_audio_path),
            )
            image_uri: str | None = None
            if validated_image_path is not None:
                self._generation.update_progress("uploading_image", 35, None, None, generation_id=generation_id)
                image_uri = self._ltx_api_client.upload_file(
                    api_key=api_key,
                    file_path=str(validated_image_path),
                )
            self._generation.update_progress("inference", 55, None, None, generation_id=generation_id)
            video_bytes = self._ltx_api_client.generate_audio_to_video(
                api_key=api_key,
                prompt=prompt,
                audio_uri=audio_uri,
                image_uri=image_uri,
                model=api_model_id,
                resolution=api_resolution,
            )
            self._generation.update_progress("downloading_output", 85, None, None, generation_id=generation_id)
        elif has_input_image:
            validated_image_path = validate_image_file(image_path)

            duration = self._parse_forced_numeric_field(req.duration, "INVALID_FORCED_API_DURATION")
            fps = self._parse_forced_numeric_field(req.fps, "INVALID_FORCED_API_FPS")
            if fps not in FORCED_API_ALLOWED_FPS:
                raise HTTPError(400, "INVALID_FORCED_API_FPS")
            if duration not in _get_allowed_durations(api_model_id, resolution_label, fps):
                raise HTTPError(400, "INVALID_FORCED_API_DURATION")

            generate_audio = self._parse_audio_flag(req.audio)
            self._generation.update_progress("uploading_image", 20, None, None, generation_id=generation_id)
            image_uri = self._ltx_api_client.upload_file(
                api_key=api_key,
                file_path=str(validated_image_path),
            )
            self._generation.update_progress("inference", 55, None, None, generation_id=generation_id)
            video_bytes = self._ltx_api_client.generate_image_to_video(
                api_key=api_key,
                prompt=prompt,
                image_uri=image_uri,
                model=api_model_id,
                resolution=api_resolution,
                duration=float(duration),
                fps=float(fps),
                generate_audio=generate_audio,
                camera_motion=req.cameraMotion,
            )
            self._generation.update_progress("downloading_output", 85, None, None, generation_id=generation_id)
        else:
            duration = self._parse_forced_numeric_field(req.duration, "INVALID_FORCED_API_DURATION")
            fps = self._parse_forced_numeric_field(req.fps, "INVALID_FORCED_API_FPS")
            if fps not in FORCED_API_ALLOWED_FPS:
                raise HTTPError(400, "INVALID_FORCED_API_FPS")
            if duration not in _get_allowed_durations(api_model_id, resolution_label, fps):
                raise HTTPError(400, "INVALID_FORCED_API_DURATION")

            generate_audio = self._parse_audio_flag(req.audio)
            self._generation.update_progress("inference", 55, None, None, generation_id=generation_id)
            video_bytes = self._ltx_api_client.generate_text_to_video(
                api_key=api_key,
                prompt=prompt,
                model=api_model_id,
                resolution=api_resolution,
                duration=float(duration),
                fps=float(fps),
                generate_audio=generate_audio,
                camera_motion=req.cameraMotion,
            )
            self._generation.update_progress("downloading_output", 85, None, None, generation_id=generation_id)

        if self._generation.is_generation_cancelled(generation_id):
            raise RuntimeError("Generation was cancelled")

        output_path = self._write_forced_api_video(video_bytes)
        if self._generation.is_generation_cancelled(generation_id):
            output_path.unlink(missing_ok=True)
            raise RuntimeError("Generation was cancelled")
        return str(output_path)

    def _write_forced_api_video(self, video_bytes: bytes) -> Path:
        output_path = self._make_output_path()
        output_path.write_bytes(video_bytes)
        return output_path

    @staticmethod
    def _parse_forced_numeric_field(raw_value: str, error_detail: str) -> int:
        try:
            return int(float(raw_value))
        except (TypeError, ValueError):
            raise HTTPError(400, error_detail) from None

    @staticmethod
    def _parse_audio_flag(audio_value: str | bool) -> bool:
        if isinstance(audio_value, bool):
            return audio_value
        normalized = audio_value.strip().lower()
        return normalized in {"1", "true", "yes", "on"}
