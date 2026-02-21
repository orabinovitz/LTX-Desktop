"""Application state composition root and dependency wiring."""

from __future__ import annotations

import threading
from dataclasses import dataclass

from state.app_settings import AppSettings
from handlers import (
    DownloadHandler,
    GenerationHandler,
    HealthHandler,
    IcLoraHandler,
    ImageGenerationHandler,
    ModelsHandler,
    PipelinesHandler,
    PromptHandler,
    RetakeHandler,
    SettingsHandler,
    TextHandler,
    VideoGenerationHandler,
)
from runtime_config.runtime_config import RuntimeConfig
from services.interfaces import (
    FastNativeVideoPipeline,
    FastVideoPipeline,
    ImageGenerationPipeline,
    GpuCleaner,
    GpuInfo,
    HTTPClient,
    IcLoraModelDownloader,
    IcLoraPipeline,
    ModelDownloader,
    ProNativeVideoPipeline,
    ProVideoPipeline,
    TaskRunner,
    TextEncoder,
    VideoProcessor,
)
from state.app_state_types import AppState, StartupPending, TextEncoderState


class AppHandler:
    """Composition-only state service exposing typed domain handlers."""

    def __init__(
        self,
        config: RuntimeConfig,
        default_settings: AppSettings,
        http: HTTPClient,
        gpu_cleaner: GpuCleaner,
        model_downloader: ModelDownloader,
        gpu_info: GpuInfo,
        video_processor: VideoProcessor,
        text_encoder: TextEncoder,
        task_runner: TaskRunner,
        fast_video_pipeline_class: type[FastVideoPipeline],
        fast_native_video_pipeline_class: type[FastNativeVideoPipeline],
        pro_video_pipeline_class: type[ProVideoPipeline],
        pro_native_video_pipeline_class: type[ProNativeVideoPipeline],
        image_generation_pipeline_class: type[ImageGenerationPipeline],
        ic_lora_pipeline_class: type[IcLoraPipeline],
        ic_lora_model_downloader: IcLoraModelDownloader,
    ) -> None:
        self.config = config

        # Exposed for tests and diagnostics.
        self.http = http
        self.gpu_cleaner = gpu_cleaner
        self.model_downloader = model_downloader
        self.gpu_info = gpu_info
        self.video_processor = video_processor
        self.task_runner = task_runner
        self.fast_video_pipeline_class = fast_video_pipeline_class
        self.fast_native_video_pipeline_class = fast_native_video_pipeline_class
        self.pro_video_pipeline_class = pro_video_pipeline_class
        self.pro_native_video_pipeline_class = pro_native_video_pipeline_class
        self.image_generation_pipeline_class = image_generation_pipeline_class
        self.ic_lora_pipeline_class = ic_lora_pipeline_class
        self.ic_lora_model_downloader = ic_lora_model_downloader

        self._lock = threading.RLock()

        self.state = AppState(
            available_files={
                "checkpoint": None,
                "upsampler": None,
                "distilled_lora": None,
                "text_encoder": None,
                "flux": None,
            },
            downloading_session=None,
            gpu_slot=None,
            cpu_slot=None,
            text_encoder=TextEncoderState(service=text_encoder),
            startup=StartupPending(message="Not started"),
            app_settings=default_settings.model_copy(deep=True),
        )

        # ============================================================
        # Handlers (wired in dependency order)
        # ============================================================

        self.settings = SettingsHandler(
            state=self.state,
            lock=self._lock,
            settings_file=config.settings_file,
        )
        self.settings.load_settings(default_settings)

        self.models = ModelsHandler(
            state=self.state,
            lock=self._lock,
            config=config,
        )

        self.downloads = DownloadHandler(
            state=self.state,
            lock=self._lock,
            models_handler=self.models,
            model_downloader=model_downloader,
            task_runner=task_runner,
            config=config,
        )

        self.text = TextHandler(
            state=self.state,
            lock=self._lock,
            config=config,
        )

        self.pipelines = PipelinesHandler(
            state=self.state,
            lock=self._lock,
            text_handler=self.text,
            gpu_cleaner=gpu_cleaner,
            model_downloader=model_downloader,
            fast_video_pipeline_class=fast_video_pipeline_class,
            fast_native_video_pipeline_class=fast_native_video_pipeline_class,
            pro_video_pipeline_class=pro_video_pipeline_class,
            pro_native_video_pipeline_class=pro_native_video_pipeline_class,
            image_generation_pipeline_class=image_generation_pipeline_class,
            ic_lora_pipeline_class=ic_lora_pipeline_class,
            config=config,
            outputs_dir=config.outputs_dir,
            device=config.device,
        )

        self.generation = GenerationHandler(state=self.state, lock=self._lock)

        self.video_generation = VideoGenerationHandler(
            state=self.state,
            lock=self._lock,
            generation_handler=self.generation,
            pipelines_handler=self.pipelines,
            text_handler=self.text,
            outputs_dir=config.outputs_dir,
            config=config,
            camera_motion_prompts=config.camera_motion_prompts,
            default_negative_prompt=config.default_negative_prompt,
        )

        self.image_generation = ImageGenerationHandler(
            state=self.state,
            lock=self._lock,
            generation_handler=self.generation,
            pipelines_handler=self.pipelines,
            outputs_dir=config.outputs_dir,
        )

        self.health = HealthHandler(
            state=self.state,
            lock=self._lock,
            models_handler=self.models,
            pipelines_handler=self.pipelines,
            gpu_info=gpu_info,
            config=config,
            use_sage_attention=config.use_sage_attention,
        )

        self.prompt = PromptHandler(
            state=self.state,
            lock=self._lock,
            http=http,
        )

        self.retake = RetakeHandler(
            state=self.state,
            lock=self._lock,
            http=http,
            outputs_dir=config.outputs_dir,
        )

        self.ic_lora = IcLoraHandler(
            state=self.state,
            lock=self._lock,
            generation_handler=self.generation,
            pipelines_handler=self.pipelines,
            text_handler=self.text,
            video_processor=video_processor,
            ic_lora_model_downloader=ic_lora_model_downloader,
            ic_lora_dir=config.ic_lora_dir,
            outputs_dir=config.outputs_dir,
        )

        self.models.refresh_available_files()


