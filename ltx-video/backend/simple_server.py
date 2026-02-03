"""Minimal HTTP server - using the exact same code that works fast."""
import http.server
import socketserver
import json
import torch
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime
import uuid
import cgi
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PORT = 8000

# Load pipeline ONCE at startup
logger.info("Loading pipeline...")
start = time.time()
pipe = LTXImageToVideoPipeline.from_pretrained(
    "Lightricks/LTX-Video",
    torch_dtype=torch.bfloat16,
).to("cuda")
logger.info(f"Pipeline loaded in {time.time() - start:.1f}s")

outputs_dir = Path(__file__).parent / "outputs"
outputs_dir.mkdir(exist_ok=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default logging
        pass
    
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok", 
                "models_loaded": True,
                "gpu_info": {"name": "NVIDIA GeForce RTX 5090", "vram": 32607},
                "models_status": [{"id": "ltx-video", "name": "LTX-Video", "downloaded": True, "downloadProgress": 100}]
            }).encode())
        elif self.path == "/api/models":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps([
                {"id": "fast", "name": "Fast (Distilled)", "description": "Quick generation"}
            ]).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
    
    def do_POST(self):
        if self.path == "/api/generate":
            # Parse multipart form data
            content_type = self.headers.get('Content-Type')
            ctype, pdict = cgi.parse_header(content_type)
            pdict['boundary'] = pdict['boundary'].encode()
            
            content_len = int(self.headers.get('Content-Length'))
            form = cgi.parse_multipart(self.rfile, pdict)
            
            prompt = form.get('prompt', [''])[0]
            if isinstance(prompt, bytes):
                prompt = prompt.decode()
            
            # Get image
            image_data = form.get('image', [None])[0]
            
            if image_data:
                img = Image.open(BytesIO(image_data)).convert("RGB")
                img = img.resize((768, 512), Image.Resampling.LANCZOS)
                logger.info(f"Image resized to 768x512")
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Image required")
                return
            
            # Generate
            logger.info(f"Generating with prompt: {prompt[:50]}...")
            start = time.time()
            
            # LTXImageToVideoPipeline requires image_cond_noise_scale for motion
            output = pipe(
                image=img,
                prompt=prompt if prompt else "A beautiful cinematic video with smooth motion",
                num_frames=49,  # ~2 seconds at 24fps
                height=512,
                width=768,
                num_inference_steps=50,  # More steps for better quality
                guidance_scale=7.5,  # Higher guidance for better prompt adherence
            )
            
            logger.info(f"Inference took {time.time() - start:.1f}s")
            
            # Save
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = outputs_dir / f"video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
            export_to_video(output.frames[0], str(output_path), fps=24)
            logger.info(f"Saved to {output_path}")
            
            # Response
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "complete", "video_path": str(output_path)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        logger.info(f"Server running on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
