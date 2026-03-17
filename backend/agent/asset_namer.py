"""Suggest a short display name and tags for a generated asset.

Makes a single Gemini Flash call to produce a concise name and 2-4
freeform tags from the generation prompt.  Returns ``None`` on any
error so the caller can proceed without blocking.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from services.http_client.http_client import HTTPClient

logger = logging.getLogger(__name__)

_MODEL = "gemini-3-flash-preview"
_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

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

    url = f"{_GEMINI_BASE_URL}/{_MODEL}:generateContent"
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
        resp = http_client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_api_key,
            },
            json_payload=payload,
            timeout=10,
        )

        if resp.status_code != 200:
            logger.warning(
                "Asset naming Gemini call failed with HTTP %d: %s",
                resp.status_code,
                resp.text[:300],
            )
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

    name = str(data.get("name", "")).strip()
    raw_tags = data.get("tags", [])
    if not isinstance(raw_tags, list):
        raw_tags = []

    tags: list[str] = []
    seen: set[str] = set()
    for t in raw_tags:
        tag = str(t).strip().lower()[:30]
        if tag and tag not in seen:
            tags.append(tag)
            seen.add(tag)

    if not name:
        return None

    return AssetMetaSuggestion(name=name, tags=tags[:6])
