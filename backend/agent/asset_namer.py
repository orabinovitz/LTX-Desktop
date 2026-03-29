"""Suggest a short display name and tags for a generated asset.

Makes a single Gemini Flash call to produce a concise name and 2-4
freeform tags from the generation prompt.  Returns ``None`` on any
error so the caller can proceed without blocking.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, cast

from agent.model_policy import AgentStage, select_model
from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
_SOFT_PROVIDER_RETRY_STATUSES: frozenset[int] = frozenset({429, 503})
_SOFT_PROVIDER_RETRY_DELAYS: tuple[float, ...] = (1.0,)

_SYSTEM_PROMPT = """\
You generate concise metadata for AI-generated media assets.

Given a generation prompt and asset type, produce:
- **name**: A short display name (2-5 words). Capture the *subject* of the \
image/video, not the style or technical details. Do NOT repeat the full prompt. \
Think of it as a file name a human would choose.
- **tags**: 2-4 lowercase single-word tags useful for organizing and searching. \
Include the primary subject, setting, or mood. If existing project tags are \
provided, prefer reusing them where relevant for consistency.

## Output Format

Return a JSON object:
{
  "name": "string",
  "tags": ["string", ...]
}
"""


@dataclass
class AssetMetaSuggestion:
    name: str
    tags: list[str]


def suggest_asset_meta(
    prompt: str,
    asset_type: str,
    existing_tags: list[str],
    gemini_api_key: str,
    http_client: HTTPClient,
) -> AssetMetaSuggestion | None:
    """Suggest a name and tags for an asset based on its generation prompt.

    Returns ``None`` on any error so callers can fail silently.
    """
    user_parts: list[str] = [
        f"Asset type: {asset_type}",
        f"Generation prompt: {prompt}",
    ]
    if existing_tags:
        user_parts.append(
            f"Existing project tags (prefer reusing): {', '.join(existing_tags[:30])}"
        )

    selection = select_model(AgentStage.ASSET_NAMER)
    url = f"{_GEMINI_BASE_URL}/{selection.model}:generateContent"
    payload: dict[str, Any] = {
        "contents": [
            {"role": "user", "parts": [{"text": "\n".join(user_parts)}]},
        ],
        "systemInstruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 256,
            "responseMimeType": "application/json",
        },
    }

    try:
        attempts = len(_SOFT_PROVIDER_RETRY_DELAYS) + 1
        resp = None
        for attempt in range(attempts):
            resp = http_client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": gemini_api_key,
                },
                json_payload=payload,
                timeout=10,
            )
            if resp.status_code == 200:
                break
            if resp.status_code in _SOFT_PROVIDER_RETRY_STATUSES and attempt < attempts - 1:
                delay = _SOFT_PROVIDER_RETRY_DELAYS[attempt]
                logger.warning(
                    "Asset naming Gemini soft failure [category=provider_overloaded] HTTP %d on attempt %d/%d; retrying in %.1fs: %s",
                    resp.status_code,
                    attempt + 1,
                    attempts,
                    delay,
                    resp.text[:300],
                )
                time.sleep(delay)
                continue
            logger.warning(
                "Asset naming Gemini call failed [category=%s] with HTTP %d: %s",
                "provider_overloaded" if resp.status_code in _SOFT_PROVIDER_RETRY_STATUSES else "provider_response",
                resp.status_code,
                resp.text[:300],
            )
            return None

        if resp is None:
            return None

        body: Any = resp.json()
        text: str = body["candidates"][0]["content"]["parts"][0]["text"]
        data: Any = json.loads(text)

    except Exception:
        logger.warning("Asset name suggestion failed", exc_info=True)
        return None

    return _parse_response(data)


def _parse_response(data: Any) -> AssetMetaSuggestion | None:
    if not isinstance(data, dict):
        return None

    d = cast(dict[str, Any], data)
    name = str(d.get("name", "")).strip()
    raw_tags: Any = d.get("tags", [])
    if not isinstance(raw_tags, list):
        raw_tags = []

    tags: list[str] = []
    seen: set[str] = set()
    for t in cast(list[object], raw_tags):
        tag = str(t).strip().lower()[:30]
        if tag and tag not in seen:
            tags.append(tag)
            seen.add(tag)

    if not name:
        return None

    return AssetMetaSuggestion(name=name, tags=tags[:6])
