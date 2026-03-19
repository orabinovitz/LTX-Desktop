"""Classify whether a user request needs full orchestration or the simple agent path.

Heuristic-based: no LLM call required.  Keeps simple requests fast
(< 1 ms overhead) while routing multi-step workflows to the orchestrator.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

logger = logging.getLogger(__name__)

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

_FULL_PRODUCTION_SIGNALS = re.compile(
    r"""
    \bcreate\b.*\b(?:video|scene|film|ad|promo|trailer|commercial)\b
    | \bmake\b.*\b(?:video|scene|film|ad|promo|trailer|commercial)\b
    | \bproduce\b
    | \bshoot\b
    | \bfull\s+(?:video|scene|production)\b
    | \bfrom\s+scratch\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_CREATIVE_PLANNING_SIGNALS = re.compile(
    r"""
    \bvisual\s+identit
    | \bidentity\s+(?:bible|guide)\b
    | \bstyle\s+guide\b
    | \blook\s+dev(?:elopment)?\b
    | \bstoryboard\b
    | \bpre[- ]?production\b
    | \bcharacters?\s+(?:sheet|ref|design|visuals?|looks?|appearances?)\b
    | \b(?:work|develop|establish)\b.{0,20}\bcharacters?\b.{0,20}\bvisual
    | \blocation\s+(?:ref|scout|design)\b
    | \bshot\s+list\b
    | \bmood\s*board\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

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

def has_multi_step_signals(prompt: str) -> bool:
    """Check whether a prompt contains multi-step language patterns."""
    return bool(_MULTI_STEP_SIGNALS.search(prompt.lower()))


_MAX_SIMPLE_WORD_COUNT = 45


def classify_complexity(prompt: str) -> RequestComplexity:
    """Classify a user prompt as ``'simple'`` or ``'orchestrated'``.

    Rules (evaluated in order):

    1. Explicit multi-step language ("first ... then ...") → orchestrated.
    2. Creative planning tasks that need skill routing (visual identity,
       style guide, storyboard, pre-production, shot list) → orchestrated.
    3. Touches 2+ distinct domains (generation + editing) → orchestrated.
    4. Style keyword combined with a production signal (create/make a
       video/scene/film) → orchestrated.  A style keyword alone is just
       a modifier on a simple request and stays simple.
    5. Very long prompts (> 45 words) → orchestrated as a fallback.
    6. Everything else → simple.
    """
    prompt_lower = prompt.lower().strip()
    word_count = len(prompt_lower.split())

    if _MULTI_STEP_SIGNALS.search(prompt_lower):
        logger.info("[complexity] orchestrated (multi-step language): %.80s", prompt)
        return "orchestrated"

    if _CREATIVE_PLANNING_SIGNALS.search(prompt_lower):
        logger.info("[complexity] orchestrated (creative planning): %.80s", prompt)
        return "orchestrated"

    matched_domains: set[str] = set()
    for domain, keywords in _MULTI_DOMAIN_KEYWORDS.items():
        for kw in keywords:
            if kw in prompt_lower:
                matched_domains.add(domain)
                break

    if len(matched_domains) >= 2:
        logger.info("[complexity] orchestrated (multi-domain: %s): %.80s", matched_domains, prompt)
        return "orchestrated"

    has_style = any(kw in prompt_lower for kw in _STYLE_KEYWORDS)
    has_production_signal = bool(_FULL_PRODUCTION_SIGNALS.search(prompt_lower))
    if has_style and has_production_signal:
        logger.info("[complexity] orchestrated (style + production): %.80s", prompt)
        return "orchestrated"

    if word_count > _MAX_SIMPLE_WORD_COUNT:
        logger.info("[complexity] orchestrated (long prompt, %d words): %.80s", word_count, prompt)
        return "orchestrated"

    logger.info("[complexity] simple: %.80s", prompt)
    return "simple"
