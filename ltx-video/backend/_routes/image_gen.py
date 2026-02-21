"""Route handlers for /api/generate-image, /api/edit-image."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, UploadFile

from api_types import GenerateImageRequest, GenerateImageResponse
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api", tags=["image"])
MultipartForm = dict[str, list[bytes]]


@router.post("/generate-image", response_model=GenerateImageResponse)
def route_generate_image(
    req: GenerateImageRequest,
    handler: AppHandler = Depends(get_state_service),
) -> GenerateImageResponse:
    """POST /api/generate-image."""
    return handler.image_generation.generate(req)


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
    handler: AppHandler = Depends(get_state_service),
) -> GenerateImageResponse:
    form: MultipartForm = {}
    form["prompt"] = [prompt.encode()]
    form["width"] = [str(width).encode()]
    form["height"] = [str(height).encode()]
    form["numSteps"] = [str(numSteps).encode()]
    form["image"] = [image.file.read()]

    for idx, upload in enumerate([image2, image3, image4, image5, image6, image7, image8], start=2):
        if upload is not None:
            form[f"image{idx}"] = [upload.file.read()]

    return handler.image_generation.edit(form)
