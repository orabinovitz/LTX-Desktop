"""Retake API orchestration handler."""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from threading import RLock
from api_types import RetakeRequest, RetakeResponse
from _routes._errors import HTTPError
from handlers.base import StateHandlerBase
from services.interfaces import HTTPClient
from state.app_state_types import AppState


class RetakeHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, http: HTTPClient, outputs_dir: Path) -> None:
        super().__init__(state, lock)
        self._http = http
        self._outputs_dir = outputs_dir

    def run(self, req: RetakeRequest) -> RetakeResponse:
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

        api_key = self.state.app_settings.ltx_api_key
        if not api_key:
            raise HTTPError(400, "LTX API key not configured. Set it in Settings.")

        upload_resp = self._http.post(
            "https://api.ltx.video/v1/upload",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30,
        )
        if upload_resp.status_code != 200:
            err = upload_resp.text[:500]
            raise HTTPError(upload_resp.status_code, f"Failed to get upload URL: {err}")

        upload_info = upload_resp.json()
        upload_url = upload_info["upload_url"]
        storage_uri = upload_info["storage_uri"]
        required_headers = upload_info.get("required_headers", {})

        with open(video_file, "rb") as f:
            put_resp = self._http.put(
                upload_url,
                data=f,
                headers={"Content-Type": "video/mp4", **required_headers},
                timeout=300,
            )
        if put_resp.status_code not in (200, 201):
            err = put_resp.text[:500]
            raise HTTPError(500, f"Video upload failed: {err}")

        payload: dict[str, float | str] = {
            "video_uri": storage_uri,
            "start_time": float(start_time),
            "duration": float(duration),
            "mode": mode,
        }
        if prompt:
            payload["prompt"] = prompt

        retake_resp = self._http.post(
            "https://api.ltx.video/v1/retake",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json_payload=payload,
            timeout=600,
        )

        if retake_resp.status_code == 200:
            content_type = retake_resp.headers.get("Content-Type", "")

            if "video" in content_type or "octet-stream" in content_type:
                output = self._outputs_dir / f"retake_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.mp4"
                with open(output, "wb") as out:
                    out.write(retake_resp.content)
                return RetakeResponse(status="complete", video_path=str(output))

            try:
                result = retake_resp.json()
                video_url = result.get("video_url") or result.get("output_video") or result.get("result", {}).get("video_url")
                if video_url:
                    dl_resp = self._http.get(video_url, timeout=120)
                    if dl_resp.status_code == 200:
                        output = self._outputs_dir / f"retake_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.mp4"
                        with open(output, "wb") as out:
                            out.write(dl_resp.content)
                        return RetakeResponse(status="complete", video_path=str(output))
                    raise HTTPError(500, f"Failed to download retake video: {dl_resp.status_code}")

                return RetakeResponse(status="complete", result=result)
            except json.JSONDecodeError:
                raise HTTPError(500, f"Unexpected response format: {retake_resp.text[:200]}")

        if retake_resp.status_code == 422:
            raise HTTPError(422, "Content rejected by safety filters")

        error_text = retake_resp.text[:500] if retake_resp.text else "Unknown error"
        raise HTTPError(retake_resp.status_code, f"Retake API error: {error_text}")
