"""Pipeline loading, unloading, compilation, and warmup logic."""

from __future__ import annotations

import gc
import logging
import time
from typing import Any, Literal, TYPE_CHECKING, Union, overload

if TYPE_CHECKING:
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
    from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline
    from ltx_pipelines.ic_lora import ICLoraPipeline
    import ltx2_server as _ltx_mod

    VideoPipeline = Union[
        DistilledPipeline,
        _ltx_mod.DistilledNativePipeline,
        TI2VidTwoStagesPipeline,
        TI2VidOneStagePipeline,
    ]

ModelType = Literal["fast", "fast-native", "pro", "pro-native"]

logger = logging.getLogger(__name__)


def compile_pipeline_transformer(pipeline: VideoPipeline, model_type: ModelType) -> None:
    """Compile the transformer model using torch.compile() for faster inference."""
    import ltx2_server as _mod
    import torch

    if not _mod.get_settings_snapshot().use_torch_compile:
        logger.info(f"torch.compile() disabled in settings, skipping for {model_type}")
        return

    if _mod.compiled_models.get(model_type):
        logger.info(f"Transformer for {model_type} already compiled")
        return

    try:
        transformer = pipeline.model_ledger.transformer()

        if transformer is not None:
            logger.info(f"Compiling {model_type} transformer with torch.compile()...")
            start = time.time()

            compiled_transformer = torch.compile(
                transformer,
                mode="reduce-overhead",
                fullgraph=False,
            )

            def compiled_transformer_method() -> Any:
                return compiled_transformer

            pipeline.model_ledger.transformer = compiled_transformer_method
            _mod.compiled_models[model_type] = True
            logger.info(f"Transformer compiled in {time.time() - start:.1f}s")
        else:
            logger.warning(f"Could not access transformer for {model_type}")

    except Exception as e:
        logger.warning(f"Failed to compile transformer for {model_type}: {e}")
        logger.warning("Continuing without torch.compile() optimization")


@overload
def load_pipeline_impl(model_type: Literal["fast"] = ...) -> DistilledPipeline | None: ...
@overload
def load_pipeline_impl(model_type: Literal["fast-native"]) -> _ltx_mod.DistilledNativePipeline | None: ...
@overload
def load_pipeline_impl(model_type: Literal["pro"]) -> TI2VidTwoStagesPipeline | None: ...
@overload
def load_pipeline_impl(model_type: Literal["pro-native"]) -> TI2VidOneStagePipeline | None: ...

