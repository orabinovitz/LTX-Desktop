"""Pydantic request/response models and TypedDicts for ltx2_server."""

from __future__ import annotations

from typing import Any, TypedDict

from pydantic import BaseModel, ConfigDict, Field


# ============================================================
# TypedDicts for module-level state globals
# ============================================================


class GenerationState(TypedDict):
    id: str | None
    cancelled: bool
    result: str | list[str] | None
    error: str | None
    status: str  # "idle" | "running" | "complete" | "cancelled" | "error"
    phase: str
    progress: int
    current_step: int
    total_steps: int


class WarmupState(TypedDict):
    status: str  # "pending" | "loading" | "warming" | "ready" | "error"
    current_step: str
    progress: int
    error: str | None


class ModelDownloadState(TypedDict):
    status: str  # "idle" | "downloading" | "complete" | "error"
    current_file: str
    current_file_progress: int
    total_progress: int
    downloaded_bytes: int
    total_bytes: int
    files_completed: int
    total_files: int
    error: str | None
    speed_mbps: int


class FastModelSettings(TypedDict):
    steps: int
    use_upscaler: bool


class ProModelSettings(TypedDict):
    steps: int
    use_upscaler: bool


class AppSettings(TypedDict):
    keep_models_loaded: bool
    use_torch_compile: bool
    load_on_startup: bool
    ltx_api_key: str
    use_local_text_encoder: bool
    fast_model: FastModelSettings
    pro_model: ProModelSettings
    prompt_cache_size: int
    prompt_enhancer_enabled_t2v: bool
    prompt_enhancer_enabled_i2v: bool
    gemini_api_key: str
    t2v_system_prompt: str
    i2v_system_prompt: str
    seed_locked: bool
    locked_seed: int


# ============================================================
# Response Models
# ============================================================


class ModelStatusItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    loaded: bool
    downloaded: bool


class HealthResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    models_loaded: bool
    active_model: str | None
    fast_loaded: bool
    pro_loaded: bool
    pro_native_loaded: bool
    gpu_info: dict[str, Any]
    sage_attention: bool
    models_status: list[ModelStatusItem]


class GpuInfoResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cuda_available: bool
    gpu_name: str | None
    vram_gb: int | None
    gpu_info: dict[str, Any]


class WarmupStatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    currentStep: str = Field(alias="currentStep")
    progress: int
    error: str | None


class GenerationProgressResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    phase: str
    progress: int
    currentStep: int = Field(alias="currentStep")
    totalSteps: int = Field(alias="totalSteps")


class ModelInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: str


class ModelFileStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    description: str
    downloaded: bool
    size: int
    expected_size: int
    required: bool = True
    is_folder: bool = False
    optional_reason: str | None = None


class TextEncoderStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    downloaded: bool
    size_bytes: int
    size_gb: float
    expected_size_gb: float


class ModelsStatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    models: list[dict[str, Any]]
    all_downloaded: bool
    total_size: int
    downloaded_size: int
    total_size_gb: float
    downloaded_size_gb: float
    models_path: str
    has_api_key: bool
    text_encoder_status: dict[str, Any]
    use_local_text_encoder: bool


class DownloadProgressResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    currentFile: str = Field(alias="currentFile")
    currentFileProgress: int = Field(alias="currentFileProgress")
    totalProgress: int = Field(alias="totalProgress")
    downloadedBytes: int = Field(alias="downloadedBytes")
    totalBytes: int = Field(alias="totalBytes")
    filesCompleted: int = Field(alias="filesCompleted")
    totalFiles: int = Field(alias="totalFiles")
    error: str | None
    speedMbps: int = Field(alias="speedMbps")


class SettingsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    keepModelsLoaded: bool = Field(alias="keepModelsLoaded")
    useTorchCompile: bool = Field(alias="useTorchCompile")
    loadOnStartup: bool = Field(alias="loadOnStartup")
    ltxApiKey: str = Field(alias="ltxApiKey")
    useLocalTextEncoder: bool = Field(alias="useLocalTextEncoder")
    fastModel: dict[str, Any] = Field(alias="fastModel")
    proModel: dict[str, Any] = Field(alias="proModel")
    promptCacheSize: int = Field(alias="promptCacheSize")
    promptEnhancerEnabledT2V: bool = Field(alias="promptEnhancerEnabledT2V")
    promptEnhancerEnabledI2V: bool = Field(alias="promptEnhancerEnabledI2V")
    geminiApiKey: str = Field(alias="geminiApiKey")
    t2vSystemPrompt: str = Field(alias="t2vSystemPrompt")
    i2vSystemPrompt: str = Field(alias="i2vSystemPrompt")
    seedLocked: bool = Field(alias="seedLocked")
    lockedSeed: int = Field(alias="lockedSeed")


class IcLoraModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    path: str
    conditioning_type: str
    reference_downscale_factor: int


class IcLoraListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    models: list[dict[str, Any]]
    directory: str


class EnhancePromptResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str = "success"
    enhanced_prompt: str
    original_prompt: str | None = None
    skipped: bool | None = None
    reason: str | None = None


class SuggestGapPromptResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str = "success"
    suggested_prompt: str


class GenerateVideoResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    video_path: str | None = None


class GenerateImageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    image_paths: list[str] | None = None


class CancelResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    id: str | None = None


class UpscaleResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    upscaled_path: str | None = None
    width: int | None = None
    height: int | None = None
    result: dict[str, Any] | None = None


class RetakeResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    video_path: str | None = None
    result: dict[str, Any] | None = None


class IcLoraExtractResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    conditioning: str
    original: str
    conditioning_type: str
    frame_time: float


class IcLoraDownloadResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    path: str | None = None
    already_existed: bool | None = None
    already_exists: bool | None = None


class IcLoraGenerateResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    video_path: str | None = None


class ModelDownloadStartResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    message: str | None = None
    skippingTextEncoder: bool | None = Field(None, alias="skippingTextEncoder")


class TextEncoderDownloadResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str
    message: str | None = None


class StatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    error: str
    message: str | None = None
