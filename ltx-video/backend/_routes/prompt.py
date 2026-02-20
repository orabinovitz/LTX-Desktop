"""Route handlers for /api/enhance-prompt, /api/suggest-gap-prompt."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from _models import (
    EnhancePromptRequest,
    SuggestGapPromptRequest,
    EnhancePromptResponse,
    SuggestGapPromptResponse,
)
from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["prompt"])


@router.post("/enhance-prompt", response_model=EnhancePromptResponse)
def route_enhance_prompt(req: EnhancePromptRequest):
    return post_enhance_prompt(req)


@router.post("/suggest-gap-prompt", response_model=SuggestGapPromptResponse)
def route_suggest_gap_prompt(req: SuggestGapPromptRequest):
    return post_suggest_gap_prompt(req)


def post_enhance_prompt(req: EnhancePromptRequest) -> dict[str, Any]:
    """POST /api/enhance-prompt"""
    import ltx2_server as _mod

    prompt = req.prompt.strip()
    mode = req.mode
    settings = _mod.get_settings_snapshot()

    if not prompt:
        raise HTTPError(400, "Prompt is required")

    if mode == "t2i":
        return {
            "status": "success",
            "enhanced_prompt": prompt,
            "skipped": True,
            "reason": "Prompt enhancement disabled for image generation",
        }

    if mode == "i2v":
        enhancer_enabled = settings.prompt_enhancer_enabled_i2v
    else:
        enhancer_enabled = settings.prompt_enhancer_enabled_t2v

    if not enhancer_enabled:
        return {
            "status": "success",
            "enhanced_prompt": prompt,
            "skipped": True,
            "reason": f"Prompt enhancer is disabled for {mode.upper()}",
        }

    gemini_api_key = settings.gemini_api_key
    if not gemini_api_key:
        raise HTTPError(400, "GEMINI_API_KEY_MISSING")

    if mode == "i2v":
        system_prompt = settings.i2v_system_prompt
    else:
        system_prompt = settings.t2v_system_prompt

    logger.info(f"Enhancing prompt ({mode}): {prompt[:50]}...")

    gemini_url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={gemini_api_key}"
    )

    gemini_payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
    }

    try:
        response = _mod.requests.post(
            gemini_url,
            headers={"Content-Type": "application/json"},
            json=gemini_payload,
            timeout=30,
        )
    except _mod.requests.exceptions.Timeout:
        raise HTTPError(504, "Gemini API request timed out")
    except Exception as e:
        logger.error(f"Prompt enhancement error: {e}")
        raise HTTPError(500, str(e))

    if response.status_code != 200:
        logger.error(f"Gemini API error: {response.status_code} - {response.text}")
        raise HTTPError(response.status_code, f"Gemini API error: {response.text}")

    result = response.json()
    try:
        enhanced_prompt = result["candidates"][0]["content"]["parts"][0]["text"]
        logger.info(f"Prompt enhanced successfully: {enhanced_prompt[:50]}...")
        return {
            "status": "success",
            "enhanced_prompt": enhanced_prompt,
            "original_prompt": prompt,
        }
    except (KeyError, IndexError) as e:
        logger.error(f"Failed to parse Gemini response: {e}")
        raise HTTPError(500, "GEMINI_PARSE_ERROR")


def post_suggest_gap_prompt(req: SuggestGapPromptRequest) -> dict[str, Any]:
    """POST /api/suggest-gap-prompt"""
    import ltx2_server as _mod

    before_frame = req.beforeFrame
    after_frame = req.afterFrame
    input_image = req.inputImage
    before_prompt = req.beforePrompt
    after_prompt = req.afterPrompt
    gap_duration = req.gapDuration
    mode = req.mode

    if not before_frame and not after_frame and not before_prompt and not after_prompt:
        raise HTTPError(400, "At least one neighboring frame or prompt is required")

    gemini_api_key = _mod.get_settings_snapshot().gemini_api_key
    if not gemini_api_key:
        raise HTTPError(400, "GEMINI_API_KEY_MISSING")

    logger.info(
        f"Suggesting gap prompt: before={'frame+' if before_frame else ''}{bool(before_prompt)}, "
        f"after={'frame+' if after_frame else ''}{bool(after_prompt)}, "
        f"input_image={bool(input_image)}, dur={gap_duration}s, mode={mode}"
    )

    is_image_gen = mode in ("text-to-image", "t2i")
    is_image_edit = is_image_gen and bool(input_image)

    if is_image_edit:
        system_text = (
            "You are a video production assistant. The user is editing a video timeline and has a gap "
            f"of {gap_duration:.1f} seconds between two shots. The user has provided an INPUT IMAGE that they want to "
            "edit/modify to fit into this gap. Your job is to suggest a prompt describing how to EDIT the input image "
            "so it fits naturally between the surrounding shots.\n\n"
            "Guidelines:\n"
            "- Describe what changes should be made to the input image (e.g. change background, adjust lighting, add elements, change style)\n"
            "- The edits should make the image blend seamlessly with the surrounding shots\n"
            "- Match the visual style, lighting, color palette, and mood of the neighboring shots\n"
            "- Keep the prompt concise (1-3 sentences max)\n"
            "- Write only the edit instruction prompt, no explanations or labels\n"
            "- Focus on what to CHANGE, not what the image already contains\n"
        )
    else:
        system_text = (
            "You are a video production assistant. The user is editing a video timeline and has a gap "
            f"of {gap_duration:.1f} seconds between two shots. Your job is to suggest a detailed prompt "
            f"for generating {'an image' if is_image_gen else 'a video clip'} to fill this gap, so that it flows naturally between the "
            "preceding and following shots.\n\n"
            "Guidelines:\n"
            f"- Describe the scene, {'composition' if is_image_gen else 'action, camera movement'}, lighting, and mood\n"
            "- Match the visual style and tone of the surrounding shots\n"
            "- Create a smooth narrative or visual transition between the two shots\n"
            "- Keep the prompt concise (2-4 sentences max)\n"
            "- Write only the prompt text, no explanations or labels\n"
            "- If only one neighboring shot is available, suggest something that naturally leads into or out of it\n"
        )

    user_parts: list[dict[str, Any]] = []
    context_text = "Here is the context from the timeline:\n\n"

    if before_frame or before_prompt:
        context_text += "SHOT BEFORE THE GAP:\n"
        if before_prompt:
            context_text += f"  Prompt: {before_prompt}\n"
        if before_frame:
            context_text += "  Last frame (see image below):\n"

    if after_frame or after_prompt:
        context_text += "\nSHOT AFTER THE GAP:\n"
        if after_prompt:
            context_text += f"  Prompt: {after_prompt}\n"
        if after_frame:
            context_text += "  First frame (see image below):\n"

    context_text += f"\nGap duration: {gap_duration:.1f} seconds\n"

    if is_image_edit:
        context_text += "Mode: Image editing — the user wants to EDIT the provided input image to fit this gap.\n"
        context_text += "\nPlease suggest an edit prompt describing how to modify the input image so it fits naturally between the surrounding shots."
    else:
        is_image_mode = mode in ("text-to-image", "t2i")
        mode_label = (
            "image generation"
            if is_image_mode
            else ("image-to-video" if mode in ("image-to-video", "i2v") else "text-to-video")
        )
        context_text += f"Generation mode: {mode_label}\n"
        if is_image_mode:
            context_text += "\nPlease suggest a detailed prompt for generating an image to fill this gap. Describe the visual scene, composition, lighting, and mood."
        else:
            context_text += "\nPlease suggest a detailed prompt for generating a video clip to fill this gap."

    user_parts.append({"text": context_text})

    if input_image:
        user_parts.append({"text": "INPUT IMAGE to edit (this is the image the user wants to modify to fit the gap):"})
        user_parts.append({"inlineData": {"mimeType": "image/jpeg", "data": input_image}})

    if before_frame:
        user_parts.append({"text": "Last frame of the shot BEFORE the gap:"})
        user_parts.append({"inlineData": {"mimeType": "image/jpeg", "data": before_frame}})

    if after_frame:
        user_parts.append({"text": "First frame of the shot AFTER the gap:"})
        user_parts.append({"inlineData": {"mimeType": "image/jpeg", "data": after_frame}})

    gemini_url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={gemini_api_key}"
    )

    gemini_payload = {
        "contents": [{"role": "user", "parts": user_parts}],
        "systemInstruction": {"parts": [{"text": system_text}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 512},
    }

    try:
        response = _mod.requests.post(
            gemini_url,
            headers={"Content-Type": "application/json"},
            json=gemini_payload,
            timeout=30,
        )
    except _mod.requests.exceptions.Timeout:
        raise HTTPError(504, "Gemini API request timed out")
    except Exception as e:
        logger.error(f"Gap prompt suggestion error: {e}")
        raise HTTPError(500, str(e))

    if response.status_code != 200:
        logger.error(f"Gemini gap suggestion error: {response.status_code} - {response.text}")
        raise HTTPError(response.status_code, f"Gemini API error: {response.text}")

    result = response.json()
    try:
        suggested_prompt = result["candidates"][0]["content"]["parts"][0]["text"].strip()
        logger.info(f"Gap prompt suggested: {suggested_prompt[:80]}...")
        return {"status": "success", "suggested_prompt": suggested_prompt}
    except (KeyError, IndexError) as e:
        logger.error(f"Failed to parse Gemini gap suggestion: {e}")
        raise HTTPError(500, "GEMINI_PARSE_ERROR")
