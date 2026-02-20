"""Route handlers for /api/generate-image, /api/edit-image."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from PIL import Image
from io import BytesIO

from fastapi import APIRouter, UploadFile, File, Form

from _models import GenerateImageRequest, GenerateImageResponse
from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["image"])


@router.post("/generate-image", response_model=GenerateImageResponse)
def route_generate_image(req: GenerateImageRequest):
    return post_generate_image(req)


@router.post("/edit-image", response_model=GenerateImageResponse)
def route_edit_image(
    prompt: str = Form("Edit this image"),
    width: int = Form(1024),
    height: int = Form(1024),
    numSteps: int = Form(4),
    image: UploadFile = File(...),
    image2: UploadFile | None = File(None),
    image3: UploadFile | None = File(None),
    image4: UploadFile | None = File(None),
    image5: UploadFile | None = File(None),
    image6: UploadFile | None = File(None),
    image7: UploadFile | None = File(None),
    image8: UploadFile | None = File(None),
):
    # Build the form dict that post_edit_image expects
    form: dict = {}
    form["prompt"] = [prompt.encode()]
    form["width"] = [str(width).encode()]
    form["height"] = [str(height).encode()]
    form["numSteps"] = [str(numSteps).encode()]

    img_data = image.file.read()
    form["image"] = [img_data]

    for i, upload in enumerate([image2, image3, image4, image5, image6, image7, image8], start=2):
        if upload is not None:
            data = upload.file.read()
            form[f"image{i}"] = [data]

    return post_edit_image(form)


def post_generate_image(req: GenerateImageRequest) -> dict[str, Any]:
    """POST /api/generate-image"""
    import ltx2_server as _mod

    if _mod.current_generation["status"] == "running":
        raise HTTPError(409, "Generation already in progress")

    width = req.width
    height = req.height
    num_images = req.numImages

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

    settings = _mod.get_settings_snapshot()
    if settings.seed_locked:
        seed = settings.locked_seed
        logger.info(f"Using locked seed for image: {seed}")
    else:
        seed = int(time.time()) % 2147483647

    try:
        output_paths = _mod.generate_image(
            prompt=req.prompt,
            width=width,
            height=height,
            num_inference_steps=req.numSteps,
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

    settings = _mod.get_settings_snapshot()
    if settings.seed_locked:
        seed = settings.locked_seed
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
