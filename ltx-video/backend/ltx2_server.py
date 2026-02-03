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

# Global pipeline
pipeline = None


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


def load_pipeline():
    """Load the LTX-2 distilled pipeline."""
    global pipeline
    
    try:
        from ltx_pipelines.distilled import DistilledPipeline
        
        logger.info("Loading LTX-2 Distilled Pipeline...")
        start = time.time()
        
        pipeline = DistilledPipeline(
            checkpoint_path=str(CHECKPOINT_PATH),
            gemma_root=str(GEMMA_PATH),
            spatial_upsampler_path=str(UPSAMPLER_PATH),
            loras=[],
            device=DEVICE,
            fp8transformer=True,  # Use FP8 for memory efficiency
        )
        
        logger.info(f"Pipeline loaded in {time.time() - start:.1f}s")
        return True
        
    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_video(prompt: str, image: Image.Image | None, height: int, width: int, 
                   num_frames: int, fps: float, seed: int) -> str:
    """Generate a video using the LTX-2 pipeline."""
    global pipeline
    
    if pipeline is None:
        raise RuntimeError("Pipeline not loaded")
    
    from ltx_core.tiling import TilingConfig
    
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
        logger.info(f"Generating: {width}x{height}, {num_frames} frames, seed={seed}")
        logger.info(f"Prompt: {prompt[:100]}...")
        
        start = time.time()
        
        tiling_config = TilingConfig.default()
        
        # Generate video (pipeline saves directly to output_path)
        pipeline(
            prompt=prompt,
            output_path=str(output_path),
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=fps,
            images=images,
            tiling_config=tiling_config,
        )
        
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
                "models_loaded": pipeline is not None,
                "gpu_info": get_gpu_info(),
                "models_status": [
                    {"id": "ltx-2", "name": "LTX-2 Distilled", "downloaded": CHECKPOINT_PATH.exists(), "downloadProgress": 100 if CHECKPOINT_PATH.exists() else 0}
                ]
            })
        elif self.path == "/api/models":
            self.send_json_response(200, [
                {"id": "fast", "name": "Fast (Distilled)", "description": "Quick generation with 8 steps"}
            ])
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        if self.path == "/api/generate":
            try:
                # Parse multipart form data
                content_type = self.headers.get('Content-Type')
                ctype, pdict = cgi.parse_header(content_type)
                pdict['boundary'] = pdict['boundary'].encode()
                
                content_len = int(self.headers.get('Content-Length'))
                form = cgi.parse_multipart(self.rfile, pdict)
                
                # Extract parameters
                prompt = form.get('prompt', ['A beautiful video'])[0]
                if isinstance(prompt, bytes):
                    prompt = prompt.decode()
                
                resolution = form.get('resolution', ['512p'])[0]
                if isinstance(resolution, bytes):
                    resolution = resolution.decode()
                
                duration = int(form.get('duration', ['2'])[0])
                fps = int(form.get('fps', ['24'])[0])
                
                # Resolution mapping (dimensions must be divisible by 32)
                resolution_map = {
                    "512p": (768, 512),
                    "720p": (1216, 704),
                    "1080p": (1920, 1088),
                }
                width, height = resolution_map.get(resolution, (768, 512))
                
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
                
                # Generate
                seed = int(time.time()) % 2147483647
                output_path = generate_video(
                    prompt=prompt,
                    image=image,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    fps=fps,
                    seed=seed,
                )
                
                self.send_json_response(200, {"status": "complete", "video_path": output_path})
                
            except Exception as e:
                logger.error(f"Generation error: {e}")
                import traceback
                traceback.print_exc()
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


if __name__ == "__main__":
    logger.info("="*60)
    logger.info("LTX-2 Video Generation Server")
    logger.info("="*60)
    
    # Download models if needed
    logger.info("Checking models...")
    download_models()
    
    # Load pipeline
    logger.info("Loading pipeline...")
    if load_pipeline():
        logger.info("Pipeline ready!")
    else:
        logger.warning("Pipeline not loaded - generation will fail")
    
    # Start server
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        logger.info(f"Server running on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