@dataclass
class ServiceBundle:
    http: HTTPClient
    gpu_cleaner: GpuCleaner
    model_downloader: ModelDownloader
    gpu_info: GpuInfo
    video_processor: VideoProcessor
    text_encoder: TextEncoder
    task_runner: TaskRunner
    fast_video_pipeline_class: type[FastVideoPipeline]
    fast_native_video_pipeline_class: type[FastNativeVideoPipeline]
    pro_video_pipeline_class: type[ProVideoPipeline]
    pro_native_video_pipeline_class: type[ProNativeVideoPipeline]
    image_generation_pipeline_class: type[ImageGenerationPipeline]
    ic_lora_pipeline_class: type[IcLoraPipeline]
    ic_lora_model_downloader: IcLoraModelDownloader


def build_default_service_bundle(config: RuntimeConfig) -> ServiceBundle:
    """Build real runtime services with lazy heavy imports isolated from tests."""
    from services.fast_native_video_pipeline.ltx_fast_native_video_pipeline import LTXFastNativeVideoPipeline
    from services.fast_video_pipeline.ltx_fast_video_pipeline import LTXFastVideoPipeline
    from services.gpu_cleaner.torch_cleaner import TorchCleaner
    from services.gpu_info.gpu_info_impl import GpuInfoImpl
    from services.http_client.http_client_impl import HTTPClientImpl
    from services.ic_lora_model_downloader.ic_lora_model_downloader_impl import IcLoraModelDownloaderImpl
    from services.ic_lora_pipeline.ltx_ic_lora_pipeline import LTXIcLoraPipeline
    from services.image_generation_pipeline.flux_image_generation_pipeline import FluxImageGenerationPipeline
    from services.model_downloader.hugging_face_downloader import HuggingFaceDownloader
    from services.pro_native_video_pipeline.ltx_pro_native_video_pipeline import LTXProNativeVideoPipeline
    from services.pro_video_pipeline.ltx_pro_video_pipeline import LTXProVideoPipeline
    from services.task_runner.threading_runner import ThreadingRunner
    from services.text_encoder.ltx_text_encoder import LTXTextEncoder
    from services.video_processor.video_processor_impl import VideoProcessorImpl

    http = HTTPClientImpl()

    return ServiceBundle(
        http=http,
        gpu_cleaner=TorchCleaner(),
        model_downloader=HuggingFaceDownloader(),
        gpu_info=GpuInfoImpl(),
        video_processor=VideoProcessorImpl(),
        text_encoder=LTXTextEncoder(
            device=config.device,
            http=http,
            ltx_api_base_url=config.ltx_api_base_url,
        ),
        task_runner=ThreadingRunner(),
        fast_video_pipeline_class=LTXFastVideoPipeline,
        fast_native_video_pipeline_class=LTXFastNativeVideoPipeline,
        pro_video_pipeline_class=LTXProVideoPipeline,
        pro_native_video_pipeline_class=LTXProNativeVideoPipeline,
        image_generation_pipeline_class=FluxImageGenerationPipeline,
        ic_lora_pipeline_class=LTXIcLoraPipeline,
        ic_lora_model_downloader=IcLoraModelDownloaderImpl(),
    )


def build_initial_state(
    config: RuntimeConfig,
    default_settings: AppSettings,
    service_bundle: ServiceBundle | None = None,
) -> AppHandler:
    bundle = service_bundle or build_default_service_bundle(config)

    return AppHandler(
        config=config,
        default_settings=default_settings,
        http=bundle.http,
        gpu_cleaner=bundle.gpu_cleaner,
        model_downloader=bundle.model_downloader,
        gpu_info=bundle.gpu_info,
        video_processor=bundle.video_processor,
        text_encoder=bundle.text_encoder,
        task_runner=bundle.task_runner,
        fast_video_pipeline_class=bundle.fast_video_pipeline_class,
        fast_native_video_pipeline_class=bundle.fast_native_video_pipeline_class,
        pro_video_pipeline_class=bundle.pro_video_pipeline_class,
        pro_native_video_pipeline_class=bundle.pro_native_video_pipeline_class,
        image_generation_pipeline_class=bundle.image_generation_pipeline_class,
        ic_lora_pipeline_class=bundle.ic_lora_pipeline_class,
        ic_lora_model_downloader=bundle.ic_lora_model_downloader,
    )
