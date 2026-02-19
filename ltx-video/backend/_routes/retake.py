"""Route handler for POST /api/retake."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from _models import RetakeRequest, RetakeResponse
from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["retake"])


@router.post("/retake", response_model=RetakeResponse)
async def route_retake(req: RetakeRequest):
    return post_retake(req)


def post_retake(req: RetakeRequest) -> dict[str, Any]:
    """POST /api/retake"""
    import ltx2_server as _mod

    video_path = req.video_path
    start_time = req.start_time
    duration = req.duration
    prompt = req.prompt
    mode = req.mode

    if not video_path:
        raise HTTPError(400, "Missing video_path parameter")
    if duration < 2:
        raise HTTPError(400, "duration must be at least 2 seconds")

    video_file = Path(video_path)
    if not video_file.exists():
        raise HTTPError(400, f"Video file not found: {video_path}")

    api_key = _mod.get_settings_snapshot().ltx_api_key
    if not api_key:
        raise HTTPError(400, "LTX API key not configured. Set it in Settings.")

    logger.info(f"Retake request: video={video_path}, start={start_time}, dur={duration}, mode={mode}")
    logger.info(f"Retake prompt: {prompt[:200]}")

    # Step 1: Get a signed upload URL
    logger.info("Retake step 1/3: requesting upload URL...")
    upload_resp = _mod.requests.post(
        "https://api.ltx.video/v1/upload",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    if upload_resp.status_code != 200:
        err = upload_resp.text[:500]
        logger.error(f"Upload URL request failed: {upload_resp.status_code} - {err}")
        raise HTTPError(upload_resp.status_code, f"Failed to get upload URL: {err}")

    upload_info = upload_resp.json()
    upload_url = upload_info["upload_url"]
    storage_uri = upload_info["storage_uri"]
    required_headers = upload_info.get("required_headers", {})
    logger.info(f"Got storage_uri: {storage_uri}")

    # Step 2: Upload the video file
    logger.info("Retake step 2/3: uploading video file...")
    with open(video_file, "rb") as f:
        put_headers = {"Content-Type": "video/mp4", **required_headers}
        put_resp = _mod.requests.put(upload_url, data=f, headers=put_headers, timeout=300)
    if put_resp.status_code not in (200, 201):
        err = put_resp.text[:500]
        logger.error(f"Video upload failed: {put_resp.status_code} - {err}")
        raise HTTPError(500, f"Video upload failed: {err}")
    logger.info("Video uploaded successfully")

    # Step 3: Call the retake endpoint
    logger.info("Retake step 3/3: calling retake API...")
    retake_payload: dict[str, Any] = {
        "video_uri": storage_uri,
        "start_time": float(start_time),
        "duration": float(duration),
        "mode": mode,
    }
    if prompt:
        retake_payload["prompt"] = prompt

    retake_resp = _mod.requests.post(
        "https://api.ltx.video/v1/retake",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=retake_payload,
        timeout=600,
    )

    logger.info(f"Retake API response status: {retake_resp.status_code}")

    if retake_resp.status_code == 200:
        content_type = retake_resp.headers.get("Content-Type", "")

        if "video" in content_type or "octet-stream" in content_type:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            unique_id = uuid.uuid4().hex[:8]
            retake_filename = f"retake_{timestamp}_{unique_id}.mp4"
            retake_path = _mod.OUTPUTS_DIR / retake_filename
            with open(retake_path, "wb") as out_f:
                out_f.write(retake_resp.content)
            logger.info(f"Retake video saved: {retake_path} ({len(retake_resp.content)} bytes)")
            return {"status": "complete", "video_path": str(retake_path)}
        else:
            try:
                result = retake_resp.json()
                video_url = (
                    result.get("video_url")
                    or result.get("output_video")
                    or result.get("result", {}).get("video_url")
                )
                if video_url:
                    dl_resp = _mod.requests.get(video_url, timeout=120)
                    if dl_resp.status_code == 200:
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        unique_id = uuid.uuid4().hex[:8]
                        retake_filename = f"retake_{timestamp}_{unique_id}.mp4"
                        retake_path = _mod.OUTPUTS_DIR / retake_filename
                        with open(retake_path, "wb") as out_f:
                            out_f.write(dl_resp.content)
                        logger.info(f"Retake video downloaded and saved: {retake_path}")
                        return {"status": "complete", "video_path": str(retake_path)}
                    else:
                        raise HTTPError(500, f"Failed to download retake video: {dl_resp.status_code}")
                else:
                    logger.info(f"Retake API response keys: {list(result.keys())}")
                    return {"status": "complete", "result": result}
            except json.JSONDecodeError:
                raise HTTPError(500, f"Unexpected response format: {retake_resp.text[:200]}")
    elif retake_resp.status_code == 422:
        raise HTTPError(422, "Content rejected by safety filters")
    else:
        error_text = retake_resp.text[:500] if retake_resp.text else "Unknown error"
        logger.error(f"Retake API error: {retake_resp.status_code} - {error_text}")
        raise HTTPError(retake_resp.status_code, f"Retake API error: {error_text}")