def load_pipeline_impl(model_type: ModelType = "fast") -> VideoPipeline | None:
    """Load the appropriate LTX-2 pipeline based on model type."""
    import ltx2_server as _mod

    if not _mod.CHECKPOINT_PATH.exists():
        logger.warning(f"Model checkpoint not found at {_mod.CHECKPOINT_PATH}. Models need to be downloaded first.")
        return None

    if model_type in ("fast", "pro") and not _mod.UPSAMPLER_PATH.exists():
        logger.warning(f"Upsampler not found at {_mod.UPSAMPLER_PATH}. Models need to be downloaded first.")
        return None

    _mod.patch_encode_text_for_api()
    _mod.patch_model_ledger_class()

    settings = _mod.get_settings_snapshot()
    ltx_api_key = settings.ltx_api_key
    use_local = settings.use_local_text_encoder

    text_encoder_dir = _mod.GEMMA_PATH / "text_encoder"
    text_encoder_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())
    gemma_root = str(_mod.GEMMA_PATH) if (use_local or not ltx_api_key) and text_encoder_available else None

    try:
        if model_type == "fast" and _mod.distilled_pipeline is None:
            from ltx_pipelines.distilled import DistilledPipeline

            logger.info("Loading LTX-2 Distilled Pipeline (Fast, 2-stage with upsampling)...")
            start = time.time()
            from ltx_core.quantization import QuantizationPolicy

            _mod.distilled_pipeline = DistilledPipeline(
                checkpoint_path=str(_mod.CHECKPOINT_PATH),
                gemma_root=gemma_root,
                spatial_upsampler_path=str(_mod.UPSAMPLER_PATH),
                loras=[],
                device=_mod.DEVICE,
                quantization=QuantizationPolicy.fp8_cast(),
            )
            compile_pipeline_transformer(_mod.distilled_pipeline, "fast")
            logger.info(f"Distilled Pipeline loaded in {time.time() - start:.1f}s")
            return _mod.distilled_pipeline

        elif model_type == "fast-native" and _mod.distilled_native_pipeline is None:
            logger.info("Loading LTX-2 Fast Native Pipeline (8-step distilled, no upsampler)...")
            start = time.time()
            _mod.distilled_native_pipeline = _mod.DistilledNativePipeline(
                checkpoint_path=str(_mod.CHECKPOINT_PATH),
                gemma_root=gemma_root,
                device=_mod.DEVICE,
                fp8transformer=True,  # translated to QuantizationPolicy inside the class
            )
            compile_pipeline_transformer(_mod.distilled_native_pipeline, "fast-native")
            logger.info(f"Fast Native Pipeline loaded in {time.time() - start:.1f}s")
            return _mod.distilled_native_pipeline

        elif model_type == "pro" and _mod.pro_pipeline is None:
            from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline

            logger.info("Loading LTX-2 Two-Stage Pipeline (Pro)...")
            start = time.time()
            from ltx_core.quantization import QuantizationPolicy
            from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
            from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP

            _mod.pro_pipeline = TI2VidTwoStagesPipeline(
                checkpoint_path=str(_mod.CHECKPOINT_PATH),
                gemma_root=gemma_root,
                spatial_upsampler_path=str(_mod.UPSAMPLER_PATH),
                distilled_lora=[
                    LoraPathStrengthAndSDOps(
                        str(_mod.DISTILLED_LORA_PATH), 1.0, LTXV_LORA_COMFY_RENAMING_MAP,
                    ),
                ],
                loras=[],
                device=_mod.DEVICE,
                quantization=QuantizationPolicy.fp8_cast(),
            )
            compile_pipeline_transformer(_mod.pro_pipeline, "pro")
            logger.info(f"Pro Pipeline loaded in {time.time() - start:.1f}s")
            return _mod.pro_pipeline

        elif model_type == "pro-native" and _mod.pro_native_pipeline is None:
            from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline

            logger.info("Loading LTX-2 One-Stage Pipeline (Pro Native, no upscaler)...")
            start = time.time()
            from ltx_core.quantization import QuantizationPolicy

            _mod.pro_native_pipeline = TI2VidOneStagePipeline(
                checkpoint_path=str(_mod.CHECKPOINT_PATH),
                gemma_root=gemma_root,
                loras=[],
                device=_mod.DEVICE,
                quantization=QuantizationPolicy.fp8_cast(),
            )
            compile_pipeline_transformer(_mod.pro_native_pipeline, "pro-native")
            logger.info(f"Pro Native Pipeline loaded in {time.time() - start:.1f}s")
            return _mod.pro_native_pipeline

        if model_type == "fast":
            return _mod.distilled_pipeline
        elif model_type == "fast-native":
            return _mod.distilled_native_pipeline
        elif model_type == "pro":
            return _mod.pro_pipeline
        elif model_type == "pro-native":
            return _mod.pro_native_pipeline
        return None

    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        import traceback
        traceback.print_exc()
        return None


def unload_pipeline_impl(model_type: str) -> None:
    """Unload a pipeline to free VRAM."""
    import ltx2_server as _mod
    import torch

    if model_type == "fast" and _mod.distilled_pipeline is not None:
        logger.info("Unloading Fast pipeline to free VRAM...")
        del _mod.distilled_pipeline
        _mod.distilled_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Fast pipeline unloaded")
    elif model_type == "fast-native" and _mod.distilled_native_pipeline is not None:
        logger.info("Unloading Fast Native pipeline to free VRAM...")
        del _mod.distilled_native_pipeline
        _mod.distilled_native_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Fast Native pipeline unloaded")
    elif model_type == "pro" and _mod.pro_pipeline is not None:
        logger.info("Unloading Pro pipeline to free VRAM...")
        del _mod.pro_pipeline
        _mod.pro_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Pro pipeline unloaded")
    elif model_type == "pro-native" and _mod.pro_native_pipeline is not None:
        logger.info("Unloading Pro Native pipeline to free VRAM...")
        del _mod.pro_native_pipeline
        _mod.pro_native_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Pro Native pipeline unloaded")
    elif model_type == "flux" and _mod.flux_pipeline is not None:
        logger.info("Unloading Flux pipeline to free VRAM...")
        del _mod.flux_pipeline
        _mod.flux_pipeline = None
        _mod.flux_on_gpu = False
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Flux pipeline unloaded")
    elif model_type == "ic-lora" and _mod.ic_lora_pipeline is not None:
        logger.info("Unloading IC-LoRA pipeline to free VRAM...")
        del _mod.ic_lora_pipeline
        _mod.ic_lora_pipeline = None
        _mod.ic_lora_pipeline_path = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("IC-LoRA pipeline unloaded")


