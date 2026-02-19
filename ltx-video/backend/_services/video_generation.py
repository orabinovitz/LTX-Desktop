"""Video generation and progress tracking logic."""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from datetime import datetime
from typing import TYPE_CHECKING
import torch

if TYPE_CHECKING:
    from PIL import Image

logger = logging.getLogger(__name__)


def update_generation_progress_impl(phase: str, progress: int, current_step: int = 0, total_steps: int = 0) -> None:
    """Update the current generation progress."""
    import ltx2_server as _mod

    with _mod.generation_lock:
        _mod.current_generation["phase"] = phase
        _mod.current_generation["progress"] = progress
        _mod.current_generation["current_step"] = current_step
        _mod.current_generation["total_steps"] = total_steps

@torch.inference_mode()
def generate_video_impl(
    prompt: str,
    image: Image.Image | None,
    height: int,
    width: int,
    num_frames: int,
    fps: float,
    seed: int,
    model_type: str = "fast",
    camera_motion: str = "none",
    negative_prompt: str = "",
    generation_id: str | None = None,
) -> str:
    """Generate a video using the LTX-2 pipeline."""
    import ltx2_server as _mod

    if _mod.current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")

    with _mod.settings_lock:
        ltx_api_key = _mod.app_settings.get("ltx_api_key", "")
        use_local = _mod.app_settings.get("use_local_text_encoder", False)

    if not use_local and not ltx_api_key:
        raise RuntimeError(
            "TEXT_ENCODING_NOT_CONFIGURED: "
            "To generate videos, you need to configure text encoding. "
            "Either enter an LTX API Key in Settings, or enable the Local Text Encoder."
        )

    if use_local:
        text_encoder_path = _mod.GEMMA_PATH / "text_encoder"
        if not text_encoder_path.exists() or not any(text_encoder_path.iterdir()):
            raise RuntimeError(
                "TEXT_ENCODER_NOT_DOWNLOADED: "
                "Local text encoder is enabled but not downloaded. "
                "Please download it from Settings (~8 GB), or switch to using the LTX API."
            )

    with _mod.settings_lock:
        pro_model_settings = _mod.app_settings.get("pro_model", {"steps": 20})

    if model_type in ("fast", "fast-native"):
        total_steps = 8
    else:
        total_steps = pro_model_settings.get("steps", 20)
    _mod.update_generation_progress("loading_model", 5, 0, total_steps)

    if not _mod.CHECKPOINT_PATH.exists():
        raise RuntimeError("Models not downloaded. Please download the AI models first using the Model Status menu.")

    pipeline = _mod.get_pipeline(model_type, skip_warmup=True)
    if pipeline is None:
        raise RuntimeError(f"Failed to load {model_type} pipeline. Check the console for detailed error messages.")

    from ltx_core.components.guiders import MultiModalGuiderParams
    from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.constants import AUDIO_SAMPLE_RATE

    _mod.update_generation_progress("encoding_text", 10, 0, total_steps)

    enhanced_prompt = prompt + _mod.CAMERA_MOTION_PROMPTS.get(camera_motion, "")

    images: list[tuple[str, int, float]] = []
    temp_image_path = None

    if image is not None:
        temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        image.save(temp_image_path)
        images = [(temp_image_path, 0, 1.0)]

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"ltx2_video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
    output_path = _mod.OUTPUTS_DIR / output_filename

    try:
        logger.info(f"Model: {model_type}, Camera: {camera_motion}")
        logger.info(f"Generating: {width}x{height}, {num_frames} frames, seed={seed}")
        logger.info(f"Prompt: {enhanced_prompt[:100]}...")

        start = time.time()

        tiling_config = TilingConfig.default()

        _mod._api_embeddings = None

        with _mod.settings_lock:
            ltx_api_key = _mod.app_settings.get("ltx_api_key", "")
            use_local = _mod.app_settings.get("use_local_text_encoder", False)

        # Determine gemma_root for fallback
        text_encoder_dir = _mod.GEMMA_PATH / "text_encoder"
        text_encoder_available = text_encoder_dir.exists() and any(text_encoder_dir.iterdir())
        gemma_root = str(_mod.GEMMA_PATH) if (use_local or not ltx_api_key) and text_encoder_available else None

        if ltx_api_key and not use_local:
            if _mod._cached_model_id is None:
                _mod._cached_model_id = _mod.get_model_id_from_checkpoint(str(_mod.CHECKPOINT_PATH))

            if _mod._cached_model_id:
                embeddings = _mod.encode_text_via_api(enhanced_prompt, ltx_api_key, _mod._cached_model_id)
                if embeddings is not None:
                    _mod._api_embeddings = embeddings
                else:
                    if gemma_root is None:
                        raise RuntimeError(
                            "LTX API text encoding failed and local text encoder is not available. "
                            "Please download the text encoder from Settings or check your API key."
                        )
                    logger.info("Falling back to local text encoder")
            else:
                if gemma_root is None:
                    raise RuntimeError(
                        "Could not extract model_id for API encoding and local text encoder is not available. "
                        "Please download the text encoder from Settings."
                    )
                logger.warning("Could not extract model_id, using local encoder")

        _mod.update_generation_progress("inference", 15, 0, total_steps)

        with _mod.settings_lock:
            pro_settings = _mod.app_settings.get("pro_model", {"steps": 20, "use_upscaler": True})

        try:
            if model_type in ("fast", "fast-native"):
                video, audio = pipeline(
                    prompt=enhanced_prompt,
                    seed=seed,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    frame_rate=fps,
                    images=images,
                    tiling_config=tiling_config,
                )
            elif model_type == "pro":
                pro_steps = pro_settings.get("steps", 20)
                neg_prompt = negative_prompt if negative_prompt else _mod.DEFAULT_NEGATIVE_PROMPT
                video, audio = pipeline(
                    prompt=enhanced_prompt,
                    negative_prompt=neg_prompt,
                    seed=seed,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    frame_rate=fps,
                    num_inference_steps=pro_steps,
                    video_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                    audio_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                    images=images,
                    tiling_config=tiling_config,
                )
            elif model_type == "pro-native":
                pro_steps = pro_settings.get("steps", 20)
                neg_prompt = negative_prompt if negative_prompt else _mod.DEFAULT_NEGATIVE_PROMPT
                video, audio = pipeline(
                    prompt=enhanced_prompt,
                    negative_prompt=neg_prompt,
                    seed=seed,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    frame_rate=fps,
                    num_inference_steps=pro_steps,
                    video_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                    audio_guider_params=MultiModalGuiderParams(cfg_scale=3.0),
                    images=images,
                )
            else:
                raise RuntimeError(f"Unknown model type: {model_type}")

            video_chunks_number = get_video_chunks_number(
                num_frames, tiling_config if model_type != "pro-native" else None
            )
            encode_video(
                video=video,
                fps=int(fps),
                audio=audio,
                audio_sample_rate=AUDIO_SAMPLE_RATE,
                output_path=str(output_path),
                video_chunks_number=video_chunks_number,
            )
        finally:
            _mod._api_embeddings = None

        if _mod.current_generation["cancelled"]:
            if output_path.exists():
                output_path.unlink()
            raise RuntimeError("Generation was cancelled")

        _mod.update_generation_progress("complete", 100, total_steps, total_steps)

        logger.info(f"Generation took {time.time() - start:.1f}s")
        logger.info(f"Saved to {output_path}")
        return str(output_path)

    finally:
        if temp_image_path and os.path.exists(temp_image_path):
            os.unlink(temp_image_path)
