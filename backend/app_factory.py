"""FastAPI app factory decoupled from runtime bootstrap side effects."""

from __future__ import annotations

import base64
import hmac
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import Response as StarletteResponse

from _routes._errors import HTTPError

_logger = logging.getLogger(__name__)
from _routes.agent import router as agent_router
from _routes.generation import router as generation_router
from _routes.health import router as health_router
from _routes.ic_lora import router as ic_lora_router
from _routes.image_gen import router as image_gen_router
from _routes.models import router as models_router
from _routes.suggest_gap_prompt import router as suggest_gap_prompt_router
from _routes.retake import router as retake_router
from _routes.runtime_policy import router as runtime_policy_router
from _routes.settings import router as settings_router
from log_context import bind_log_context, ensure_request_context, reset_log_context
from logging_policy import log_http_error, log_unhandled_exception, log_validation_error
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
    auth_token: str = "",
    admin_token: str = "",
) -> FastAPI:
    """Create a configured FastAPI app bound to the provided handler."""
    init_state_service(handler)

    app = FastAPI(title=title)
    app.state.admin_token = admin_token  # type: ignore[attr-defined]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins or DEFAULT_ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _auth_middleware(  # pyright: ignore[reportUnusedFunction]
        request: Request,
        call_next: Callable[[Request], Awaitable[StarletteResponse]],
    ) -> StarletteResponse:
        request_id, trace_id = ensure_request_context(request)
        tokens = bind_log_context(request_id=request_id, trace_id=trace_id)
        try:
            if not auth_token:
                response = await call_next(request)
                response.headers.setdefault("X-Request-ID", request_id)
                response.headers.setdefault("X-Trace-ID", trace_id)
                return response
            if request.method == "OPTIONS":
                response = await call_next(request)
                response.headers.setdefault("X-Request-ID", request_id)
                response.headers.setdefault("X-Trace-ID", trace_id)
                return response

            def _token_matches(candidate: str) -> bool:
                return hmac.compare_digest(candidate, auth_token)

            # WebSocket: check Sec-WebSocket-Protocol header (bearer.<token>) or query param (legacy)
            if request.headers.get("upgrade", "").lower() == "websocket":
                ws_protocols = request.headers.get("sec-websocket-protocol", "")
                for proto in ws_protocols.split(","):
                    proto = proto.strip()
                    if proto.startswith("bearer.") and _token_matches(proto[7:]):
                        response = await call_next(request)
                        response.headers.setdefault("X-Request-ID", request_id)
                        response.headers.setdefault("X-Trace-ID", trace_id)
                        return response
                if _token_matches(request.query_params.get("token", "")):
                    response = await call_next(request)
                    response.headers.setdefault("X-Request-ID", request_id)
                    response.headers.setdefault("X-Trace-ID", trace_id)
                    return response
                return JSONResponse(
                    status_code=401,
                    content={"error": "Unauthorized"},
                    headers={"X-Request-ID": request_id, "X-Trace-ID": trace_id},
                )
            # HTTP: Bearer or Basic auth
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Bearer ") and _token_matches(auth_header[7:]):
                response = await call_next(request)
                response.headers.setdefault("X-Request-ID", request_id)
                response.headers.setdefault("X-Trace-ID", trace_id)
                return response
            if auth_header.startswith("Basic "):
                try:
                    decoded = base64.b64decode(auth_header[6:]).decode()
                    _, _, password = decoded.partition(":")
                    if _token_matches(password):
                        response = await call_next(request)
                        response.headers.setdefault("X-Request-ID", request_id)
                        response.headers.setdefault("X-Trace-ID", trace_id)
                        return response
                except Exception:
                    _logger.warning(
                        "Malformed Basic auth on %s %s",
                        request.method,
                        request.url.path,
                    )
            return JSONResponse(
                status_code=401,
                content={"error": "Unauthorized"},
                headers={"X-Request-ID": request_id, "X-Trace-ID": trace_id},
            )
        finally:
            reset_log_context(tokens)

    _FALLBACK = "An unexpected error occurred"

    async def _route_http_error_handler(request: Request, exc: Exception) -> JSONResponse:
        if isinstance(exc, HTTPError):
            log_http_error(request, exc)
            return JSONResponse(status_code=exc.status_code, content={"error": exc.detail or _FALLBACK})
        return JSONResponse(status_code=500, content={"error": _FALLBACK})

    _VALIDATION_MSG = "Invalid request parameters"

    async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
        if isinstance(exc, RequestValidationError):
            log_validation_error(request, exc)
            return JSONResponse(status_code=422, content={"error": _VALIDATION_MSG})
        return JSONResponse(status_code=422, content={"error": _VALIDATION_MSG})

    async def _route_generic_error_handler(request: Request, exc: Exception) -> JSONResponse:
        log_unhandled_exception(request, exc)
        return JSONResponse(status_code=500, content={"error": _FALLBACK})

    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(HTTPError, _route_http_error_handler)
    app.add_exception_handler(Exception, _route_generic_error_handler)

    app.include_router(health_router)
    app.include_router(agent_router)
    app.include_router(generation_router)
    app.include_router(models_router)
    app.include_router(settings_router)
    app.include_router(image_gen_router)
    app.include_router(suggest_gap_prompt_router)
    app.include_router(retake_router)
    app.include_router(ic_lora_router)
    app.include_router(runtime_policy_router)

    return app