@overload
def get_pipeline_impl(model_type: Literal["fast"] = ..., skip_warmup: bool = ...) -> DistilledPipeline | None: ...
@overload
def get_pipeline_impl(model_type: Literal["fast-native"], skip_warmup: bool = ...) -> _ltx_mod.DistilledNativePipeline | None: ...
@overload
def get_pipeline_impl(model_type: Literal["pro"], skip_warmup: bool = ...) -> TI2VidTwoStagesPipeline | None: ...
@overload
def get_pipeline_impl(model_type: Literal["pro-native"], skip_warmup: bool = ...) -> TI2VidOneStagePipeline | None: ...

def get_pipeline_impl(model_type: ModelType = "fast", skip_warmup: bool = False) -> VideoPipeline | None:
    """Get or load the appropriate pipeline."""
    import ltx2_server as _mod
    import torch

    if _mod.flux_pipeline is not None and _mod.flux_on_gpu:
        logger.info("Moving Flux pipeline to CPU to free VRAM for video generation...")
        _mod.flux_pipeline.to("cpu")
        _mod.flux_on_gpu = False
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Flux pipeline moved to CPU (preserved in RAM)")

    def unload_others(keep: str) -> None:
        if keep != "fast" and _mod.distilled_pipeline is not None:
            _mod.unload_pipeline("fast")
        if keep != "fast-native" and _mod.distilled_native_pipeline is not None:
            _mod.unload_pipeline("fast-native")
        if keep != "pro" and _mod.pro_pipeline is not None:
            _mod.unload_pipeline("pro")
        if keep != "pro-native" and _mod.pro_native_pipeline is not None:
            _mod.unload_pipeline("pro-native")

    if model_type == "fast":
        if _mod.distilled_pipeline is None:
            unload_others("fast")
            _mod.load_pipeline("fast")
            if not skip_warmup:
                _mod.warmup_pipeline("fast")
        return _mod.distilled_pipeline
    elif model_type == "fast-native":
        if _mod.distilled_native_pipeline is None:
            unload_others("fast-native")
            _mod.load_pipeline("fast-native")
        return _mod.distilled_native_pipeline
    elif model_type == "pro":
        if _mod.pro_pipeline is None:
            unload_others("pro")
            _mod.load_pipeline("pro")
            if not skip_warmup:
                _mod.warmup_pipeline("pro")
        return _mod.pro_pipeline
    elif model_type == "pro-native":
        if _mod.pro_native_pipeline is None:
            unload_others("pro-native")
            _mod.load_pipeline("pro-native")
        return _mod.pro_native_pipeline

    return None


