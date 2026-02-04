"""
LTX-2 Video Generation Server using the official ltx-pipelines package.
Supports both text-to-video (T2V) and image-to-video (I2V).
"""
import os
import http.server
import socketserver
import json
import logging
from pathlib import Path
from datetime import datetime
import uuid
import cgi
import time
import tempfile
import threading
import signal

# Set environment for CUDA
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

import torch
from PIL import Image
from io import BytesIO
from huggingface_hub import hf_hub_download, snapshot_download

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

PORT = 8000
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16

# Model paths
MODELS_DIR = Path.home() / ".cache" / "ltx-video" / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

OUTPUTS_DIR = Path(__file__).parent / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

# Model file paths
CHECKPOINT_PATH = MODELS_DIR / "ltx-2-19b-distilled-fp8.safetensors"
UPSAMPLER_PATH = MODELS_DIR / "ltx-2-spatial-upscaler-x2-1.0.safetensors"
# Gemma root should contain both text_encoder and tokenizer folders
GEMMA_PATH = MODELS_DIR
DISTILLED_LORA_PATH = MODELS_DIR / "ltx-2-19b-distilled-lora-384.safetensors"

# Global pipelines (lazy loaded)
distilled_pipeline = None
pro_pipeline = None

# Generation state
current_generation = {
    "id": None,
    "cancelled": False,
    "thread": None,
    "result": None,
    "error": None,
    "status": "idle",  # idle, running, complete, cancelled, error
}
generation_lock = threading.Lock()

# Camera motion prompt enhancements
CAMERA_MOTION_PROMPTS = {
    "none": "",
    "static": ", static camera, locked off shot, no camera movement",
    "focus_shift": ", focus shift, rack focus, changing focal point",
    "dolly_in": ", dolly in, camera pushing forward, smooth forward movement",
    "dolly_out": ", dolly out, camera pulling back, smooth backward movement",
    "dolly_left": ", dolly left, camera tracking left, lateral movement",
    "dolly_right": ", dolly right, camera tracking right, lateral movement",
    "jib_up": ", jib up, camera rising up, upward crane movement",
    "jib_down": ", jib down, camera lowering down, downward crane movement",
}

# Default negative prompt for Pro model
DEFAULT_NEGATIVE_PROMPT = """blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of field"""


def download_models():
    """Download required models from Hugging Face if not present."""
    repo_id = "Lightricks/LTX-2"
    
    models_to_download = [
        ("ltx-2-19b-distilled-fp8.safetensors", CHECKPOINT_PATH),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", UPSAMPLER_PATH),
        ("ltx-2-19b-distilled-lora-384.safetensors", DISTILLED_LORA_PATH),
    ]
    
    for filename, local_path in models_to_download:
        if not local_path.exists():
            logger.info(f"Downloading {filename}...")
            hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=MODELS_DIR,
                local_dir_use_symlinks=False,
            )
            logger.info(f"Downloaded {filename}")
        else:
            logger.info(f"Found {filename}")
    
    # Download text encoder (folder)
    if not GEMMA_PATH.exists() or not any(GEMMA_PATH.iterdir()):
        logger.info("Downloading text_encoder...")
        snapshot_download(
            repo_id=repo_id,
            allow_patterns=["text_encoder/*"],
            local_dir=MODELS_DIR,
            local_dir_use_symlinks=False,
        )
        logger.info("Downloaded text_encoder")
    else:
        logger.info("Found text_encoder")


def load_pipeline(model_type: str = "fast"):
    """Load the appropriate LTX-2 pipeline based on model type."""
    global distilled_pipeline, pro_pipeline
    
    try:
        if model_type == "fast" and distilled_pipeline is None:
            from ltx_pipelines.distilled import DistilledPipeline
            
            logger.info("Loading LTX-2 Distilled Pipeline (Fast)...")
            start = time.time()
            
            distilled_pipeline = DistilledPipeline(
                checkpoint_path=str(CHECKPOINT_PATH),
                gemma_root=str(GEMMA_PATH),
                spatial_upsampler_path=str(UPSAMPLER_PATH),
                loras=[],
                device=DEVICE,
                fp8transformer=True,
            )
            
            logger.info(f"Distilled Pipeline loaded in {time.time() - start:.1f}s")
            return distilled_pipeline
            
        elif model_type == "pro" and pro_pipeline is None:
            from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
            
            logger.info("Loading LTX-2 Two-Stage Pipeline (Pro)...")
            start = time.time()
            
            pro_pipeline = TI2VidTwoStagesPipeline(
                checkpoint_path=str(CHECKPOINT_PATH),
                gemma_root=str(GEMMA_PATH),
                spatial_upsampler_path=str(UPSAMPLER_PATH),
                distilled_lora_path=str(DISTILLED_LORA_PATH),
                distilled_lora_strength=1.0,
                loras=[],
                device=DEVICE,
                fp8transformer=True,
            )
            
            logger.info(f"Pro Pipeline loaded in {time.time() - start:.1f}s")
            return pro_pipeline
        
        return distilled_pipeline if model_type == "fast" else pro_pipeline
        
    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        import traceback
        traceback.print_exc()
        return None


