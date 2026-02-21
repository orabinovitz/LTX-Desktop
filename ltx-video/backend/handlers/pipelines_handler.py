"""Pipeline lifecycle and warmup handler."""

from __future__ import annotations

import logging
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING

from handlers.base import StateHandlerBase
from handlers.text_handler import TextHandler
from services.interfaces import (
    FastNativeVideoPipeline,
    FastVideoPipeline,
    ImageGenerationPipeline,
    GpuCleaner,
    IcLoraPipeline,
    ModelDownloader,
    ProNativeVideoPipeline,
    ProVideoPipeline,
    VideoPipelineModelType,
)
from state.app_state_types import (
    AppState,
    CpuSlot,
    GenerationRunning,
    GpuSlot,
    ICLoraState,
    VideoPipelineState,
    VideoPipelineWarmth,
)

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)


class PipelinesHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        text_handler: TextHandler,
        gpu_cleaner: GpuCleaner,
        model_downloader: ModelDownloader,
        fast_video_pipeline_class: type[FastVideoPipeline],
        fast_native_video_pipeline_class: type[FastNativeVideoPipeline],
        pro_video_pipeline_class: type[ProVideoPipeline],
        pro_native_video_pipeline_class: type[ProNativeVideoPipeline],
        image_generation_pipeline_class: type[ImageGenerationPipeline],
        ic_lora_pipeline_class: type[IcLoraPipeline],
        config: RuntimeConfig,
        outputs_dir: Path,
        device: str | object,
    ) -> None:
        super().__init__(state, lock)
        self._text_handler = text_handler
        self._gpu_cleaner = gpu_cleaner
        self._model_downloader = model_downloader
        self._fast_video_pipeline_class = fast_video_pipeline_class
        self._fast_native_video_pipeline_class = fast_native_video_pipeline_class
        self._pro_video_pipeline_class = pro_video_pipeline_class
        self._pro_native_video_pipeline_class = pro_native_video_pipeline_class
        self._image_generation_pipeline_class = image_generation_pipeline_class
        self._ic_lora_pipeline_class = ic_lora_pipeline_class
        self._config = config
        self._outputs_dir = outputs_dir
        self._device = device

    def _ensure_no_running_generation(self) -> None:
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationRunning()):
                raise RuntimeError("Generation already running; cannot swap pipelines")
            case _:
                return

    def _pipeline_matches_model_type(self, model_type: VideoPipelineModelType) -> bool:
        match self.state.gpu_slot:
            case GpuSlot(active_pipeline=VideoPipelineState(pipeline=pipeline)):
                return pipeline.pipeline_kind == model_type
            case _:
                return False

    def _assert_invariants(self) -> None:
        gpu_is_flux = False
        match self.state.gpu_slot:
            case GpuSlot(active_pipeline=VideoPipelineState() | ICLoraState()):
                gpu_is_flux = False
            case GpuSlot():
                gpu_is_flux = True
            case _:
                gpu_is_flux = False

        if gpu_is_flux and self.state.cpu_slot is not None:
            raise RuntimeError("Invariant violation: Flux cannot be in both GPU and CPU slots")

    def _install_text_patches_if_needed(self) -> None:
        te = self.state.text_encoder
        if te is None:
            return
        te.service.install_patches(lambda: self)

    def _compile_if_enabled(self, state: VideoPipelineState) -> VideoPipelineState:
        if not self.state.app_settings.use_torch_compile:
            return state
        if state.is_compiled:
            return state

        try:
            state.pipeline.compile_transformer()
            state.is_compiled = True
        except Exception as exc:
            logger.warning("Failed to compile transformer: %s", exc)
        return state

    def _create_video_pipeline(self, model_type: VideoPipelineModelType) -> VideoPipelineState:
        gemma_root = self._text_handler.resolve_gemma_root()

        checkpoint_path = str(self._config.model_path("checkpoint"))
        upsampler_path = str(self._config.model_path("upsampler"))
        distilled_lora_path = str(self._config.model_path("distilled_lora"))

        match model_type:
            case "fast":
                pipeline = self._fast_video_pipeline_class.create(
                    checkpoint_path,
                    gemma_root,
                    upsampler_path,
                    self._device,
                )
            case "fast-native":
                pipeline = self._fast_native_video_pipeline_class.create(
                    checkpoint_path,
                    gemma_root,
                    self._device,
                )
            case "pro":
                pipeline = self._pro_video_pipeline_class.create(
                    checkpoint_path,
                    gemma_root,
                    upsampler_path,
                    distilled_lora_path,
                    self._device,
                )
            case "pro-native":
                pipeline = self._pro_native_video_pipeline_class.create(
                    checkpoint_path,
                    gemma_root,
                    self._device,
                )
            case _:
                raise RuntimeError(f"Unsupported model type: {model_type}")

        state = VideoPipelineState(
            pipeline=pipeline,
            warmth=VideoPipelineWarmth.COLD,
            is_compiled=False,
        )
        return self._compile_if_enabled(state)

    def unload_gpu_pipeline(self) -> None:
        with self._lock:
            self._ensure_no_running_generation()
            self.state.gpu_slot = None
            self._assert_invariants()
        self._gpu_cleaner.cleanup()

    def park_flux_on_cpu(self) -> None:
        flux: ImageGenerationPipeline | None = None

        with self._lock:
            if self.state.gpu_slot is None:
                return

            active = self.state.gpu_slot.active_pipeline
            if isinstance(active, (VideoPipelineState, ICLoraState)):
                return

            generation = self.state.gpu_slot.generation
            if isinstance(generation, GenerationRunning):
                raise RuntimeError("Cannot park Flux while generation is running")

            flux = active
            self.state.gpu_slot = None

        assert flux is not None
        flux.to("cpu")
        self._gpu_cleaner.cleanup()

        with self._lock:
            self.state.cpu_slot = CpuSlot(active_pipeline=flux)
            self._assert_invariants()

    def load_flux_to_gpu(self) -> ImageGenerationPipeline:
        with self._lock:
            if self.state.gpu_slot is not None:
                active = self.state.gpu_slot.active_pipeline
                if not isinstance(active, (VideoPipelineState, ICLoraState)):
                    return active
                self._ensure_no_running_generation()

        flux_service: ImageGenerationPipeline | None = None

        with self._lock:
            match self.state.cpu_slot:
                case CpuSlot(active_pipeline=stored):
                    flux_service = stored
                    self.state.cpu_slot = None
                case _:
                    flux_service = None

        if flux_service is None:
            flux_path = self._config.model_path("flux")
            flux_spec = self._config.spec_for("flux")
            if not (flux_path.exists() and any(flux_path.iterdir())):
                self._model_downloader.download_snapshot(
                    repo_id=flux_spec.repo_id,
                    local_dir=str(self._config.download_local_dir("flux")),
                    allow_patterns=list(flux_spec.snapshot_allow_patterns) if flux_spec.snapshot_allow_patterns is not None else None,
                )
            flux_service = self._image_generation_pipeline_class.create(str(flux_path), "cuda")
        else:
            flux_service.to("cuda")

        self._gpu_cleaner.cleanup()

        with self._lock:
            self.state.gpu_slot = GpuSlot(active_pipeline=flux_service, generation=None)
            self._assert_invariants()

        return flux_service

    def preload_flux_to_cpu(self) -> ImageGenerationPipeline:
        with self._lock:
            match self.state.cpu_slot:
                case CpuSlot(active_pipeline=existing):
                    return existing
                case _:
                    pass

        flux_path = self._config.model_path("flux")
        flux_spec = self._config.spec_for("flux")
        if not (flux_path.exists() and any(flux_path.iterdir())):
            self._model_downloader.download_snapshot(
                repo_id=flux_spec.repo_id,
                local_dir=str(self._config.download_local_dir("flux")),
                allow_patterns=list(flux_spec.snapshot_allow_patterns) if flux_spec.snapshot_allow_patterns is not None else None,
            )

        flux_service = self._image_generation_pipeline_class.create(str(flux_path), None)
        with self._lock:
            if self.state.cpu_slot is None:
                self.state.cpu_slot = CpuSlot(active_pipeline=flux_service)
                self._assert_invariants()
                return flux_service
            return self.state.cpu_slot.active_pipeline

    def _evict_gpu_pipeline_for_swap(self) -> None:
        should_park_flux = False
        should_cleanup = False

        with self._lock:
            self._ensure_no_running_generation()
            if self.state.gpu_slot is None:
                return

            active = self.state.gpu_slot.active_pipeline
            if isinstance(active, (VideoPipelineState, ICLoraState)):
                self.state.gpu_slot = None
                self._assert_invariants()
                should_cleanup = True
            else:
                should_park_flux = True

        if should_park_flux:
            self.park_flux_on_cpu()
        elif should_cleanup:
            self._gpu_cleaner.cleanup()

    def load_gpu_pipeline(self, model_type: VideoPipelineModelType, should_warm: bool = False) -> VideoPipelineState:
        self._install_text_patches_if_needed()

        state: VideoPipelineState | None = None
        with self._lock:
            if self._pipeline_matches_model_type(model_type):
                match self.state.gpu_slot:
                    case GpuSlot(active_pipeline=VideoPipelineState() as existing_state):
                        state = existing_state
                    case _:
                        pass

        if state is None:
            self._evict_gpu_pipeline_for_swap()
            state = self._create_video_pipeline(model_type)
            with self._lock:
                self.state.gpu_slot = GpuSlot(active_pipeline=state, generation=None)
                self._assert_invariants()

        if should_warm and state.warmth == VideoPipelineWarmth.COLD:
            with self._lock:
                state.warmth = VideoPipelineWarmth.WARMING

            self.warmup_pipeline(model_type)
            with self._lock:
                if state.warmth == VideoPipelineWarmth.WARMING:
                    state.warmth = VideoPipelineWarmth.WARM

        return state

    def load_ic_lora(self, lora_path: str) -> ICLoraState:
        self._install_text_patches_if_needed()

        with self._lock:
            match self.state.gpu_slot:
                case GpuSlot(active_pipeline=ICLoraState(lora_path=current_path) as state) if current_path == lora_path:
                    return state
                case _:
                    pass

        self._evict_gpu_pipeline_for_swap()

        pipeline = self._ic_lora_pipeline_class.create(
            str(self._config.model_path("checkpoint")),
            self._text_handler.resolve_gemma_root(),
            str(self._config.model_path("upsampler")),
            lora_path,
            self._device,
        )
        state = ICLoraState(pipeline=pipeline, lora_path=lora_path)

        with self._lock:
            self.state.gpu_slot = GpuSlot(active_pipeline=state, generation=None)
            self._assert_invariants()
        return state

    def warmup_pipeline(self, model_type: VideoPipelineModelType) -> None:
        state = self.load_gpu_pipeline(model_type, should_warm=False)
        warmup_path = self._outputs_dir / f"_warmup_{model_type}.mp4"
        state.pipeline.warmup(output_path=str(warmup_path))