def warmup_pipeline_impl(model_type: ModelType) -> None:
    """Run a minimal generation to pre-load all weights."""
    import ltx2_server as _mod

    pipeline = _mod.get_pipeline(model_type)
    if pipeline is None:
        logger.warning(f"Cannot warmup {model_type} pipeline - not loaded")
        return

    logger.info(f"Warming up {model_type} pipeline (loading text encoder)...")

    try:
        from ltx_pipelines.distilled import DistilledPipeline
        from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
        from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline
        from ltx_core.components.guiders import MultiModalGuiderParams
        from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
        from ltx_pipelines.utils.constants import AUDIO_SAMPLE_RATE
        from ltx_pipelines.utils.media_io import encode_video

        warmup_path = _mod.OUTPUTS_DIR / f"_warmup_{model_type}.mp4"
        warmup_height = 256
        warmup_width = 384
        warmup_frames = 9

        if isinstance(pipeline, (DistilledPipeline, _mod.DistilledNativePipeline)):
            video, audio = pipeline(
                prompt="test warmup",
                seed=42,
                height=warmup_height,
                width=warmup_width,
                num_frames=warmup_frames,
                frame_rate=8,
                images=[],
                tiling_config=TilingConfig.default(),
            )
            video_chunks_number = get_video_chunks_number(warmup_frames, TilingConfig.default())
        elif isinstance(pipeline, TI2VidOneStagePipeline):
            video, audio = pipeline(
                prompt="test warmup",
                negative_prompt="",
                seed=42,
                height=warmup_height,
                width=warmup_width,
                num_frames=warmup_frames,
                frame_rate=8,
                num_inference_steps=5,
                video_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                audio_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                images=[],
            )
            video_chunks_number = 1
        elif isinstance(pipeline, TI2VidTwoStagesPipeline):
            video, audio = pipeline(
                prompt="test warmup",
                negative_prompt="",
                seed=42,
                height=warmup_height,
                width=warmup_width,
                num_frames=warmup_frames,
                frame_rate=8,
                num_inference_steps=5,
                video_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                audio_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                images=[],
                tiling_config=TilingConfig.default(),
            )
            video_chunks_number = get_video_chunks_number(warmup_frames, TilingConfig.default())
        else:
            raise RuntimeError(f"Unknown pipeline type: {type(pipeline)}")

        encode_video(
            video=video,
            fps=8,
            audio=audio,
            audio_sample_rate=AUDIO_SAMPLE_RATE,
            output_path=str(warmup_path),
            video_chunks_number=video_chunks_number,
        )

        if warmup_path.exists():
            warmup_path.unlink()

        logger.info(f"{model_type.capitalize()} pipeline warmed up - text encoder loaded!")

    except Exception as e:
        logger.error(f"Warmup failed for {model_type}: {e}")
        import traceback
        traceback.print_exc()


def load_ic_lora_pipeline_impl(lora_path: str) -> ICLoraPipeline:
    """Load the IC-LoRA pipeline with a specific LoRA file."""
    import ltx2_server as _mod
    import torch

    lora_path_str = str(lora_path)

    if _mod.ic_lora_pipeline is not None and _mod.ic_lora_pipeline_path == lora_path_str:
        return _mod.ic_lora_pipeline

    if _mod.ic_lora_pipeline is not None:
        logger.info(f"Switching IC-LoRA from {_mod.ic_lora_pipeline_path} to {lora_path_str}")
        del _mod.ic_lora_pipeline
        _mod.ic_lora_pipeline = None
        _mod.ic_lora_pipeline_path = None
        torch.cuda.empty_cache()
        gc.collect()

    _mod.unload_pipeline("fast")
    _mod.unload_pipeline("fast-native")
    _mod.unload_pipeline("pro")
    _mod.unload_pipeline("pro-native")

    _mod.patch_encode_text_for_api()
    _mod.patch_model_ledger_class()

    settings = _mod.get_settings_snapshot()
    ltx_api_key = settings.ltx_api_key
    use_local = settings.use_local_text_encoder

    text_encoder_dir = _mod.GEMMA_PATH / "text_encoder"
    text_encoder_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())
    gemma_root = str(_mod.GEMMA_PATH) if (use_local or not ltx_api_key) and text_encoder_available else None

    try:
        from ltx_pipelines.ic_lora import ICLoraPipeline
        from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
        from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP

        logger.info(f"Loading IC-LoRA pipeline with LoRA: {lora_path_str}")
        start = time.time()

        lora_entry = LoraPathStrengthAndSDOps(
            path=lora_path_str, strength=1.0, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP
        )

        from ltx_core.quantization import QuantizationPolicy

        _mod.ic_lora_pipeline = ICLoraPipeline(
            checkpoint_path=str(_mod.CHECKPOINT_PATH),
            spatial_upsampler_path=str(_mod.UPSAMPLER_PATH),
            gemma_root=gemma_root,
            loras=[lora_entry],
            device=_mod.DEVICE,
            quantization=QuantizationPolicy.fp8_cast(),
        )

        _mod.ic_lora_pipeline_path = lora_path_str
        logger.info(f"IC-LoRA pipeline loaded in {time.time() - start:.1f}s")
        return _mod.ic_lora_pipeline

    except Exception as e:
        logger.error(f"Failed to load IC-LoRA pipeline: {e}")
        import traceback
        traceback.print_exc()
        _mod.ic_lora_pipeline = None
        _mod.ic_lora_pipeline_path = None
        raise
