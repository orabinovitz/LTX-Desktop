"""Route handlers for /api/ic-lora/* endpoints."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

# Official IC-LoRA models available for download
OFFICIAL_MODELS = {
    "canny": {
        "repo": "Lightricks/LTX-2-19b-IC-LoRA-Canny-Control",
        "file": "ltx-2-19b-ic-lora-canny-control.safetensors",
    },
    "depth": {
        "repo": "Lightricks/LTX-2-19b-IC-LoRA-Depth-Control",
        "file": "ltx-2-19b-ic-lora-depth-control.safetensors",
    },
    "pose": {
        "repo": "Lightricks/LTX-2-19b-IC-LoRA-Pose-Control",
        "file": "ltx-2-19b-ic-lora-pose-control.safetensors",
    },
    "detailer": {
        "repo": "Lightricks/LTX-2-19b-IC-LoRA-Detailer",
        "file": "ltx-2-19b-ic-lora-detailer.safetensors",
    },
}


def get_list_models() -> dict[str, Any]:
    """GET /api/ic-lora/list-models"""
    import ltx2_server as _mod

    models: list[dict[str, Any]] = []
    if _mod.IC_LORA_DIR.exists():
        for f in sorted(_mod.IC_LORA_DIR.iterdir()):
            if f.suffix == ".safetensors" and f.is_file():
                meta: dict[str, Any] = {}
                try:
                    from safetensors import safe_open

                    with safe_open(str(f), framework="pt") as sf:
                        meta = sf.metadata() or {}
                except Exception:
                    pass
                conditioning_type = meta.get("conditioning_type", "unknown")
                ref_downscale = int(meta.get("reference_downscale_factor", 1))
                models.append({
                    "name": f.stem,
                    "path": str(f),
                    "conditioning_type": conditioning_type,
                    "reference_downscale_factor": ref_downscale,
                })
    return {"models": models, "directory": str(_mod.IC_LORA_DIR)}


def post_download_model(data: dict[str, Any]) -> dict[str, Any]:
    """POST /api/ic-lora/download-model"""
    import ltx2_server as _mod

    model_key = data.get("model", "")

    if model_key not in OFFICIAL_MODELS:
        raise HTTPError(400, f"Unknown model: {model_key}. Must be one of: {list(OFFICIAL_MODELS.keys())}")

    info = OFFICIAL_MODELS[model_key]
    dest_path = _mod.IC_LORA_DIR / info["file"]

    if dest_path.exists() and dest_path.stat().st_size > 1_000_000:
        logger.info(f"IC-LoRA model already exists: {dest_path}")
        return {"status": "complete", "path": str(dest_path), "already_existed": True}

    url = f"https://huggingface.co/{info['repo']}/resolve/main/{info['file']}"
    logger.info(f"Downloading IC-LoRA model: {url} -> {dest_path}")

    import urllib.request

    _mod.IC_LORA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(".tmp")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LTX-Studio-App/1.0"})
        with urllib.request.urlopen(req) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 1024

            with open(tmp_path, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = (downloaded / total) * 100
                        logger.info(
                            f"  Download progress: {downloaded / (1024 * 1024):.1f}MB / "
                            f"{total / (1024 * 1024):.1f}MB ({pct:.0f}%)"
                        )

        if tmp_path.exists():
            tmp_path.rename(dest_path)

        logger.info(f"IC-LoRA model downloaded: {dest_path} ({dest_path.stat().st_size / (1024 * 1024):.1f}MB)")
        return {"status": "complete", "path": str(dest_path), "already_existed": False}
    except Exception:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass
        raise


def post_extract_conditioning(data: dict[str, Any]) -> dict[str, Any]:
    """POST /api/ic-lora/extract-conditioning"""
    import ltx2_server as _mod

    video_path = data.get("video_path")
    conditioning_type = data.get("conditioning_type", "canny")
    frame_time = data.get("frame_time", 0)

    if not video_path:
        raise HTTPError(400, "Missing video_path")

    video_file = Path(video_path)
    if not video_file.exists():
        raise HTTPError(400, f"Video not found: {video_path}")

    import cv2
    import base64

    cap = cv2.VideoCapture(str(video_file))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    target_frame = int(frame_time * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        raise HTTPError(400, "Could not read frame from video")

    if conditioning_type == "canny":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 100, 200)
        result = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
    elif conditioning_type == "depth":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (21, 21), 0)
        depth_map = cv2.applyColorMap(blurred, cv2.COLORMAP_MAGMA)
        result = depth_map
    else:
        result = frame

    _, buffer = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64_image = base64.b64encode(buffer).decode("utf-8")

    _, orig_buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64_original = base64.b64encode(orig_buffer).decode("utf-8")

    return {
        "conditioning": f"data:image/jpeg;base64,{b64_image}",
        "original": f"data:image/jpeg;base64,{b64_original}",
        "conditioning_type": conditioning_type,
        "frame_time": frame_time,
    }


def post_generate(data: dict[str, Any]) -> dict[str, Any]:
    """POST /api/ic-lora/generate"""
    import ltx2_server as _mod

    video_path = data.get("video_path")
    lora_path = data.get("lora_path")
    conditioning_type = data.get("conditioning_type", "canny")
    prompt = data.get("prompt", "")
    conditioning_strength = float(data.get("conditioning_strength", 1.0))
    seed = int(data.get("seed", 42))
    height = int(data.get("height", 512))
    width = int(data.get("width", 768))
    num_frames = int(data.get("num_frames", 121))
    frame_rate = float(data.get("frame_rate", 24))
    num_inference_steps = int(data.get("num_inference_steps", 30))
    cfg_guidance_scale = float(data.get("cfg_guidance_scale", 1.0))
    negative_prompt = data.get("negative_prompt", "")
    images_input = data.get("images", [])

    if not video_path:
        raise HTTPError(400, "Missing video_path")
    if not lora_path:
        raise HTTPError(400, "Missing lora_path")
    if not Path(video_path).exists():
        raise HTTPError(400, f"Video not found: {video_path}")
    if not Path(lora_path).exists():
        raise HTTPError(400, f"LoRA not found: {lora_path}")

    logger.info(f"IC-LoRA generate: video={video_path}, lora={lora_path}")
    logger.info(f"  conditioning_type={conditioning_type}, prompt={prompt[:100]}")
    logger.info(f"  strength={conditioning_strength}, seed={seed}")
    logger.info(f"  resolution={width}x{height} (output will be {width * 2}x{height * 2}), frames={num_frames}, fps={frame_rate}")

    # Use LTX API for text encoding if available
    _mod._api_embeddings = None
    with _mod.settings_lock:
        ltx_api_key = _mod.app_settings.get("ltx_api_key", "")
    if ltx_api_key:
        logger.info("Using LTX API for text encoding...")
        embeddings = _mod.encode_text_via_api(prompt, ltx_api_key, _mod._cached_model_id)
        if embeddings is not None:
            _mod._api_embeddings = embeddings
        else:
            logger.info("API text encoding failed, falling back to local")

    # Step 1: Preprocess driving video into control signal video
    import cv2

    logger.info(f"Extracting {conditioning_type} control signal from video...")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise HTTPError(400, f"Cannot open video: {video_path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or frame_rate
    src_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    logger.info(f"  Source video: {src_w}x{src_h}, {src_frame_count} frames, {src_fps:.1f} fps")

    control_video_path = str(_mod.OUTPUTS_DIR / f"_control_{conditioning_type}_{uuid.uuid4().hex[:8]}.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out_writer = cv2.VideoWriter(control_video_path, fourcc, src_fps, (src_w, src_h))

    frame_idx = 0
    max_frames = min(src_frame_count, num_frames * 2)
    while True:
        ret, frame = cap.read()
        if not ret or frame_idx >= max_frames:
            break

        if conditioning_type == "canny":
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (5, 5), 0)
            edges = cv2.Canny(blurred, 100, 200)
            control_frame = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
        elif conditioning_type == "depth":
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (15, 15), 0)
            depth_approx = cv2.applyColorMap(blurred, cv2.COLORMAP_INFERNO)
            control_frame = depth_approx
        else:
            control_frame = frame

        out_writer.write(control_frame)
        frame_idx += 1

    cap.release()
    out_writer.release()
    logger.info(f"  Control signal video saved: {control_video_path} ({frame_idx} frames)")

    # Step 2: Load IC-LoRA pipeline
    pipeline = _mod.load_ic_lora_pipeline(lora_path)

    # Step 3: Prepare conditioning
    video_conditioning = [(control_video_path, conditioning_strength)]

    images: list[tuple[str, int, float]] = []
    for img in images_input:
        if isinstance(img, dict):
            images.append((img.get("path", ""), img.get("frame", 0), img.get("strength", 1.0)))
        elif isinstance(img, (list, tuple)) and len(img) >= 2:
            images.append((str(img[0]), int(img[1]), float(img[2]) if len(img) > 2 else 1.0))

    from ltx_core.tiling import TilingConfig

    tiling_config = TilingConfig.default()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    unique_id2 = uuid.uuid4().hex[:8]
    output_filename = f"ic_lora_{timestamp}_{unique_id2}.mp4"
    output_path = _mod.OUTPUTS_DIR / output_filename

    # Step 4: Generate
    logger.info("Starting IC-LoRA generation...")
    pipeline(
        prompt=prompt,
        output_path=str(output_path),
        negative_prompt=negative_prompt,
        seed=seed,
        height=height,
        width=width,
        num_frames=num_frames,
        frame_rate=frame_rate,
        num_inference_steps=num_inference_steps,
        cfg_guidance_scale=cfg_guidance_scale,
        images=images,
        video_conditioning=video_conditioning,
        tiling_config=tiling_config,
    )

    # Clean up temp control video
    try:
        Path(control_video_path).unlink()
    except Exception:
        pass

    logger.info(f"IC-LoRA video saved: {output_path}")
    _mod._api_embeddings = None
    return {"status": "complete", "video_path": str(output_path)}
