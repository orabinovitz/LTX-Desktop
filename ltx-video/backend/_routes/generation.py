"""Route handlers for /api/generate, /api/generate/cancel, /api/generation/progress."""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, TYPE_CHECKING, cast

if TYPE_CHECKING:
    from _services.pipeline_manager import ModelType

from PIL import Image

from fastapi import APIRouter

from _models import (
    GenerateVideoRequest,
    GenerateVideoResponse,
    CancelResponse,
    GenerationProgressResponse,
)
from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["generation"])


@router.post("/generate", response_model=GenerateVideoResponse)
async def route_generate(req: GenerateVideoRequest):
    return post_generate(req)


@router.post("/generate/cancel", response_model=CancelResponse)
async def route_generate_cancel():
    return post_cancel()


@router.get("/generation/progress", response_model=GenerationProgressResponse)
async def route_generation_progress():
    return get_generation_progress()


def get_generation_progress() -> dict[str, Any]:
    """GET /api/generation/progress"""
    import ltx2_server as _mod

    with _mod.generation_lock:
        return {
            "status": _mod.current_generation["status"],
            "phase": _mod.current_generation["phase"],
            "progress": _mod.current_generation["progress"],
            "currentStep": _mod.current_generation["current_step"],
            "totalSteps": _mod.current_generation["total_steps"],
        }


def post_generate(req: GenerateVideoRequest) -> dict[str, Any]:
    """POST /api/generate — video generation from JSON body."""
    import ltx2_server as _mod

    if _mod.current_generation["status"] == "running":
        raise HTTPError(409, "Generation already in progress")

    resolution = req.resolution
    model_type = req.model

    duration = int(float(req.duration))
    fps = int(float(req.fps))

    use_upsampler = resolution == "1080p"
    if not use_upsampler:
        if model_type == "fast":
            model_type = "fast-native"
            logger.info(f"Resolution {resolution} - using fast-native pipeline (no upsampler)")
        elif model_type == "pro":
            model_type = "pro-native"
            logger.info(f"Resolution {resolution} - using pro-native pipeline (no upsampler)")
    else:
        logger.info(f"Resolution {resolution} - using 2-stage pipeline with upsampler")

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
    image_path = req.imagePath
    if image_path:
        if not os.path.isfile(image_path):
            raise HTTPError(400, f"Image file not found: {image_path}")
        img = Image.open(image_path).convert("RGB")
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
        logger.info(f"Image: {image_path} {img_w}x{img_h} -> {width}x{height}")

    generation_id = uuid.uuid4().hex[:8]
    with _mod.generation_lock:
        _mod.current_generation["id"] = generation_id
        _mod.current_generation["cancelled"] = False
        _mod.current_generation["result"] = None
        _mod.current_generation["error"] = None
        _mod.current_generation["status"] = "running"

    settings = _mod.get_settings_snapshot()
    if settings.seed_locked:
        seed = settings.locked_seed
        logger.info(f"Using locked seed: {seed}")
    else:
        seed = int(time.time()) % 2147483647

    try:
        output_path = _mod.generate_video(
            prompt=req.prompt,
            image=image,
            height=height,
            width=width,
            num_frames=num_frames,
            fps=fps,
            seed=seed,
            model_type=cast("ModelType", model_type),
            camera_motion=req.cameraMotion,
            negative_prompt=req.negativePrompt,
            generation_id=generation_id,
        )

        with _mod.generation_lock:
            _mod.current_generation["status"] = "complete"
            _mod.current_generation["result"] = output_path

        return {"status": "complete", "video_path": output_path}

    except Exception as e:
        with _mod.generation_lock:
            if _mod.current_generation["cancelled"]:
                _mod.current_generation["status"] = "cancelled"
            else:
                _mod.current_generation["status"] = "error"
                _mod.current_generation["error"] = str(e)

        if "cancelled" in str(e).lower():
            logger.info("Generation cancelled by user")
            return {"status": "cancelled"}
        else:
            logger.error(f"Generation error: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPError(500, str(e))


def post_cancel() -> dict[str, Any]:
    """POST /api/generate/cancel"""
    import ltx2_server as _mod

    with _mod.generation_lock:
        if _mod.current_generation["status"] == "running":
            _mod.current_generation["cancelled"] = True
            logger.info(f"Cancel requested for generation {_mod.current_generation['id']}")
            return {"status": "cancelling", "id": _mod.current_generation["id"]}
        else:
            return {"status": "no_active_generation"}