def get_pipeline(model_type: str = "fast"):
    """Get or load the appropriate pipeline."""
    global distilled_pipeline, pro_pipeline
    
    if model_type == "fast":
        if distilled_pipeline is None:
            load_pipeline("fast")
        return distilled_pipeline
    else:
        if pro_pipeline is None:
            load_pipeline("pro")
        return pro_pipeline


def warmup_pipeline(model_type: str):
    """Run a minimal generation to pre-load all weights including text encoder."""
    pipeline = get_pipeline(model_type)
    if pipeline is None:
        logger.warning(f"Cannot warmup {model_type} pipeline - not loaded")
        return
    
    logger.info(f"Warming up {model_type} pipeline (loading text encoder)...")
    
    try:
        from ltx_core.tiling import TilingConfig
        
        # Minimal generation to force weight loading
        warmup_path = OUTPUTS_DIR / f"_warmup_{model_type}.mp4"
        
        if model_type == "fast":
            pipeline(
                prompt="test",
                output_path=str(warmup_path),
                seed=42,
                height=256,
                width=256,
                num_frames=9,
                frame_rate=8,
                images=[],
                tiling_config=TilingConfig.default(),
            )
        else:
            pipeline(
                prompt="test",
                output_path=str(warmup_path),
                negative_prompt="",
                seed=42,
                height=256,
                width=256,
                num_frames=9,
                frame_rate=8,
                num_inference_steps=5,  # Minimal steps for warmup
                cfg_guidance_scale=3.0,
                images=[],
                tiling_config=TilingConfig.default(),
            )
        
        # Cleanup warmup file
        if warmup_path.exists():
            warmup_path.unlink()
        
        logger.info(f"{model_type.capitalize()} pipeline warmed up - text encoder loaded!")
        
    except Exception as e:
        logger.error(f"Warmup failed for {model_type}: {e}")
        import traceback
        traceback.print_exc()


