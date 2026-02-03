"""
LTX-2 Video Generation Pipeline.

Uses the Diffusers library for video generation with LTX-2 models.
"""
import asyncio
import logging
import uuid
from datetime import datetime
from pathlib import Path
from io import BytesIO
from typing import Callable

from PIL import Image

from .config import (
    get_outputs_path,
    MODEL_TYPES,
    RESOLUTION_PRESETS,
)

logger = logging.getLogger(__name__)

# Check if PyTorch and ML packages are available
TORCH_AVAILABLE = False
DIFFUSERS_AVAILABLE = False

try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    logger.warning("PyTorch not installed. GPU inference will not be available.")

try:
    from diffusers import LTXPipeline as DiffusersLTXPipeline
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video
    DIFFUSERS_AVAILABLE = True
except ImportError:
    logger.warning("Diffusers LTXPipeline not available.")

# Progress callback type
ProgressCallback = Callable[[float, str], None]


class LTXPipeline:
    """Wrapper around LTX-2 video generation pipeline using Diffusers."""
    
    def __init__(self, models_path: Path):
        self.models_path = models_path
        self.outputs_path = get_outputs_path()
        self.pipeline = None
        self._load_pipeline()
    
    def _load_pipeline(self):
        """Load the LTX-2 pipeline using Diffusers."""
        if not TORCH_AVAILABLE:
            logger.warning("PyTorch not available. Pipeline will run in demo mode.")
            self.pipeline = None
            return
            
        if not DIFFUSERS_AVAILABLE:
            logger.warning("Diffusers not available. Pipeline will run in demo mode.")
            self.pipeline = None
            return
            
        logger.info("Loading LTX pipeline from Hugging Face...")
        
        try:
            # Load text-to-video pipeline
            self.t2v_pipeline = DiffusersLTXPipeline.from_pretrained(
                "Lightricks/LTX-Video",
                torch_dtype=torch.bfloat16,
            )
            
            # Load image-to-video pipeline
            self.i2v_pipeline = LTXImageToVideoPipeline.from_pretrained(
                "Lightricks/LTX-Video",
                torch_dtype=torch.bfloat16,
            )
            
            # Move to GPU
            if torch.cuda.is_available():
                device = "cuda"
                self.t2v_pipeline = self.t2v_pipeline.to(device)
                self.i2v_pipeline = self.i2v_pipeline.to(device)
                logger.info(f"Pipelines loaded on GPU: {torch.cuda.get_device_name(0)}")
            else:
                logger.warning("CUDA not available, running on CPU (will be slow)")
            
            # Enable memory optimizations for GPU with <24GB VRAM
            # For RTX 5090 with 32GB, we have plenty of headroom
            # self.t2v_pipeline.enable_model_cpu_offload()
            # self.i2v_pipeline.enable_model_cpu_offload()
            
            self.pipeline = self.t2v_pipeline  # Default to T2V
            logger.info("Pipelines loaded successfully!")
            
        except Exception as e:
            logger.error(f"Failed to load pipeline: {e}")
            self.pipeline = None
    
    def generate(
        self,
        prompt: str,
        image_data: bytes | None = None,
        width: int = 1280,
        height: int = 720,
        num_frames: int = 121,  # ~5 seconds at 24fps
        fps: float = 24.0,
        model_type: str = "fast",
        camera_motion: str | None = None,
        generate_audio: bool = True,
        seed: int | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> Path:
        """
        Generate a video from text/image prompt using Diffusers.
        
        Args:
            prompt: Text description of the video
            image_data: Optional image bytes for image-to-video
            width: Output video width
            height: Output video height
            num_frames: Number of frames to generate
            fps: Frames per second
            model_type: "fast" (distilled) or "pro"
            camera_motion: Optional camera motion type
            generate_audio: Whether to generate audio
            seed: Random seed for reproducibility
            progress_callback: Callback for progress updates
        
        Returns:
            Path to the generated video file
        """
        if not self.pipeline:
            raise RuntimeError("Pipeline not loaded")
        
        # Generate seed if not provided
        if seed is None:
            seed = torch.randint(0, 2147483647, (1,)).item()
        
        generator = torch.Generator(device="cuda" if torch.cuda.is_available() else "cpu")
        generator.manual_seed(seed)
        
        # Prepare output path
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_filename = f"ltx_video_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
        output_path = self.outputs_path / output_filename
        
        # Process image if provided
        input_image = None
        if image_data:
            input_image = Image.open(BytesIO(image_data)).convert("RGB")
            input_image = input_image.resize((width, height))
            logger.info(f"Image loaded and resized to {width}x{height}")
        
        try:
            # Ensure num_frames is 8n+1 for LTX-Video
            adjusted_frames = ((num_frames - 1) // 8) * 8 + 1
            if adjusted_frames < 9:
                adjusted_frames = 9  # Minimum 9 frames
            
            logger.info(f"Starting inference: {width}x{height}, {adjusted_frames} frames")
            
            # Run inference synchronously (CUDA works best on main thread)
            if input_image:
                logger.info("Running image-to-video generation...")
                output = self.i2v_pipeline(
                    prompt=prompt if prompt else "A video",
                    image=input_image,
                    num_frames=adjusted_frames,
                    height=height,
                    width=width,
                    generator=generator,
                    num_inference_steps=25,
                    guidance_scale=3.0,
                )
            else:
                logger.info("Running text-to-video generation...")
                output = self.t2v_pipeline(
                    prompt=prompt,
                    num_frames=adjusted_frames,
                    height=height,
                    width=width,
                    generator=generator,
                    num_inference_steps=25,
                    guidance_scale=3.0,
                )
            
            logger.info("Inference complete, exporting video...")
            frames = output.frames[0]
            export_to_video(frames, str(output_path), fps=int(fps))
            logger.info(f"Video saved to: {output_path}")
            
        except Exception as e:
            logger.error(f"Inference failed: {e}")
            raise
        
        logger.info(f"Video generated: {output_path}")
        return output_path
    
    async def _async_callback(self, callback: ProgressCallback, progress: float, message: str):
        """Helper to call progress callback asynchronously."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, callback, progress, message)
    
    def get_memory_usage(self) -> dict:
        """Get current GPU memory usage."""
        if TORCH_AVAILABLE and torch.cuda.is_available():
            return {
                "allocated": torch.cuda.memory_allocated() / (1024**3),  # GB
                "reserved": torch.cuda.memory_reserved() / (1024**3),
                "max_allocated": torch.cuda.max_memory_allocated() / (1024**3),
            }
        return {}
    
    def clear_cache(self):
        """Clear GPU memory cache."""
        if TORCH_AVAILABLE and torch.cuda.is_available():
            torch.cuda.empty_cache()
    
    def is_available(self) -> bool:
        """Check if the pipeline is ready for generation."""
        return self.pipeline is not None and DIFFUSERS_AVAILABLE
