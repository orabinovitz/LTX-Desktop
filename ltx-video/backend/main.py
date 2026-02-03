"""
LTX Video Backend - FastAPI server for local GPU video generation.
"""
import os
import asyncio
import logging
from pathlib import Path
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from inference.pipeline import LTXPipeline
from inference.models import ModelManager
from inference.config import get_gpu_info, get_models_path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
pipeline: LTXPipeline | None = None
model_manager: ModelManager | None = None
active_websockets: dict[str, WebSocket] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - initialize and cleanup resources."""
    global pipeline, model_manager
    
    logger.info("Initializing LTX Video Backend...")
    
    # Initialize model manager
    models_path = get_models_path()
    model_manager = ModelManager(models_path)
    
    # Try to load pipeline (may fail if models not available)
    try:
        pipeline = LTXPipeline(models_path)
        if pipeline.is_available():
            logger.info("Pipeline loaded successfully!")
        else:
            logger.warning("Pipeline initialized but models not available yet.")
    except Exception as e:
        logger.error(f"Failed to initialize pipeline: {e}")
        pipeline = None
    
    yield
    
    # Cleanup
    logger.info("Shutting down...")
    if pipeline:
        del pipeline


app = FastAPI(
    title="LTX Video Backend",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS for Electron
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    gpu_info = get_gpu_info()
    pipeline_ready = pipeline is not None and pipeline.is_available()
    
    return {
        "status": "ok",
        "models_loaded": pipeline_ready,
        "gpu_info": gpu_info,
        "models_status": model_manager.get_models_status() if model_manager else [],
    }


@app.get("/api/models")
async def list_models():
    """List available models and their download status."""
    if not model_manager:
        raise HTTPException(status_code=503, detail="Model manager not initialized")
    
    return {
        "models": model_manager.get_models_status()
    }


@app.post("/api/models/{model_id}/download")
async def download_model(model_id: str):
    """Start downloading a model."""
    if not model_manager:
        raise HTTPException(status_code=503, detail="Model manager not initialized")
    
    # This will be handled via WebSocket for progress updates
    asyncio.create_task(model_manager.download_model(model_id))
    return {"status": "download_started", "model_id": model_id}


@app.websocket("/ws/download/{model_id}")
async def download_progress_ws(websocket: WebSocket, model_id: str):
    """WebSocket for model download progress."""
    await websocket.accept()
    
    if not model_manager:
        await websocket.send_json({"type": "error", "message": "Model manager not initialized"})
        await websocket.close()
        return
    
    try:
        async for progress in model_manager.download_with_progress(model_id):
            await websocket.send_json({
                "type": "progress",
                "progress": progress["progress"],
                "speed": progress.get("speed", 0),
                "eta": progress.get("eta", 0),
            })
        
        await websocket.send_json({"type": "complete"})
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})
    finally:
        await websocket.close()


@app.post("/api/generate")
def generate_video(
    prompt: str = Form(""),  # Made optional for image-only generation
    model: str = Form("fast"),
    duration: int = Form(8),
    resolution: str = Form("1080p"),
    fps: int = Form(25),
    audio: str = Form("true"),
    camera_motion: str = Form("none"),
    image: UploadFile | None = File(None),
):
    """Start video generation."""
    global pipeline
    
    if not pipeline or not pipeline.is_available():
        raise HTTPException(
            status_code=503, 
            detail="Video generation not available. Please ensure all models are downloaded and LTX packages are installed."
        )
    
    # Parse parameters
    generate_audio = audio.lower() == "true"
    
    # Resolution mapping - all dimensions divisible by 32
    resolution_map = {
        "512p": (768, 512),
        "720p": (1216, 704),
        "1080p": (1920, 1088),
    }
    width, height = resolution_map.get(resolution, (1216, 704))
    
    # Calculate frames from duration and fps (must be 8n+1)
    num_frames = ((duration * fps) // 8) * 8 + 1
    
    # Handle image upload and preprocessing
    image_data = None
    if image:
        from PIL import Image as PILImage
        from io import BytesIO
        
        # Read and open image (sync read since we're in sync endpoint)
        raw_data = image.file.read()
        img = PILImage.open(BytesIO(raw_data)).convert("RGB")
        
        # Resize and center crop to target dimensions
        # Step 1: Scale so the smaller dimension fits, maintaining aspect ratio
        img_width, img_height = img.size
        target_ratio = width / height
        img_ratio = img_width / img_height
        
        if img_ratio > target_ratio:
            # Image is wider - scale by height, crop width
            new_height = height
            new_width = int(img_width * (height / img_height))
        else:
            # Image is taller - scale by width, crop height
            new_width = width
            new_height = int(img_height * (width / img_width))
        
        img = img.resize((new_width, new_height), PILImage.Resampling.LANCZOS)
        
        # Step 2: Center crop to exact target dimensions
        left = (new_width - width) // 2
        top = (new_height - height) // 2
        img = img.crop((left, top, left + width, top + height))
        
        # Convert back to bytes
        buffer = BytesIO()
        img.save(buffer, format="PNG")
        image_data = buffer.getvalue()
        
        logger.info(f"Image preprocessed: original {img_width}x{img_height} -> {width}x{height}")
    
    # Generate video (runs synchronously - CUDA works best on main thread)
    try:
        output_path = pipeline.generate(
            prompt=prompt,
            image_data=image_data,
            width=width,
            height=height,
            num_frames=num_frames,
            fps=fps,
            model_type=model,
            camera_motion=camera_motion if camera_motion != "none" else None,
            generate_audio=generate_audio,
        )
        
        return {"status": "complete", "video_path": str(output_path)}
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.websocket("/ws/generate")
async def generate_progress_ws(websocket: WebSocket):
    """WebSocket for generation progress updates."""
    await websocket.accept()
    
    # Register this websocket for progress updates
    ws_id = str(id(websocket))
    active_websockets[ws_id] = websocket
    
    try:
        # Keep connection alive until generation completes or client disconnects
        while True:
            try:
                # Wait for messages (ping/pong or close)
                await asyncio.wait_for(websocket.receive_text(), timeout=60)
            except asyncio.TimeoutError:
                # Send ping to keep connection alive
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    finally:
        del active_websockets[ws_id]


@app.get("/api/video/{filename}")
async def get_video(filename: str):
    """Serve generated video file."""
    output_dir = Path(get_models_path()).parent / "outputs"
    video_path = output_dir / filename
    
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    
    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=filename,
    )


async def broadcast_progress(progress: float, message: str):
    """Broadcast progress to all connected WebSocket clients."""
    for ws in active_websockets.values():
        try:
            await ws.send_json({
                "type": "progress",
                "progress": progress,
                "message": message,
            })
        except Exception:
            pass


async def broadcast_complete(video_url: str):
    """Broadcast completion to all connected WebSocket clients."""
    for ws in active_websockets.values():
        try:
            await ws.send_json({
                "type": "complete",
                "videoUrl": video_url,
            })
        except Exception:
            pass


async def broadcast_error(message: str):
    """Broadcast error to all connected WebSocket clients."""
    for ws in active_websockets.values():
        try:
            await ws.send_json({
                "type": "error",
                "message": message,
            })
        except Exception:
            pass


if __name__ == "__main__":
    port = int(os.environ.get("LTX_PORT", 8000))
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        log_level="info",
    )
