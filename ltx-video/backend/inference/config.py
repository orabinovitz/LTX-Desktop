"""
Configuration and hardware detection for LTX Video.
"""
import os
import logging
from pathlib import Path
from typing import TypedDict

logger = logging.getLogger(__name__)


class GPUInfo(TypedDict):
    name: str
    vram: int  # Total VRAM in MB
    vramUsed: int  # Used VRAM in MB


def get_gpu_info() -> GPUInfo | None:
    """Get information about the available GPU."""
    try:
        import pynvml
        pynvml.nvmlInit()
        
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode('utf-8')
        
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        
        pynvml.nvmlShutdown()
        
        return {
            "name": name,
            "vram": memory.total // (1024 * 1024),  # Convert to MB
            "vramUsed": memory.used // (1024 * 1024),
        }
    except Exception as e:
        logger.warning(f"Could not get GPU info: {e}")
        return None


def get_models_path() -> Path:
    """Get the path where models are stored."""
    # Check environment variable first
    if models_path := os.environ.get("LTX_MODELS_PATH"):
        return Path(models_path)
    
    # Default to user data directory
    if os.name == "nt":  # Windows
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:  # macOS/Linux
        base = Path.home() / ".local" / "share"
    
    models_path = base / "ltx-video" / "models"
    models_path.mkdir(parents=True, exist_ok=True)
    
    return models_path


def get_outputs_path() -> Path:
    """Get the path where generated videos are stored."""
    if os.name == "nt":  # Windows
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:  # macOS/Linux
        base = Path.home() / ".local" / "share"
    
    outputs_path = base / "ltx-video" / "outputs"
    outputs_path.mkdir(parents=True, exist_ok=True)
    
    return outputs_path


# Model configurations - LTX-2 from Hugging Face
MODELS_CONFIG = {
    "checkpoint": {
        "repo_id": "Lightricks/LTX-2",
        "filename": "ltx-2-19b-distilled-fp8.safetensors",
        "size_gb": 27.1,
        "description": "LTX-2 19B Distilled FP8 checkpoint",
    },
    "spatial_upsampler": {
        "repo_id": "Lightricks/LTX-2",
        "filename": "ltx-2-spatial-upscaler-x2-1.0.safetensors",
        "size_gb": 1.0,
        "description": "Spatial upscaler for higher resolution",
    },
    "text_encoder": {
        "repo_id": "Lightricks/LTX-2",
        "subfolder": "text_encoder",
        "size_gb": 24.0,
        "description": "Gemma text encoder",
    },
    "distilled_lora": {
        "repo_id": "Lightricks/LTX-2",
        "filename": "ltx-2-19b-distilled-lora-384.safetensors",
        "size_gb": 7.7,
        "description": "Distilled LoRA for fast generation",
    },
}


# Resolution presets - all dimensions must be divisible by 32
RESOLUTION_PRESETS = {
    "512p": {"width": 768, "height": 512},   # 3:2 aspect, fast
    "720p": {"width": 1216, "height": 704},  # ~16:9 aspect, standard
    "1080p": {"width": 1920, "height": 1088},  # ~16:9 aspect, high quality
}


def make_divisible_by_32(value: int) -> int:
    """Round a value to the nearest multiple of 32."""
    return ((value + 16) // 32) * 32


def resize_for_model(width: int, height: int) -> tuple[int, int]:
    """Ensure width and height are divisible by 32."""
    return make_divisible_by_32(width), make_divisible_by_32(height)


# Model type configurations
MODEL_TYPES = {
    "fast": {
        "use_distilled": True,
        "steps": 8,
        "lora_strength": 0.6,
    },
    "pro": {
        "use_distilled": False,
        "steps": 20,
        "lora_strength": 0.0,
    },
}
