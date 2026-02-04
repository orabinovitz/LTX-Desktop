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

# Note: expandable_segments is not supported on all platforms
# With 32GB VRAM on RTX 5090, it's not needed anyway

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
    "result": None,
    "error": None,
    "status": "idle",  # idle, running, complete, cancelled, error
    "phase": "",  # loading_model, encoding_text, inference, decoding, complete
    "progress": 0,  # 0-100
    "current_step": 0,
    "total_steps": 0,
}
generation_lock = threading.Lock()

# Warmup state
warmup_state = {
    "status": "pending",  # pending, loading, warming, ready, error
    "current_step": "",
    "progress": 0,  # 0-100
    "error": None,
}
warmup_lock = threading.Lock()

# App settings
app_settings = {
    "keep_models_loaded": False,  # If True, keep text encoder in VRAM between generations
    "use_torch_compile": False,  # Disabled by default - can cause long compile times
    "load_on_startup": False,  # If True, preload models at startup; if False, load on first generation
}
settings_lock = threading.Lock()

# Cached text encoder (only used when keep_models_loaded is True)
cached_text_encoder = None

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


# Track if models have been compiled
compiled_models = {"fast": False, "pro": False}


def compile_pipeline_transformer(pipeline, model_type: str):
    """Compile the transformer model using torch.compile() for faster inference.
    
    torch.compile() optimizes the model by tracing and compiling it to efficient
    kernels. The first run after compilation is slower (compilation happens), 
    but subsequent runs are significantly faster (20-40% speedup).
    """
    global compiled_models
    
    # Check if torch.compile is enabled
    if not app_settings.get("use_torch_compile", True):
        logger.info(f"torch.compile() disabled in settings, skipping for {model_type}")
        return
    
    if compiled_models.get(model_type):
        logger.info(f"Transformer for {model_type} already compiled")
        return
    
    try:
        # Access the transformer through the model_ledger
        # The transformer is loaded lazily, so we need to get it first
        transformer = pipeline.model_ledger.transformer()
        
        if transformer is not None:
            logger.info(f"Compiling {model_type} transformer with torch.compile()...")
            start = time.time()
            
            # Use 'reduce-overhead' mode for best inference speed
            # Other options: 'default', 'max-autotune' (slower compile, faster run)
            compiled_transformer = torch.compile(
                transformer,
                mode="reduce-overhead",
                fullgraph=False,  # Allow graph breaks for compatibility
            )
            
            # Replace the transformer in the model_ledger
            # Store the original method
            original_transformer_method = pipeline.model_ledger.transformer
            
            def compiled_transformer_method():
                return compiled_transformer
            
            pipeline.model_ledger.transformer = compiled_transformer_method
            compiled_models[model_type] = True
            
            logger.info(f"Transformer compiled in {time.time() - start:.1f}s")
        else:
            logger.warning(f"Could not access transformer for {model_type}")
            
    except Exception as e:
        logger.warning(f"Failed to compile transformer for {model_type}: {e}")
        logger.warning("Continuing without torch.compile() optimization")


def load_pipeline(model_type: str = "fast"):
    """Load the appropriate LTX-2 pipeline based on model type."""
    global distilled_pipeline, pro_pipeline
    
    try:
        if model_type == "fast" and distilled_pipeline is None:
            from ltx_pipelines.distilled import DistilledPipeline
            
            logger.info("Loading LTX-2 Distilled Pipeline (Fast, 2-stage with upsampling)...")
            start = time.time()
            
            # DistilledPipeline is two-stage:
            # Stage 1: Generate at half resolution (fast, 8 steps)
            # Stage 2: Upsample 2x + refine (slower, 4 steps)
            # Spatial upsampler is REQUIRED for this pipeline
            distilled_pipeline = DistilledPipeline(
                checkpoint_path=str(CHECKPOINT_PATH),
                gemma_root=str(GEMMA_PATH),
                spatial_upsampler_path=str(UPSAMPLER_PATH),
                loras=[],
                device=DEVICE,
                fp8transformer=True,
            )
            
            # Patch the model_ledger to support caching
            patch_model_ledger_for_caching(distilled_pipeline.model_ledger)
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(distilled_pipeline, "fast")
            
            logger.info(f"Distilled Pipeline loaded in {time.time() - start:.1f}s")
            return distilled_pipeline
            
        elif model_type == "pro" and pro_pipeline is None:
            from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
            
            logger.info("Loading LTX-2 Two-Stage Pipeline (Pro)...")
            start = time.time()
            
            # Always provide upsampler path (required by pipeline)
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
            
            # Patch the model_ledger to support caching
            patch_model_ledger_for_caching(pro_pipeline.model_ledger)
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(pro_pipeline, "pro")
            
            logger.info(f"Pro Pipeline loaded in {time.time() - start:.1f}s")
            return pro_pipeline
        
        return distilled_pipeline if model_type == "fast" else pro_pipeline
        
    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        import traceback
        traceback.print_exc()
        return None


