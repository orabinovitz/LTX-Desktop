"""Route handlers for /api/generate-image, /api/edit-image."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from PIL import Image
from io import BytesIO

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)


def post_generate_image(data: dict[str, Any]) -> dict[str, Any]:
    """POST /api/generate-image"""
    import ltx2_server as _mod

    if _mod.current_generation["status"] == "running":
        raise HTTPError(409, "Generation already in progress")

    prompt = data.get("prompt", "A beautiful image")
    width = int(data.get("width", 1024))
    height = int(data.get("height", 1024))
    num_steps = int(data.get("numSteps", 4))
    num_images = int(data.get("numImages", 1))

    num_images = max(1, min(12, num_images))
    width = (width // 16) * 16
    height = (height // 16) * 16

    generation_id = uuid.uuid4().hex[:8]
    with _mod.generation_lock:
        _mod.current_generation["id"] = generation_id
        _mod.current_generation["cancelled"] = False
        _mod.current_generation["result"] = None
        _mod.current_generation["error"] = None
        _mod.current_generation["status"] = "running"

    if _mod.app_settings.get("seed_locked", False):
        seed = _mod.app_settings.get("locked_seed", 42)
        logger.info(f"Using locked seed for image: {seed}")
    else:
        seed = int(time.time()) % 2147483647

    try:
        output_paths = _mod.generate_image(
            prompt=prompt,
            width=width,
            height=height,
            num_inference_steps=num_steps,
            seed=seed,
            generation_id=generation_id,
            num_images=num_images,
        )

        with _mod.generation_lock:
            _mod.current_generation["status"] = "complete"
            _mod.current_generation["result"] = output_paths

        return {"status": "complete", "image_paths": output_paths}

    except Exception as e:
        with _mod.generation_lock:
            if _mod.current_generation["cancelled"]:
                _mod.current_generation["status"] = "cancelled"
            else:
                _mod.current_generation["status"] = "error"
                _mod.current_generation["error"] = str(e)

        if "cancelled" in str(e).lower():
            logger.info("Image generation cancelled by user")
            return {"status": "cancelled"}
        else:
            logger.error(f"Image generation error: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPError(500, str(e))


def post_edit_image(form: dict[str, list[Any]]) -> dict[str, Any]:
    """POST /api/edit-image — multipart form data."""
    import ltx2_server as _mod

    if _mod.current_generation["status"] == "running":
        raise HTTPError(409, "Generation already in progress")

    def get_form_value(key: str, default: Any) -> Any:
        val = form.get(key, [default])[0]
        if isinstance(val, bytes):
            val = val.decode()
        return val

    prompt = get_form_value("prompt", "Edit this image")
    width = int(get_form_value("width", "1024"))
    height = int(get_form_value("height", "1024"))
    num_steps = int(get_form_value("numSteps", "4"))

    width = (width // 16) * 16
    height = (height // 16) * 16

    input_images: list[Any] = []
    image_data = form.get("image", [None])[0]
    if image_data:
        img = Image.open(BytesIO(image_data)).convert("RGB")
        input_images.append(img)

    for i in range(2, 9):
        extra_data = form.get(f"image{i}", [None])[0]
        if extra_data:
            extra_img = Image.open(BytesIO(extra_data)).convert("RGB")
            input_images.append(extra_img)

    if not input_images:
        raise HTTPError(400, "At least one input image is required for editing")

    logger.info(f"Image edit request: {len(input_images)} reference(s), {width}x{height}, {num_steps} steps")

    generation_id = uuid.uuid4().hex[:8]
    with _mod.generation_lock:
        _mod.current_generation["id"] = generation_id
        _mod.current_generation["cancelled"] = False
        _mod.current_generation["result"] = None
        _mod.current_generation["error"] = None
        _mod.current_generation["status"] = "running"

    if _mod.app_settings.get("seed_locked", False):
        seed = _mod.app_settings.get("locked_seed", 42)
        logger.info(f"Using locked seed for edit: {seed}")
    else:
        seed = int(time.time()) % 2147483647

    try:
        output_paths = _mod.edit_image(
            prompt=prompt,
            input_images=input_images,
            width=width,
            height=height,
            num_inference_steps=num_steps,
            seed=seed,
            generation_id=generation_id,
        )

        with _mod.generation_lock:
            _mod.current_generation["status"] = "complete"
            _mod.current_generation["result"] = output_paths

        return {"status": "complete", "image_paths": output_paths}

    except Exception as e:
        with _mod.generation_lock:
            if _mod.current_generation["cancelled"]:
                _mod.current_generation["status"] = "cancelled"
            else:
                _mod.current_generation["status"] = "error"
                _mod.current_generation["error"] = str(e)

        if "cancelled" in str(e).lower():
            logger.info("Image edit cancelled by user")
            return {"status": "cancelled"}
        else:
            logger.error(f"Image edit error: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPError(500, str(e))
