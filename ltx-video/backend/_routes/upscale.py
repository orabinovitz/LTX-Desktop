"""Route handler for POST /api/upscale."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)


def _sharpen_video(input_path: str | Path, output_path: str | None = None) -> bool:
    """Apply sharpening + mild contrast enhancement to upscaled video using FFmpeg."""
    try:
        import subprocess
        import imageio_ffmpeg

        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()

        if output_path is None:
            output_path = str(input_path).replace(".mp4", "_sharp.mp4")

        cmd = [
            ffmpeg_path, "-y", "-i", str(input_path),
            "-vf", "unsharp=5:5:0.8:5:5:0.4,eq=contrast=1.02:brightness=0.01",
            "-c:v", "libx264", "-preset", "slow", "-crf", "17",
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]

        logger.info(f"Sharpening video: {input_path}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        if result.returncode == 0:
            import shutil
            shutil.move(str(output_path), str(input_path))
            logger.info(f"Sharpened video saved: {input_path}")
            return True
        else:
            logger.warning(f"FFmpeg sharpen failed: {result.stderr[:500]}")
            try:
                Path(output_path).unlink(missing_ok=True)
            except Exception:
                pass
            return False
    except Exception as e:
        logger.warning(f"Video sharpening skipped: {e}")
        return False


def post_upscale(data: dict[str, Any], content_type: str | None = None) -> dict[str, Any]:
    """POST /api/upscale"""
    import ltx2_server as _mod

    video_path = data.get("video_path")

    if not video_path:
        raise HTTPError(400, "Missing video_path parameter")

    video_file = Path(video_path)
    if not video_file.exists():
        raise HTTPError(400, f"Video file not found: {video_path}")

    try:
        import av

        with av.open(str(video_file)) as container:
            stream = container.streams.video[0]
            original_width = stream.width
            original_height = stream.height
            if container.duration:
                video_duration = float(container.duration) / 1_000_000
            elif stream.duration and stream.time_base:
                video_duration = float(stream.duration * stream.time_base)
            else:
                video_duration = 5.0
    except Exception as e:
        logger.warning(f"Could not get video info: {e}, using defaults")
        original_width = 1280
        original_height = 720
        video_duration = 5.0

    target_width = original_width * 2
    target_height = original_height * 2
    target_width = target_width if target_width % 2 == 0 else target_width + 1
    target_height = target_height if target_height % 2 == 0 else target_height + 1

    logger.info(f"Upscaling video: {video_path}")
    logger.info(f"Original: {original_width}x{original_height} -> Target: {target_width}x{target_height}")
    logger.info(f"Video duration: {video_duration}s")

    upscale_url = "https://cf.res.lightricks.com/v2/api/ltx2-edit/predict-sync"

    api_headers = {
        "x-lightricks-api-key": "Sp6MeaxIkqs8rIUBNcV3OqdjmosPLfbqzqFFm8tN4fQHOXLcDzUTKbDbqqrSnBp2",
        "x-app-id": "ltxv-api",
        "x-platform": "backend",
        "x-client-user-id": f"ltx-desktop-{uuid.uuid4().hex[:8]}",
        "x-lightricks-org-id": "montage-pro",
        "x-request-id": f"upscale-{uuid.uuid4().hex}",
    }

    params = {
        "upscale_only_mode": True,
        "width": target_width,
        "height": target_height,
        "mask_end_time": round(video_duration, 3),
    }

    params_json = json.dumps(params, separators=(",", ":"))
    logger.info(f"Sending to upscale API with params: {params_json}")

    response = _mod.requests.post(
        upscale_url,
        headers=api_headers,
        files={
            "params": (None, params_json),
            "input_video": (video_file.name, open(video_file, "rb"), "video/mp4"),
        },
        timeout=300,
    )

    logger.info(f"Upscale API response status: {response.status_code}")
    logger.info(f"Upscale API response headers: {dict(response.headers)}")

    raw_response = response.text[:1000] if response.text else "(empty)"
    logger.info(f"Upscale API raw response: {raw_response}")

    if response.status_code == 200:
        if not response.text or not response.text.strip():
            logger.error("Upscale API returned empty response")
            raise HTTPError(500, "Upscale API returned empty response")

        try:
            result = response.json()
        except json.JSONDecodeError:
            resp_ct = response.headers.get("Content-Type", "")
            if "video" in resp_ct:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                unique_id = uuid.uuid4().hex[:8]
                upscaled_filename = f"upscaled_{timestamp}_{unique_id}.mp4"
                upscaled_path = _mod.OUTPUTS_DIR / upscaled_filename
                with open(upscaled_path, "wb") as f:
                    f.write(response.content)
                logger.info(f"Saved upscaled video directly: {upscaled_path}")
                _sharpen_video(upscaled_path)
                return {
                    "status": "complete",
                    "upscaled_path": str(upscaled_path),
                    "width": target_width,
                    "height": target_height,
                }
            raise HTTPError(500, f"Invalid response format: {response.text[:200]}")

        if "output_video" in result or "video_url" in result or "result" in result:
            video_url = (
                result.get("output_video")
                or result.get("video_url")
                or result.get("result", {}).get("video_url")
            )

            if video_url:
                upscaled_response = _mod.requests.get(video_url, timeout=120)
                if upscaled_response.status_code == 200:
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    output_filename = f"upscaled_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
                    output_path = str(_mod.OUTPUTS_DIR / output_filename)
                    with open(output_path, "wb") as out_f:
                        out_f.write(upscaled_response.content)
                    logger.info(f"Upscaled video saved to: {output_path}")
                    _sharpen_video(output_path)
                    return {
                        "status": "complete",
                        "upscaled_path": output_path,
                        "width": target_width,
                        "height": target_height,
                    }
                else:
                    raise HTTPError(500, f"Failed to download upscaled video: {upscaled_response.status_code}")
            else:
                logger.info(f"Upscale API response keys: {result.keys()}")
                return {"status": "complete", "result": result}
        else:
            logger.info(f"Upscale API response: {result}")
            return {"status": "complete", "result": result}
    else:
        error_text = response.text[:500] if response.text else "Unknown error"
        logger.error(f"Upscale API error: {response.status_code} - {error_text}")
        raise HTTPError(response.status_code, f"Upscale API error: {error_text}")
