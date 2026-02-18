"""FastAPI application reusing the same _routes logic as the BaseHTTPRequestHandler.

Run with:
    uvicorn _fastapi_app:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Allowed origins (dev: Vite server, production: Electron loads from file://
# which sends no Origin header, so CORS doesn't apply)
# ---------------------------------------------------------------------------
ALLOWED_ORIGINS: list[str] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app = FastAPI(title="LTX-2 Video Generation Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helper: convert _routes HTTPError -> FastAPI HTTPException
# ---------------------------------------------------------------------------

@app.exception_handler(HTTPError)
async def _route_http_error_handler(_request: Request, exc: HTTPError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
    )


# ===== GET routes ==========================================================


@app.get("/health")
async def health() -> dict[str, Any]:
    from _routes import health as _health
    return _health.get_health()


@app.get("/api/gpu-info")
async def gpu_info() -> dict[str, Any]:
    from _routes import health as _health
    return _health.get_gpu_info()


@app.get("/api/warmup/status")
async def warmup_status() -> dict[str, Any]:
    from _routes import health as _health
    return _health.get_warmup_status()


@app.get("/api/models")
async def models_list() -> list[dict[str, Any]]:
    from _routes import models as _models
    return _models.get_models()


@app.get("/api/models/status")
async def models_status() -> dict[str, Any]:
    from _routes import models as _models
    return _models.get_models_status()


@app.get("/api/models/download/progress")
async def download_progress() -> dict[str, Any]:
    from _routes import models as _models
    return _models.get_download_progress()


@app.get("/api/generation/progress")
async def generation_progress() -> dict[str, Any]:
    from _routes import generation as _gen
    return _gen.get_generation_progress()


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    from _routes import settings as _settings
    return _settings.get_settings()


@app.get("/api/ic-lora/list-models")
async def ic_lora_list_models() -> dict[str, Any]:
    from _routes import ic_lora as _ic_lora
    return _ic_lora.get_list_models()


# ===== POST routes ==========================================================


@app.post("/api/models/download")
async def model_download(request: Request) -> dict[str, Any]:
    from _routes import models as _models
    data = await _safe_json(request)
    return _models.post_model_download(data)


@app.post("/api/text-encoder/download")
async def text_encoder_download() -> dict[str, Any]:
    from _routes import models as _models
    return _models.post_text_encoder_download()


@app.post("/api/settings")
async def post_settings(request: Request) -> dict[str, str]:
    from _routes import settings as _settings
    data = await _safe_json(request)
    return _settings.post_settings(data)


@app.post("/api/generate")
async def generate(request: Request) -> dict[str, Any]:
    """Video generation — accepts JSON body."""
    from _routes import generation as _gen
    data = await _safe_json(request)
    return _gen.post_generate(data)


@app.post("/api/generate/cancel")
async def generate_cancel() -> dict[str, Any]:
    from _routes import generation as _gen
    return _gen.post_cancel()


@app.post("/api/generate-image")
async def generate_image(request: Request) -> dict[str, Any]:
    from _routes import image_gen as _img
    data = await _safe_json(request)
    return _img.post_generate_image(data)


@app.post("/api/edit-image")
async def edit_image(request: Request) -> dict[str, Any]:
    """Image editing — accepts multipart/form-data."""
    from _routes import image_gen as _img
    form = await _parse_multipart(request)
    return _img.post_edit_image(form)


@app.post("/api/enhance-prompt")
async def enhance_prompt(request: Request) -> dict[str, Any]:
    from _routes import prompt as _prompt
    data = await _safe_json(request)
    return _prompt.post_enhance_prompt(data)


@app.post("/api/suggest-gap-prompt")
async def suggest_gap_prompt(request: Request) -> dict[str, Any]:
    from _routes import prompt as _prompt
    data = await _safe_json(request)
    return _prompt.post_suggest_gap_prompt(data)


@app.post("/api/upscale")
async def upscale(request: Request) -> dict[str, Any]:
    from _routes import upscale as _upscale
    data = await _safe_json(request)
    content_type = request.headers.get("content-type")
    return _upscale.post_upscale(data, content_type)


@app.post("/api/retake")
async def retake(request: Request) -> dict[str, Any]:
    from _routes import retake as _retake
    data = await _safe_json(request)
    return _retake.post_retake(data)


@app.post("/api/ic-lora/download-model")
async def ic_lora_download(request: Request) -> dict[str, Any]:
    from _routes import ic_lora as _ic_lora
    data = await _safe_json(request)
    return _ic_lora.post_download_model(data)


@app.post("/api/ic-lora/extract-conditioning")
async def ic_lora_extract(request: Request) -> dict[str, Any]:
    from _routes import ic_lora as _ic_lora
    data = await _safe_json(request)
    return _ic_lora.post_extract_conditioning(data)


@app.post("/api/ic-lora/generate")
async def ic_lora_generate(request: Request) -> dict[str, Any]:
    from _routes import ic_lora as _ic_lora
    data = await _safe_json(request)
    return _ic_lora.post_generate(data)


# ===== Helpers ==============================================================


async def _safe_json(request: Request) -> dict[str, Any]:
    """Parse JSON body, returning {} on empty or invalid body."""
    body = await request.body()
    if not body:
        return {}
    try:
        return json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return {}


async def _parse_multipart(request: Request) -> dict[str, list[Any]]:
    """Parse multipart form data into the dict[str, list] format _routes expect.

    Text fields are returned as list of bytes (matching the BaseHTTPRequestHandler
    multipart parser), and file fields as raw bytes.
    """
    form_data = await request.form()
    result: dict[str, list[Any]] = {}
    for key in form_data:
        value = form_data[key]
        if hasattr(value, "read"):
            # UploadFile
            content = await value.read()  # type: ignore[union-attr]
            result.setdefault(key, []).append(content)
        else:
            # Plain string field — encode to bytes like BaseHTTPRequestHandler does
            result.setdefault(key, []).append(str(value).encode())
    return result
