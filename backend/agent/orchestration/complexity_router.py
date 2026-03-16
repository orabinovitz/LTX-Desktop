"""Classify whether a user request needs full orchestration or the simple agent path.

Heuristic-based: no LLM call required.  Keeps simple requests fast
(< 1 ms overhead) while routing multi-step workflows to the orchestrator.
"""

from __future__ import annotations

import re
from typing import Literal

RequestComplexity = Literal["simple", "orchestrated"]

_MULTI_STEP_SIGNALS = re.compile(
    r"""
    \bthen\b
    | \bafter\s+that\b
    | \bnext\b
    | \bfinally\b
    | \bfirst\b.*\bthen\b
    | \bstep\s*\d
    | \band\s+then\b
    | \bfollowed\s+by\b
    | \bonce\s+(?:that|done|finished)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_MULTI_DOMAIN_KEYWORDS: dict[str, set[str]] = {
    "generation": {
        "generate", "create image", "create video", "text to video",
        "image to video", "animate", "generate image", "generate video",
        "t2v", "i2v", "a2v",
    },
    "editing": {
        "edit", "trim", "cut", "split", "montage", "arrange", "sequence",
        "assemble", "timeline", "pacing", "transition", "dissolve",
    },
    "analysis": {
        "analyze", "metadata", "transcript", "decompose", "brain",
        "find clips about", "search for",
    },
    "export": {
        "export", "render", "fcpxml",
    },
}

_STYLE_KEYWORDS = {
    "marketing", "cinematic", "documentary", "social media", "trailer",
    "promo", "tiktok", "instagram", "reels", "fast-paced", "slow motion",
    "commercial", "music video", "narrative", "vlog",
}

_CINEMATIC_DIRECTOR_NAMES = {
    "villeneuve", "deakins", "kubrick", "spielberg", "nolan", "fincher",
    "scorsese", "coen", "malick", "lubezki", "richardson", "kamiński",
    "kaminski", "scott", "tarantino", "anderson", "jenkins", "zhao",
    "gerwig", "peele", "aster", "wong kar-wai", "wong kar wai",
    "kurosawa", "tarkovsky", "bergman", "fellini", "almodovar",
    "storaro", "khondji", "prieto", "pfister", "miyagawa",
    "hoytema", "young", "beebe", "laxton",
}


def has_cinematic_intent(prompt: str) -> bool:
    """Detect cinematic intent from director/DP names and keywords.

    Moved from the planner system prompt to code to avoid name-anchoring
    bias in LLM outputs while preserving the detection capability.
    """
    prompt_lower = prompt.lower()
    for name in _CINEMATIC_DIRECTOR_NAMES:
        if name in prompt_lower:
            return True
    cinematic_keywords = {
        "cinematic", "film", "movie", "feature film", "short film",
        "a24", "arthouse", "auteur", "noir", "shot on film",
        "film grain", "cinematic look", "like a movie",
    }
    for kw in cinematic_keywords:
        if kw in prompt_lower:
            return True
    return False

_MAX_SIMPLE_WORD_COUNT = 25


def classify_complexity(prompt: str) -> RequestComplexity:
    """Classify a user prompt as ``'simple'`` or ``'orchestrated'``.

    Rules (evaluated in order):

    1. Very short prompts (< 8 words, no multi-step signals) → simple.
    2. Explicit multi-step language ("first ... then ...") → orchestrated.
    3. Touches 2+ distinct domains (generation + editing) → orchestrated.
    4. Mentions a specialized style keyword → orchestrated.
    5. Everything else → simple.
    """
    prompt_lower = prompt.lower().strip()
    word_count = len(prompt_lower.split())

    if _MULTI_STEP_SIGNALS.search(prompt_lower):
        return "orchestrated"

    for kw in _STYLE_KEYWORDS:
        if kw in prompt_lower:
            return "orchestrated"

    matched_domains: set[str] = set()
    for domain, keywords in _MULTI_DOMAIN_KEYWORDS.items():
        for kw in keywords:
            if kw in prompt_lower:
                matched_domains.add(domain)
                break

    if len(matched_domains) >= 2:
        return "orchestrated"

    if word_count > _MAX_SIMPLE_WORD_COUNT:
        return "orchestrated"

    return "simple"
