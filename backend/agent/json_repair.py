"""Shared JSON repair utility for truncated Gemini API responses.

Gemini may hit its output-token limit and return JSON that is cut off
mid-object. These functions try progressively less precise strategies
to recover whatever complete entries exist.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def repair_truncated_json(text: str) -> dict[str, Any]:
    """Attempt to salvage valid data from truncated JSON output.

    Returns a parsed dict on success or an empty dict if repair fails entirely.
    """
    try:
        parsed: dict[str, Any] = json.loads(text)
        return parsed
    except json.JSONDecodeError:
        pass

    last_complete = -1
    for m in re.finditer(r'\}\s*,', text):
        last_complete = m.start() + 1

    if last_complete == -1:
        for m in re.finditer(r'\}', text):
            last_complete = m.start() + 1

    if last_complete > 0:
        truncated = text[:last_complete]
        open_brackets = truncated.count('[') - truncated.count(']')
        open_braces = truncated.count('{') - truncated.count('}')
        suffix = ']' * max(0, open_brackets) + '}' * max(0, open_braces)
        try:
            result: dict[str, Any] = json.loads(truncated + suffix)
            return result
        except json.JSONDecodeError:
            pass

    logger.warning("Could not repair truncated JSON (%d chars)", len(text))
    return {}


def repair_simple_json(text: str) -> dict[str, Any] | None:
    """Simpler repair for JSON that just needs bracket/brace closing.

    Returns the parsed dict on success, or None if repair fails.
    """
    stripped = text.strip()
    if not stripped.startswith("{"):
        return None
    open_braces = stripped.count("{") - stripped.count("}")
    open_brackets = stripped.count("[") - stripped.count("]")
    if open_braces == 0 and open_brackets == 0:
        return None
    patched = stripped.rstrip().rstrip(",")
    patched += "]" * max(0, open_brackets)
    patched += "}" * max(0, open_braces)
    try:
        repaired: dict[str, Any] = json.loads(patched)
        return repaired
    except Exception:
        logger.debug("JSON simple repair failed for text (len=%d): %s", len(text), text[:200], exc_info=True)
        return None