def patch_model_ledger_for_caching(model_ledger):
    """Patch the model_ledger to cache text encoder when setting is enabled."""
    global cached_text_encoder
    
    # Store the original method
    original_text_encoder = model_ledger.text_encoder
    
    def cached_text_encoder_method():
        global cached_text_encoder
        
        # Check if caching is enabled
        if app_settings["keep_models_loaded"]:
            if cached_text_encoder is not None:
                logger.info("Using cached text encoder")
                return cached_text_encoder
            else:
                logger.info("Loading and caching text encoder...")
                cached_text_encoder = original_text_encoder()
                return cached_text_encoder
        else:
            # Caching disabled, use original behavior
            return original_text_encoder()
    
    # Replace the method
    model_ledger.text_encoder = cached_text_encoder_method
    logger.info("Model ledger patched for text encoder caching")


def unload_pipeline(model_type: str):
    """Unload a pipeline to free VRAM."""
    global distilled_pipeline, pro_pipeline
    
    if model_type == "fast" and distilled_pipeline is not None:
        logger.info("Unloading Fast pipeline to free VRAM...")
        del distilled_pipeline
        distilled_pipeline = None
        torch.cuda.empty_cache()
        logger.info("Fast pipeline unloaded")
    elif model_type == "pro" and pro_pipeline is not None:
        logger.info("Unloading Pro pipeline to free VRAM...")
        del pro_pipeline
        pro_pipeline = None
        torch.cuda.empty_cache()
        logger.info("Pro pipeline unloaded")


