"""Simple Flask backend for LTX Video - no async/threading issues with CUDA."""
import os
import logging
from pathlib import Path
from datetime import datetime
import uuid

from flask import Flask, request, jsonify
from flask_cors import CORS

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Global pipeline instance
pipeline = None
pipeline_loaded = False

def get_gpu_info():
    """Get GPU information."""
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        return {
            "name": name,
            "vram": memory.total // (1024 * 1024),
            "vramUsed": memory.used // (1024 * 1024),
        }
    except Exception as e:
        logger.warning(f"Could not get GPU info: {e}")
        return {"name": "Unknown", "vram": 0, "vramUsed": 0}

def ensure_pipeline():
    """Load pipeline on first use (same thread as inference)."""
    global pipeline, pipeline_loaded
    
    if pipeline_loaded:
        return pipeline is not None
    
    try:
        import torch
        from diffusers import LTXPipeline, LTXImageToVideoPipeline
        
        logger.info("Loading LTX pipelines (first request - this takes ~10 seconds)...")
        
        # Text-to-video pipeline
        t2v_pipeline = LTXPipeline.from_pretrained(
            "Lightricks/LTX-Video",
            torch_dtype=torch.bfloat16,
        )
        
        # Image-to-video pipeline  
        i2v_pipeline = LTXImageToVideoPipeline.from_pretrained(
            "Lightricks/LTX-Video",
            torch_dtype=torch.bfloat16,
        )
        
        if torch.cuda.is_available():
            t2v_pipeline = t2v_pipeline.to("cuda")
            i2v_pipeline = i2v_pipeline.to("cuda")
            logger.info(f"Pipelines loaded on GPU: {torch.cuda.get_device_name(0)}")
        
        pipeline = {
            "t2v": t2v_pipeline,
            "i2v": i2v_pipeline,
        }
        pipeline_loaded = True
        logger.info("Pipelines ready!")
        return True
        
    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        pipeline_loaded = True  # Mark as attempted
        return False

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    gpu_info = get_gpu_info()
    return jsonify({
        "status": "ok",
        "models_loaded": pipeline_loaded and pipeline is not None,
        "gpu_info": gpu_info,
        "models_status": [
            {"id": "checkpoint", "name": "LTX-Video", "downloaded": True, "downloadProgress": 100.0},
        ]
    })

@app.route('/api/models', methods=['GET'])
def get_models():
    """Get available models."""
    return jsonify([
        {"id": "fast", "name": "Fast (Distilled)", "description": "Quick generation"},
    ])

@app.route('/api/generate', methods=['POST'])
def generate_video():
    """Generate video from prompt/image."""
    import torch
    from PIL import Image
    from io import BytesIO
    from diffusers.utils import export_to_video
    
    # Ensure pipeline is loaded
    if not ensure_pipeline():
        return jsonify({"error": "Pipeline not available"}), 503
    
    # Parse form data
    prompt = request.form.get('prompt', '')
    resolution = request.form.get('resolution', '512p')
    duration = int(request.form.get('duration', 2))
    fps = int(request.form.get('fps', 24))
    
    # Resolution mapping
    resolution_map = {
        "512p": (768, 512),
        "720p": (1216, 704),
        "1080p": (1920, 1088),
    }
    width, height = resolution_map.get(resolution, (768, 512))
    
    # Calculate frames (8n+1)
    num_frames = ((duration * fps) // 8) * 8 + 1
    if num_frames < 9:
        num_frames = 9
    
    # Handle image
    input_image = None
    if 'image' in request.files:
        image_file = request.files['image']
        img = Image.open(image_file).convert("RGB")
        
        # Resize and center crop
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
        input_image = resized.crop((left, top, left + width, top + height))
        
        logger.info(f"Image: {img_w}x{img_h} -> {width}x{height}")
    
    # Generate
    logger.info(f"Generating: {width}x{height}, {num_frames} frames, prompt='{prompt[:50]}...'")
    
    generator = torch.Generator("cuda").manual_seed(42)
    
    try:
        if input_image:
            output = pipeline["i2v"](
                prompt=prompt if prompt else "A video",
                image=input_image,
                num_frames=num_frames,
                height=height,
                width=width,
                generator=generator,
                num_inference_steps=25,
                guidance_scale=3.0,
            )
        else:
            output = pipeline["t2v"](
                prompt=prompt,
                num_frames=num_frames,
                height=height,
                width=width,
                generator=generator,
                num_inference_steps=25,
                guidance_scale=3.0,
            )
        
        # Save video
        outputs_dir = Path(__file__).parent / "outputs"
        outputs_dir.mkdir(exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = outputs_dir / f"ltx_video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
        
        export_to_video(output.frames[0], str(output_path), fps=fps)
        logger.info(f"Video saved: {output_path}")
        
        return jsonify({"status": "complete", "video_path": str(output_path)})
        
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    logger.info("Starting Flask server on port 8000...")
    logger.info("Pipeline will load on first request.")
    app.run(host='127.0.0.1', port=8000, threaded=False, debug=False)
