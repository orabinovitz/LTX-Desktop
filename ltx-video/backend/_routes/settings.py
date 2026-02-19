"""Route handlers for GET/POST /api/settings."""

from __future__ import annotations

import logging

from fastapi import APIRouter

from AppStettings import SettingsResponse, UpdateSettingsRequest
from _models import StatusResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings", response_model=SettingsResponse)
async def route_get_settings():
    return get_settings()


@router.post("/settings", response_model=StatusResponse)
async def route_post_settings(req: UpdateSettingsRequest):
    return post_settings(req)


def get_settings() -> SettingsResponse:
    """GET /api/settings"""
    import ltx2_server as _mod

    return _mod.get_settings_snapshot()


def post_settings(req: UpdateSettingsRequest) -> dict[str, str]:
    """POST /api/settings"""
    import ltx2_server as _mod

    _, after, changed_paths = _mod.apply_settings_patch(req)
    changed_roots = {path.split(".", 1)[0] for path in changed_paths}

    if "prompt_cache_size" in changed_roots:
        new_size = after.prompt_cache_size
        while len(_mod._prompt_embeddings_cache) > new_size:
            oldest_key = next(iter(_mod._prompt_embeddings_cache))
            del _mod._prompt_embeddings_cache[oldest_key]

    logger.info(
        "Applied settings patch (changed=%s)",
        ", ".join(sorted(changed_roots)) if changed_roots else "none",
    )

    _mod.save_settings()
    return {"status": "ok"}