def generate_video(
    prompt: str, 
    image: Image.Image | None, 
    height: int, 
    width: int, 
    num_frames: int, 
    fps: float, 
    seed: int,
    model_type: str = "fast",
    camera_motion: str = "none",
    negative_prompt: str = "",
    generation_id: str = None,
) -> str:
    """Generate a video using the LTX-2 pipeline."""
    global current_generation
    
    # Check if already cancelled before starting
    if current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")
    
    pipeline = get_pipeline(model_type)
    if pipeline is None:
        raise RuntimeError(f"Failed to load {model_type} pipeline")
    
    from ltx_core.tiling import TilingConfig
    
    # Enhance prompt with camera motion
    enhanced_prompt = prompt + CAMERA_MOTION_PROMPTS.get(camera_motion, "")
    
    # Prepare image conditioning
    images = []
    temp_image_path = None
    
    if image is not None:
        # Save image temporarily for the pipeline
        temp_image_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        image.save(temp_image_path)
        images = [(temp_image_path, 0, 1.0)]  # Image at frame 0, strength 1.0
    
    # Prepare output path
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"ltx2_video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
    output_path = OUTPUTS_DIR / output_filename
    
    try:
        logger.info(f"Model: {model_type}, Camera: {camera_motion}")
        logger.info(f"Generating: {width}x{height}, {num_frames} frames, seed={seed}")
        logger.info(f"Prompt: {enhanced_prompt[:100]}...")
        
        start = time.time()
        
        tiling_config = TilingConfig.default()
        
        if model_type == "fast":
            # Distilled pipeline (fast, 8 steps)
            pipeline(
                prompt=enhanced_prompt,
                output_path=str(output_path),
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                images=images,
                tiling_config=tiling_config,
            )
        else:
            # Pro pipeline (higher quality, more steps)
            neg_prompt = negative_prompt if negative_prompt else DEFAULT_NEGATIVE_PROMPT
            pipeline(
                prompt=enhanced_prompt,
                output_path=str(output_path),
                negative_prompt=neg_prompt,
                seed=seed,
                height=height,
                width=width,
                num_frames=num_frames,
                frame_rate=fps,
                num_inference_steps=40,
                cfg_guidance_scale=3.0,
                images=images,
                tiling_config=tiling_config,
            )
        
        # Check if cancelled after generation
        if current_generation["cancelled"]:
            # Clean up the output file if cancelled
            if output_path.exists():
                output_path.unlink()
            raise RuntimeError("Generation was cancelled")
        
        logger.info(f"Generation took {time.time() - start:.1f}s")
        logger.info(f"Saved to {output_path}")
        return str(output_path)
        
    finally:
        # Cleanup temp image
        if temp_image_path and os.path.exists(temp_image_path):
            os.unlink(temp_image_path)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging
    
    def send_json_response(self, status: int, data: dict):
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
    
    def do_GET(self):
        if self.path == "/health":
            self.send_json_response(200, {
                "status": "ok",
                "models_loaded": distilled_pipeline is not None and pro_pipeline is not None,
                "fast_loaded": distilled_pipeline is not None,
                "pro_loaded": pro_pipeline is not None,
                "gpu_info": get_gpu_info(),
                "models_status": [
                    {"id": "fast", "name": "LTX-2 Fast (Distilled)", "loaded": distilled_pipeline is not None, "downloaded": CHECKPOINT_PATH.exists()},
                    {"id": "pro", "name": "LTX-2 Pro (Two-Stage)", "loaded": pro_pipeline is not None, "downloaded": CHECKPOINT_PATH.exists()}
                ]
            })
        elif self.path == "/api/models":
            self.send_json_response(200, [
                {"id": "fast", "name": "Fast (Distilled)", "description": "Quick generation with 8 steps"},
                {"id": "pro", "name": "Pro (Two-Stage)", "description": "Higher quality with 40 steps"}
            ])
        elif self.path == "/api/camera-motions":
            self.send_json_response(200, [
                {"id": "none", "name": "None"},
                {"id": "static", "name": "Static"},
                {"id": "dolly_in", "name": "Dolly In"},
                {"id": "dolly_out", "name": "Dolly Out"},
                {"id": "pan_left", "name": "Pan Left"},
                {"id": "pan_right", "name": "Pan Right"},
                {"id": "jib_up", "name": "Jib Up"},
                {"id": "jib_down", "name": "Jib Down"},
                {"id": "orbit_left", "name": "Orbit Left"},
                {"id": "orbit_right", "name": "Orbit Right"},
            ])
        elif self.path == "/api/generation/status":
            self.send_json_response(200, {
                "id": current_generation["id"],
                "status": current_generation["status"],
            })
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        global current_generation
        
        if self.path == "/api/generate":
            try:
                # Check if already generating
                if current_generation["status"] == "running":
                    self.send_json_response(409, {"error": "Generation already in progress"})
                    return
                
                # Parse multipart form data
                content_type = self.headers.get('Content-Type')
                ctype, pdict = cgi.parse_header(content_type)
                pdict['boundary'] = pdict['boundary'].encode()
                
                content_len = int(self.headers.get('Content-Length'))
                form = cgi.parse_multipart(self.rfile, pdict)
                
                # Helper to decode form values
                def get_form_value(key, default):
                    val = form.get(key, [default])[0]
                    if isinstance(val, bytes):
                        val = val.decode()
                    return val
                
                # Extract parameters
                prompt = get_form_value('prompt', 'A beautiful video')
                resolution = get_form_value('resolution', '512p')
                model_type = get_form_value('model', 'fast')
                camera_motion = get_form_value('cameraMotion', 'none')
                negative_prompt = get_form_value('negativePrompt', '')
                
                duration = int(get_form_value('duration', '2'))
                fps = int(get_form_value('fps', '24'))
                
                # Resolution mapping (dimensions must be divisible by 32)
                resolution_map = {
                    "4k": (3840, 2160),
                    "1440p": (2560, 1440),
                    "1080p": (1920, 1088),
                    "720p": (1280, 704),
                    "512p": (768, 512),
                }
                width, height = resolution_map.get(resolution, (1920, 1088))
                
                # Calculate frames (must be 8n+1 for LTX-2)
                num_frames = ((duration * fps) // 8) * 8 + 1
                if num_frames < 9:
                    num_frames = 9
                
                # Handle image
                image = None
                image_data = form.get('image', [None])[0]
                if image_data:
                    img = Image.open(BytesIO(image_data)).convert("RGB")
                    # Resize to target dimensions
                    img_w, img_h = img.size
                    target_ratio = width / height
                    img_ratio = img_w / img_h
                    
                    if img_ratio > target_ratio:
                        new_h = height
                        new_w = int(img_w * (height / img_h))
                    else:
                        new_w = width
                        new_h = int(img_h * (width / img_w))
                    
                    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                    left = (new_w - width) // 2
                    top = (new_h - height) // 2
                    image = resized.crop((left, top, left + width, top + height))
                    logger.info(f"Image: {img_w}x{img_h} -> {width}x{height}")
                
                # Reset generation state
                generation_id = uuid.uuid4().hex[:8]
                with generation_lock:
                    current_generation["id"] = generation_id
                    current_generation["cancelled"] = False
                    current_generation["result"] = None
                    current_generation["error"] = None
                    current_generation["status"] = "running"
                
                # Generate (synchronously for now, as pipeline doesn't support async well)
                seed = int(time.time()) % 2147483647
                output_path = generate_video(
                    prompt=prompt,
                    image=image,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    fps=fps,
                    seed=seed,
                    model_type=model_type,
                    camera_motion=camera_motion,
                    negative_prompt=negative_prompt,
                    generation_id=generation_id,
                )
                
                with generation_lock:
                    current_generation["status"] = "complete"
                    current_generation["result"] = output_path
                
                self.send_json_response(200, {"status": "complete", "video_path": output_path})
                
            except Exception as e:
                with generation_lock:
                    if current_generation["cancelled"]:
                        current_generation["status"] = "cancelled"
                    else:
                        current_generation["status"] = "error"
                        current_generation["error"] = str(e)
                
                if "cancelled" in str(e).lower():
                    logger.info("Generation cancelled by user")
                    self.send_json_response(200, {"status": "cancelled"})
                else:
                    logger.error(f"Generation error: {e}")
                    import traceback
                    traceback.print_exc()
                    self.send_json_response(500, {"error": str(e)})
                    
        elif self.path == "/api/generate/cancel":
            with generation_lock:
                if current_generation["status"] == "running":
                    current_generation["cancelled"] = True
                    logger.info(f"Cancellation requested for generation {current_generation['id']}")
                    self.send_json_response(200, {"status": "cancelling", "id": current_generation["id"]})
                else:
                    self.send_json_response(200, {"status": "no_active_generation"})
        else:
            self.send_response(404)
            self.end_headers()


def get_gpu_info():
    """Get GPU information."""
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        pynvml.nvmlShutdown()
        return {
            "name": name,
            "vram": memory.total // (1024 * 1024),
            "vramUsed": memory.used // (1024 * 1024),
        }
    except Exception:
        return {"name": "Unknown", "vram": 0, "vramUsed": 0}


if __name__ == "__main__":
    logger.info("="*60)
    logger.info("LTX-2 Video Generation Server")
    logger.info("="*60)
    
    # Download models if needed
    logger.info("Checking models...")
    download_models()
    
    # Pre-load ALL pipelines on startup for instant generation
    logger.info("Pre-loading all pipelines (this may take a minute)...")
    
    logger.info("[1/4] Loading Fast (Distilled) pipeline...")
    if load_pipeline("fast"):
        logger.info("[1/4] Fast pipeline ready!")
    else:
        logger.warning("[1/4] Fast pipeline failed to load")
    
    logger.info("[2/4] Warming up Fast pipeline (loading text encoder)...")
    warmup_pipeline("fast")
    logger.info("[2/4] Fast pipeline warmed up!")
    
    logger.info("[3/4] Loading Pro (Two-Stage) pipeline...")
    if load_pipeline("pro"):
        logger.info("[3/4] Pro pipeline ready!")
    else:
        logger.warning("[3/4] Pro pipeline failed to load")
    
    logger.info("[4/4] Warming up Pro pipeline (loading text encoder)...")
    warmup_pipeline("pro")
    logger.info("[4/4] Pro pipeline warmed up!")
    
    logger.info("="*60)
    logger.info("All pipelines loaded and warmed up!")
    logger.info("Text encoder weights are cached - instant generation ready!")
    logger.info("="*60)
    
    # Start server
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        logger.info(f"Server running on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
