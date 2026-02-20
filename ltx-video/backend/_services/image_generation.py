"""Image generation and editing logic using the Flux pipeline."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


def generate_image_impl(
    prompt: str,
    width: int = 1024,
    height: int = 1024,
    num_inference_steps: int = 4,
    seed: int | None = None,
    generation_id: str | None = None,
    num_images: int = 1,
) -> list[str]:
    """Generate one or more images using the Flux pipeline."""
    import torch

    import ltx2_server as _mod

    if _mod.current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")

    _mod.update_generation_progress("loading_model", 5, 0, num_inference_steps)

    pipeline = _mod.get_flux_pipeline()
    if pipeline is None:
        raise RuntimeError("Failed to load Flux pipeline")

    _mod.update_generation_progress("inference", 15, 0, num_inference_steps)

    output_paths: list[str] = []
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    try:
        logger.info(f"Generating {num_images} image(s): {width}x{height}, seed={seed}")
        logger.info(f"Prompt: {prompt[:100]}...")

        start = time.time()

        if seed is None:
            seed = int(time.time()) % 2147483647

        for i in range(num_images):
            if _mod.current_generation["cancelled"]:
                raise RuntimeError("Generation was cancelled")

            current_seed = seed + i
            generator = torch.Generator(device=_mod.DEVICE).manual_seed(current_seed)

            progress = 15 + int((i / num_images) * 80)
            _mod.update_generation_progress("inference", progress, i, num_images)

            result = pipeline(
                prompt=prompt,
                height=height,
                width=width,
                guidance_scale=1.0,
                num_inference_steps=num_inference_steps,
                generator=generator,
            )

            output_filename = f"flux_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
            output_path = _mod.OUTPUTS_DIR / output_filename
            image = result.images[0]
            image.save(str(output_path))
            output_paths.append(str(output_path))

            logger.info(f"Generated image {i + 1}/{num_images}: {output_path}")

        if _mod.current_generation["cancelled"]:
            raise RuntimeError("Generation was cancelled")

        _mod.update_generation_progress("complete", 100, num_images, num_images)

        logger.info(f"Image generation took {time.time() - start:.1f}s")
        logger.info(f"Generated {len(output_paths)} image(s)")
        return output_paths

    except Exception as e:
        logger.error(f"Image generation failed: {e}")
        raise


def edit_image_impl(
    prompt: str,
    input_images: list[Any],
    width: int = 1024,
    height: int = 1024,
    num_inference_steps: int = 4,
    seed: int | None = None,
    generation_id: str | None = None,
) -> list[str]:
    """Edit an image using the Flux pipeline with reference image(s)."""
    import torch

    import ltx2_server as _mod

    if _mod.current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")

    _mod.update_generation_progress("loading_model", 5, 0, num_inference_steps)

    pipeline = _mod.get_flux_pipeline()
    if pipeline is None:
        raise RuntimeError("Failed to load Flux pipeline")

    _mod.update_generation_progress("inference", 15, 0, num_inference_steps)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    try:
        logger.info(f"Editing image with {len(input_images)} reference(s): {width}x{height}, seed={seed}")
        logger.info(f"Edit prompt: {prompt[:100]}...")

        start = time.time()

        if seed is None:
            seed = int(time.time()) % 2147483647

        generator = torch.Generator(device=_mod.DEVICE).manual_seed(seed)

        if _mod.current_generation["cancelled"]:
            raise RuntimeError("Generation was cancelled")

        _mod.update_generation_progress("inference", 30, 0, 1)

        image_input = input_images if len(input_images) > 1 else input_images[0]

        result = pipeline(
            prompt=prompt,
            image=image_input,
            height=height,
            width=width,
            guidance_scale=1.0,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )

        output_filename = f"flux_edit_{timestamp}_{uuid.uuid4().hex[:8]}.png"
        output_path = _mod.OUTPUTS_DIR / output_filename
        image = result.images[0]
        image.save(str(output_path))

        if _mod.current_generation["cancelled"]:
            raise RuntimeError("Generation was cancelled")

        _mod.update_generation_progress("complete", 100, 1, 1)

        logger.info(f"Image editing took {time.time() - start:.1f}s")
        logger.info(f"Edited image saved: {output_path}")
        return [str(output_path)]

    except Exception as e:
        logger.error(f"Image editing failed: {e}")
        raise
