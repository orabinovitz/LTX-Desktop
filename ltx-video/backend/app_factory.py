"""FastAPI app factory decoupled from runtime bootstrap side effects."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from _routes._errors import HTTPError
from _routes.generation import router as generation_router
from _routes.health import router as health_router
from _routes.ic_lora import router as ic_lora_router
from _routes.image_gen import router as image_gen_router
from _routes.models import router as models_router
from _routes.prompt import router as prompt_router
from _routes.retake import router as retake_router
from _routes.settings import router as settings_router
from logging_policy import log_http_error, log_unhandled_exception
from state import init_state_service

if TYPE_CHECKING:
    from app_handler import AppHandler

DEFAULT_ALLOWED_ORIGINS: list[str] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def create_app(
    *,
    handler: "AppHandler",
    allowed_origins: list[str] | None = None,
    title: str = "LTX-2 Video Generation Server",
) -> FastAPI:
    """Create a configured FastAPI app bound to the provided handler."""
    init_state_service(handler)

    app = FastAPI(title=title)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins or DEFAULT_ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        detail = first.get("msg", "Validation error")
        return JSONResponse(status_code=422, content={"error": detail})

    @app.exception_handler(HTTPError)
    async def _route_http_error_handler(request: Request, exc: HTTPError) -> JSONResponse:
        log_http_error(request, exc)
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.exception_handler(Exception)
    async def _route_generic_error_handler(request: Request, exc: Exception) -> JSONResponse:
        log_unhandled_exception(request, exc)
        return JSONResponse(status_code=500, content={"error": str(exc)})

    app.include_router(health_router)
    app.include_router(generation_router)
    app.include_router(models_router)
    app.include_router(settings_router)
    app.include_router(image_gen_router)
    app.include_router(prompt_router)
    app.include_router(retake_router)
    app.include_router(ic_lora_router)

    return app