def get_pipeline(model_type: str = "fast", skip_warmup: bool = False):
    """Get or load the appropriate pipeline.
    
    Only one model is loaded at a time to conserve VRAM.
    Switching models will unload the previous one.
    
    Args:
        model_type: "fast" or "pro"
        skip_warmup: If True, skip warmup (user's generation serves as warmup)
    """
    global distilled_pipeline, pro_pipeline
    
    if model_type == "fast":
        if distilled_pipeline is None:
            # Unload Pro if loaded to free VRAM
            if pro_pipeline is not None:
                unload_pipeline("pro")
            load_pipeline("fast")
            # Only warmup if preloading at startup (not on-demand loading)
            if not skip_warmup:
                warmup_pipeline("fast")
        return distilled_pipeline
    else:
        if pro_pipeline is None:
            # Unload Fast if loaded to free VRAM
            if distilled_pipeline is not None:
                unload_pipeline("fast")
            load_pipeline("pro")
            if not skip_warmup:
                warmup_pipeline("pro")
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
        # Use smallest valid dimensions to minimize warmup time
        warmup_path = OUTPUTS_DIR / f"_warmup_{model_type}.mp4"
        
        # Minimum valid: 9 frames (8*1+1), small resolution divisible by 32
        warmup_height = 320
        warmup_width = 480
        warmup_frames = 9  # Minimum valid for 8n+1
        
        if model_type == "fast":
            pipeline(
                prompt="test warmup",
                output_path=str(warmup_path),
                seed=42,
                height=warmup_height,
                width=warmup_width,
                num_frames=warmup_frames,
                frame_rate=8,
                images=[],
                tiling_config=TilingConfig.default(),
            )
        else:
            pipeline(
                prompt="test warmup",
                output_path=str(warmup_path),
                negative_prompt="",
                seed=42,
                height=warmup_height,
                width=warmup_width,
                num_frames=warmup_frames,
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


def update_generation_progress(phase: str, progress: int, current_step: int = 0, total_steps: int = 0):
    """Update the current generation progress."""
    global current_generation
    with generation_lock:
        current_generation["phase"] = phase
        current_generation["progress"] = progress
        current_generation["current_step"] = current_step
        current_generation["total_steps"] = total_steps


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
    
    # Determine total steps for this model
    total_steps = 8 if model_type == "fast" else 40
    update_generation_progress("loading_model", 5, 0, total_steps)
    
    # Skip warmup - the user's generation itself serves as the warmup
    pipeline = get_pipeline(model_type, skip_warmup=True)
    if pipeline is None:
        raise RuntimeError(f"Failed to load {model_type} pipeline")
    
    from ltx_core.tiling import TilingConfig
    
    update_generation_progress("encoding_text", 10, 0, total_steps)
    
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
        
        # Update progress to inference phase (this is where most time is spent)
        update_generation_progress("inference", 15, 0, total_steps)
        
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
        
        # Update progress to complete
        total_steps = 8 if model_type == "fast" else 40
        update_generation_progress("complete", 100, total_steps, total_steps)
        
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
            # Determine which model is currently active
            active_model = None
            if distilled_pipeline is not None:
                active_model = "fast"
            elif pro_pipeline is not None:
                active_model = "pro"
            
            self.send_json_response(200, {
                "status": "ok",
                "models_loaded": distilled_pipeline is not None or pro_pipeline is not None,
                "active_model": active_model,
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
        elif self.path == "/api/warmup/status":
            self.send_json_response(200, {
                "status": warmup_state["status"],
                "currentStep": warmup_state["current_step"],
                "progress": warmup_state["progress"],
                "error": warmup_state["error"],
            })
        elif self.path == "/api/generation/progress":
            with generation_lock:
                self.send_json_response(200, {
                    "status": current_generation["status"],
                    "phase": current_generation["phase"],
                    "progress": current_generation["progress"],
                    "currentStep": current_generation["current_step"],
                    "totalSteps": current_generation["total_steps"],
                })
        elif self.path == "/api/settings":
            self.send_json_response(200, {
                "keepModelsLoaded": app_settings["keep_models_loaded"],
                "useTorchCompile": app_settings["use_torch_compile"],
                "loadOnStartup": app_settings["load_on_startup"],
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
                # Based on LTX-2 VRAM requirements for RTX 5090 (32GB)
                resolution_map = {
                    "1080p": (1920, 1088),  # Stable up to 12-20 sec
                    "720p": (1280, 736),    # Very stable, recommended
                    "480p": (768, 512),     # Fast preview mode
                }
                width, height = resolution_map.get(resolution, (1280, 736))
                
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
                
                # Generate synchronously (fast - models stay loaded)
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
                    logger.info(f"Cancel requested for generation {current_generation['id']}")
                    # Note: Cancel flag is checked between generation phases
                    # Cannot interrupt mid-inference (GPU operations are atomic)
                    self.send_json_response(200, {"status": "cancelling", "id": current_generation["id"]})
                else:
                    self.send_json_response(200, {"status": "no_active_generation"})
        elif self.path == "/api/settings":
            try:
                content_len = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_len).decode('utf-8')
                data = json.loads(body)
                
                with settings_lock:
                    if 'keepModelsLoaded' in data:
                        old_value = app_settings["keep_models_loaded"]
                        app_settings["keep_models_loaded"] = bool(data['keepModelsLoaded'])
                        if old_value != app_settings["keep_models_loaded"]:
                            logger.info(f"Setting 'keep_models_loaded' changed to: {app_settings['keep_models_loaded']}")
                            # Clear cached encoder if disabling
                            if not app_settings["keep_models_loaded"]:
                                global cached_text_encoder
                                if cached_text_encoder is not None:
                                    del cached_text_encoder
                                    cached_text_encoder = None
                                    torch.cuda.empty_cache()
                                    logger.info("Cleared cached text encoder")
                    
                    if 'useTorchCompile' in data:
                        old_value = app_settings["use_torch_compile"]
                        app_settings["use_torch_compile"] = bool(data['useTorchCompile'])
                        if old_value != app_settings["use_torch_compile"]:
                            logger.info(f"Setting 'use_torch_compile' changed to: {app_settings['use_torch_compile']}")
                            logger.info("Restart required for torch.compile changes to take effect")
                    
                    if 'loadOnStartup' in data:
                        old_value = app_settings["load_on_startup"]
                        app_settings["load_on_startup"] = bool(data['loadOnStartup'])
                        if old_value != app_settings["load_on_startup"]:
                            logger.info(f"Setting 'load_on_startup' changed to: {app_settings['load_on_startup']}")
                            logger.info("Restart required for this change to take effect")
                
                self.send_json_response(200, {"status": "ok"})
            except Exception as e:
                logger.error(f"Failed to update settings: {e}")
                self.send_json_response(500, {"error": str(e)})
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


def background_warmup():
    """Run model loading and warmup in background thread.
    
    If load_on_startup is False (default), just download models and mark ready.
    Models will load on first generation.
    """
    global warmup_state
    
    try:
        with warmup_lock:
            warmup_state["status"] = "loading"
            warmup_state["current_step"] = "Checking models..."
            warmup_state["progress"] = 10
        
        # Download models if needed
        logger.info("Checking models...")
        download_models()
        
        # Check if we should preload models at startup
        if not app_settings.get("load_on_startup", False):
            # Lazy loading - don't load models until first generation
            with warmup_lock:
                warmup_state["status"] = "ready"
                warmup_state["current_step"] = "Ready (models load on first use)"
                warmup_state["progress"] = 100
            
            logger.info("="*60)
            logger.info("Models downloaded and ready!")
            logger.info("Models will load on first generation (lazy loading)")
            logger.info("="*60)
            return
        
        # Preload models at startup (if setting enabled)
        with warmup_lock:
            warmup_state["current_step"] = "Loading Fast model..."
            warmup_state["progress"] = 30
        
        logger.info("[1/2] Loading Fast (Distilled) pipeline...")
        if load_pipeline("fast"):
            logger.info("[1/2] Fast pipeline ready!")
        else:
            logger.warning("[1/2] Fast pipeline failed to load")
        
        with warmup_lock:
            warmup_state["status"] = "warming"
            warmup_state["current_step"] = "Warming up Fast model..."
            warmup_state["progress"] = 60
        
        logger.info("[2/2] Warming up Fast pipeline (loading text encoder)...")
        warmup_pipeline("fast")
        logger.info("[2/2] Fast pipeline warmed up!")
        
        with warmup_lock:
            warmup_state["status"] = "ready"
            warmup_state["current_step"] = "Ready!"
            warmup_state["progress"] = 100
        
        logger.info("="*60)
        logger.info("Fast model loaded and ready!")
        logger.info("Pro model will load on first use (to conserve VRAM)")
        logger.info("="*60)
        
    except Exception as e:
        logger.error(f"Background warmup failed: {e}")
        import traceback
        traceback.print_exc()
        with warmup_lock:
            warmup_state["status"] = "error"
            warmup_state["error"] = str(e)


if __name__ == "__main__":
    logger.info("="*60)
    logger.info("LTX-2 Video Generation Server (Fast Mode)")
    logger.info("Models stay loaded for fastest inference")
    logger.info("="*60)
    
    # Start warmup in background thread
    warmup_thread = threading.Thread(target=background_warmup, daemon=True)
    warmup_thread.start()
    
    # Start server immediately so frontend can connect
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        logger.info(f"Server running on http://127.0.0.1:{PORT}")
        logger.info("Models will load in background - frontend can connect now")
        httpd.serve_forever()
