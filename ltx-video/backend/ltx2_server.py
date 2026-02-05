"""
LTX-2 Video Generation Server using the official ltx-pipelines package.
Supports both text-to-video (T2V) and image-to-video (I2V).
"""
import os
import gc
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
import requests
from PIL import Image
from io import BytesIO
from huggingface_hub import hf_hub_download, snapshot_download

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ============================================================
# Memory Optimization Settings
# ============================================================
# Note: With 32GB VRAM and proper model swapping, we don't need
# to artificially limit memory. Let PyTorch use what it needs.

# ============================================================
# SageAttention Integration for Faster Inference
# ============================================================
# SageAttention provides 2-3x speedup for attention operations
# by using INT8 quantization for QK^T computation
USE_SAGE_ATTENTION = os.environ.get("USE_SAGE_ATTENTION", "1") == "1"

if USE_SAGE_ATTENTION:
    try:
        from sageattention import sageattn
        import torch.nn.functional as F
        
        # Store original for fallback
        _original_sdpa = F.scaled_dot_product_attention
        
        def patched_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, **kwargs):
            """Wrapper to use SageAttention when possible, fallback to original otherwise.
            
            Note: **kwargs handles additional parameters like 'enable_gqa' from newer diffusers.
            """
            try:
                # SageAttention works best with standard shapes
                # It expects (batch, heads, seq_len, head_dim)
                if query.dim() == 4 and attn_mask is None and dropout_p == 0.0:
                    return sageattn(query, key, value, is_causal=is_causal, tensor_layout="HND")
                else:
                    return _original_sdpa(query, key, value, attn_mask=attn_mask, 
                                         dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kwargs)
            except Exception:
                # Fallback to original on any error
                return _original_sdpa(query, key, value, attn_mask=attn_mask, 
                                     dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kwargs)
        
        F.scaled_dot_product_attention = patched_sdpa
        logger.info("SageAttention enabled - attention operations will be faster")
    except ImportError:
        logger.warning("SageAttention not installed - using default attention")
        USE_SAGE_ATTENTION = False
    except Exception as e:
        logger.warning(f"Failed to enable SageAttention: {e}")
        USE_SAGE_ATTENTION = False

PORT = 8000
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16

# Model paths - project folder (gitignored, auto-downloaded on first run)
PROJECT_ROOT = Path(__file__).parent.parent  # ltx-video folder
MODELS_DIR = PROJECT_ROOT / "models" / "ltx-2"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

FLUX_MODELS_DIR = PROJECT_ROOT / "models" / "FLUX.2-klein-4B"

OUTPUTS_DIR = Path(__file__).parent / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

# LTX-2 Model file paths
CHECKPOINT_PATH = MODELS_DIR / "ltx-2-19b-distilled-fp8.safetensors"
UPSAMPLER_PATH = MODELS_DIR / "ltx-2-spatial-upscaler-x2-1.0.safetensors"
# Gemma root should contain both text_encoder and tokenizer folders
GEMMA_PATH = MODELS_DIR
DISTILLED_LORA_PATH = MODELS_DIR / "ltx-2-19b-distilled-lora-384.safetensors"

# Global pipelines (lazy loaded)
distilled_pipeline = None
pro_pipeline = None
flux_pipeline = None  # Flux Klein 4B for image generation

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
    "keep_models_loaded": True,  # Reserved for future use (e.g., unload pipeline after generation)
    "use_torch_compile": False,  # Disabled by default - can cause long compile times
    "load_on_startup": False,  # If True, preload models at startup; if False, load on first generation
    "ltx_api_key": "",  # LTX API key for fast text encoding (~1s vs 23s local)
}
settings_lock = threading.Lock()

# Text encoder caching (used when not using LTX API)
cached_text_encoder = None

# LTX API endpoint for text encoding
LTX_API_BASE_URL = "https://api.ltx.video"


def get_model_id_from_checkpoint(checkpoint_path: str) -> str:
    """Extract the model_id from checkpoint metadata for LTX API."""
    try:
        from safetensors import safe_open
        with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
            metadata = f.metadata()
            if metadata and "encrypted_wandb_properties" in metadata:
                return metadata["encrypted_wandb_properties"]
    except Exception as e:
        logger.warning(f"Could not extract model_id from checkpoint: {e}")
    return None


def encode_text_via_api(prompt: str, api_key: str, model_id: str) -> tuple:
    """Encode text using the LTX API (free, ~1s instead of 23s local).
    
    Returns:
        Tuple of (video_context, audio_context) tensors, or None if failed
    """
    if not model_id:
        logger.warning("No model_id available for API encoding")
        return None
        
    try:
        logger.info("Encoding text via LTX API (~1s)...")
        start = time.time()
        
        response = requests.post(
            f"{LTX_API_BASE_URL}/v1/prompt-embedding",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "prompt": prompt,
                "model_id": model_id,
            },
            timeout=60,
        )
        
        if response.status_code == 401:
            logger.warning("LTX API: Invalid API key")
            return None
        
        if response.status_code != 200:
            logger.warning(f"LTX API error {response.status_code}: {response.text}")
            return None
        
        # Response is pickled conditioning data
        import pickle
        import io
        conditioning = pickle.load(io.BytesIO(response.content))
        
        # Extract video and audio context from conditioning
        # Conditioning format: [[tensor, dict], ...] where dict has 'attention_mask'
        if conditioning and len(conditioning) > 0:
            embeddings = conditioning[0][0]  # The tensor
            # Check if it contains both video and audio (concatenated)
            if embeddings.shape[-1] > 3840:  # Has audio component
                video_context = embeddings[..., :3840].to(dtype=torch.bfloat16, device=DEVICE)
                audio_context = embeddings[..., 3840:].to(dtype=torch.bfloat16, device=DEVICE)
            else:
                video_context = embeddings.to(dtype=torch.bfloat16, device=DEVICE)
                audio_context = None
            
            logger.info(f"Text encoded via API in {time.time() - start:.1f}s")
            return (video_context, audio_context)
        
        logger.warning("LTX API returned unexpected conditioning format")
        return None
        
    except Exception as e:
        logger.warning(f"LTX API encoding failed: {e}, falling back to local encoder")
        return None


# Cache the model_id after first extraction
_cached_model_id = None

# Thread-local storage for API embeddings injection
_api_embeddings = None
_encode_text_patched = False


def patch_encode_text_for_api():
    """Patch the encode_text function to use pre-computed API embeddings when available.
    
    The DistilledPipeline imports encode_text with 'from ... import encode_text',
    so we need to patch it in BOTH places:
    1. pipeline_utils.encode_text (for any module-level access)
    2. distilled.encode_text (where the pipeline actually uses it)
    """
    global _encode_text_patched
    if _encode_text_patched:
        return
    
    try:
        from ltx_pipelines import pipeline_utils
        from ltx_pipelines import distilled as distilled_module
        
        original_encode_text = pipeline_utils.encode_text
        
        def patched_encode_text(text_encoder, prompts, *args, **kwargs):
            global _api_embeddings
            # If we have pre-computed API embeddings, use them instead of encoding
            if _api_embeddings is not None:
                video_context, audio_context = _api_embeddings
                logger.info("Using pre-computed API embeddings (skipping text encoder entirely)")
                # Return in the same format as the original function
                # Original returns list of (video_context, audio_context) tuples
                return [(video_context, audio_context)]
            # Otherwise, use the original encoder
            return original_encode_text(text_encoder, prompts, *args, **kwargs)
        
        # Patch in both locations
        pipeline_utils.encode_text = patched_encode_text
        distilled_module.encode_text = patched_encode_text
        
        _encode_text_patched = True
        logger.info("Patched encode_text for API embeddings injection (both modules)")
    except Exception as e:
        logger.warning(f"Could not patch encode_text: {e}")


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
            
            # Patch encode_text to support API embeddings injection
            patch_encode_text_for_api()
            
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


class DummyTextEncoder:
    """Dummy text encoder returned when using API embeddings.
    
    The pipeline calls model_ledger.text_encoder() unconditionally,
    but when we have API embeddings, we don't need the real encoder.
    This dummy is passed to encode_text() which will use the API embeddings instead.
    """
    pass


def patch_model_ledger_for_caching(model_ledger):
    """Patch the model_ledger to cache text encoder in CPU RAM.
    
    LTX-2's architecture unloads the text encoder to free VRAM for the transformer.
    We cache it in CPU RAM (not GPU) to avoid the 23s disk load on each generation,
    while still freeing GPU VRAM for the transformer.
    
    Trade-off: ~2-3s CPU→GPU transfer instead of 23s disk load.
    
    Also: when API embeddings are available, return a dummy encoder to skip loading entirely.
    """
    global cached_text_encoder
    
    # Store the original method
    original_text_encoder = model_ledger.text_encoder
    
    def cached_text_encoder_method():
        global cached_text_encoder, _api_embeddings
        
        # If we have API embeddings, return dummy - don't load real encoder
        if _api_embeddings is not None:
            logger.info("API embeddings available - skipping text encoder load entirely")
            return DummyTextEncoder()
        
        # If we have a CPU-cached encoder, move it to GPU
        if cached_text_encoder is not None:
            logger.info("Moving cached text encoder from CPU to GPU...")
            start = time.time()
            cached_text_encoder.to(DEVICE)
            torch.cuda.synchronize()
            logger.info(f"Text encoder ready in {time.time() - start:.1f}s (vs 23s from disk)")
            return cached_text_encoder
        
        # First time: load from disk and keep reference
        logger.info("Loading text encoder from disk (first time, ~23s)...")
        cached_text_encoder = original_text_encoder()
        logger.info("Text encoder loaded and cached in CPU RAM")
        return cached_text_encoder
    
    # Replace the method
    model_ledger.text_encoder = cached_text_encoder_method
    
    # Patch cleanup_memory to also move our cached encoder to CPU
    # This ensures VRAM is freed before transformer loads
    from ltx_pipelines import utils as ltx_utils
    original_cleanup = ltx_utils.cleanup_memory
    
    def patched_cleanup_memory():
        global cached_text_encoder
        # Move cached encoder to CPU before cleanup
        if cached_text_encoder is not None:
            try:
                cached_text_encoder.to("cpu")
                logger.debug("Moved cached text encoder to CPU during cleanup")
            except Exception:
                pass
        # Call original cleanup
        original_cleanup()
    
    ltx_utils.cleanup_memory = patched_cleanup_memory
    
    logger.info("Text encoder caching enabled - first gen ~23s, subsequent ~2-3s")


def unload_pipeline(model_type: str):
    """Unload a pipeline to free VRAM."""
    global distilled_pipeline, pro_pipeline, flux_pipeline
    
    if model_type == "fast" and distilled_pipeline is not None:
        logger.info("Unloading Fast pipeline to free VRAM...")
        del distilled_pipeline
        distilled_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Fast pipeline unloaded")
    elif model_type == "pro" and pro_pipeline is not None:
        logger.info("Unloading Pro pipeline to free VRAM...")
        del pro_pipeline
        pro_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Pro pipeline unloaded")
    elif model_type == "flux" and flux_pipeline is not None:
        logger.info("Unloading Flux pipeline to free VRAM...")
        del flux_pipeline
        flux_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Flux pipeline unloaded")


def download_flux_model():
    """Download FLUX.2 Klein 4B model if not present."""
    if FLUX_MODELS_DIR.exists() and any(FLUX_MODELS_DIR.iterdir()):
        logger.info("Found FLUX.2 Klein 4B model")
        return True
    
    logger.info("Downloading FLUX.2 Klein 4B model...")
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(
            repo_id="black-forest-labs/FLUX.2-klein-4B",
            local_dir=str(FLUX_MODELS_DIR),
            local_dir_use_symlinks=False,
        )
        logger.info("FLUX.2 Klein 4B downloaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to download FLUX.2 Klein 4B: {e}")
        return False


def load_flux_pipeline():
    """Load the Flux Klein 4B pipeline for image generation."""
    global flux_pipeline
    
    if flux_pipeline is not None:
        return flux_pipeline
    
    try:
        # FLUX.2-klein-4B uses Flux2KleinPipeline (requires diffusers from main branch)
        from diffusers import Flux2KleinPipeline
        
        logger.info("Loading FLUX.2 Klein 4B Pipeline for image generation...")
        start = time.time()
        
        # Clear CUDA cache first
        torch.cuda.empty_cache()
        gc.collect()
        
        # Check if model exists in project folder
        if FLUX_MODELS_DIR.exists() and any(FLUX_MODELS_DIR.iterdir()):
            model_path = str(FLUX_MODELS_DIR)
            logger.info(f"Loading from project folder: {model_path}")
        else:
            # Try to download
            logger.info("FLUX.2 Klein 4B not found locally, downloading...")
            if not download_flux_model():
                raise RuntimeError("Failed to download FLUX.2 Klein 4B model")
            model_path = str(FLUX_MODELS_DIR)
        
        # Load using Flux2KleinPipeline (dedicated pipeline for Klein models with Qwen3)
        flux_pipeline = Flux2KleinPipeline.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
        )
        
        # Move to GPU
        flux_pipeline.to("cuda")
        
        logger.info(f"FLUX.2 Klein 4B Pipeline loaded in {time.time() - start:.1f}s")
        return flux_pipeline
        
    except Exception as e:
        logger.error(f"Failed to load Flux pipeline: {e}")
        import traceback
        traceback.print_exc()
        return None


def get_flux_pipeline():
    """Get or load the Flux pipeline."""
    global flux_pipeline
    
    if flux_pipeline is None:
        # Unload video pipelines to free VRAM for Flux
        if distilled_pipeline is not None:
            unload_pipeline("fast")
        if pro_pipeline is not None:
            unload_pipeline("pro")
        # Clear CUDA cache after unloading
        torch.cuda.empty_cache()
        import gc
        gc.collect()
        load_flux_pipeline()
    
    return flux_pipeline


def generate_image(
    prompt: str,
    width: int = 1024,
    height: int = 1024,
    num_inference_steps: int = 4,
    seed: int = None,
    generation_id: str = None,
) -> str:
    """Generate an image using the Flux pipeline."""
    global current_generation
    
    # Check if already cancelled before starting
    if current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")
    
    update_generation_progress("loading_model", 5, 0, num_inference_steps)
    
    pipeline = get_flux_pipeline()
    if pipeline is None:
        raise RuntimeError("Failed to load Flux pipeline")
    
    update_generation_progress("inference", 15, 0, num_inference_steps)
    
    # Generate image
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"flux_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
    output_path = OUTPUTS_DIR / output_filename
    
    try:
        logger.info(f"Generating image: {width}x{height}, seed={seed}")
        logger.info(f"Prompt: {prompt[:100]}...")
        
        start = time.time()
        
        # Set seed for reproducibility
        # Use "cuda" device for generator when using CPU offload
        if seed is None:
            seed = int(time.time()) % 2147483647
        generator = torch.Generator(device="cuda").manual_seed(seed)
        
        # Generate the image using Flux2KleinPipeline
        # guidance_scale=1.0, num_inference_steps=4 is recommended
        result = pipeline(
            prompt=prompt,
            height=height,
            width=width,
            guidance_scale=1.0,
            num_inference_steps=num_inference_steps,
            generator=generator,
        )
        
        # Check if cancelled after generation
        if current_generation["cancelled"]:
            raise RuntimeError("Generation was cancelled")
        
        # Save the image
        image = result.images[0]
        image.save(str(output_path))
        
        update_generation_progress("complete", 100, num_inference_steps, num_inference_steps)
        
        logger.info(f"Image generation took {time.time() - start:.1f}s")
        logger.info(f"Saved to {output_path}")
        return str(output_path)
        
    except Exception as e:
        logger.error(f"Image generation failed: {e}")
        raise


def get_pipeline(model_type: str = "fast", skip_warmup: bool = False):
    """Get or load the appropriate pipeline.
    
    Only one model is loaded at a time to conserve VRAM.
    Switching models will unload the previous one.
    
    Args:
        model_type: "fast" or "pro"
        skip_warmup: If True, skip warmup (user's generation serves as warmup)
    """
    global distilled_pipeline, pro_pipeline, flux_pipeline
    
    # Always unload Flux pipeline first to free VRAM for video generation
    if flux_pipeline is not None:
        logger.info("Unloading Flux pipeline to free VRAM for video generation...")
        unload_pipeline("flux")
        torch.cuda.empty_cache()
        gc.collect()
    
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
        # Note: Pipeline upsamples 2x, so warmup outputs at 2x these dimensions
        warmup_height = 256
        warmup_width = 384
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
        
        # Check if LTX API key is configured for fast text encoding
        global _api_embeddings, _cached_model_id
        _api_embeddings = None  # Reset before each generation
        
        with settings_lock:
            ltx_api_key = app_settings.get("ltx_api_key", "")
        
        if ltx_api_key:
            # Get or cache the model_id from checkpoint
            if _cached_model_id is None:
                _cached_model_id = get_model_id_from_checkpoint(str(CHECKPOINT_PATH))
            
            if _cached_model_id:
                # Use LTX API for text encoding (~1s vs 23s local)
                embeddings = encode_text_via_api(enhanced_prompt, ltx_api_key, _cached_model_id)
                if embeddings is not None:
                    # Store embeddings globally - the patched encode_text will use them
                    _api_embeddings = embeddings
                    logger.info("API embeddings ready for injection")
                else:
                    logger.info("API encoding failed, falling back to local encoder")
            else:
                logger.warning("Could not extract model_id from checkpoint, using local encoder")
        
        # Update progress to inference phase (this is where most time is spent)
        update_generation_progress("inference", 15, 0, total_steps)
        
        try:
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
        finally:
            # Clear API embeddings after generation
            _api_embeddings = None
        
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
                "sage_attention": USE_SAGE_ATTENTION,
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
                "ltxApiKey": app_settings.get("ltx_api_key", ""),
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
                
                # Resolution mapping for DistilledPipeline (2-stage with 2x upsampling)
                # We pass HALF the target resolution since the pipeline upsamples 2x
                # Dimensions must be divisible by 32
                resolution_map = {
                    "1080p": (960, 544),    # Stage1: 960x544 → Stage2: 1920x1088
                    "720p": (640, 384),     # Stage1: 640x384 → Stage2: 1280x768 (~720p)
                    "480p": (384, 256),     # Stage1: 384x256 → Stage2: 768x512
                }
                width, height = resolution_map.get(resolution, (640, 384))
                
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
        elif self.path == "/api/generate-image":
            try:
                # Check if already generating
                if current_generation["status"] == "running":
                    self.send_json_response(409, {"error": "Generation already in progress"})
                    return
                
                # Parse JSON body
                content_len = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_len).decode('utf-8')
                data = json.loads(body)
                
                prompt = data.get('prompt', 'A beautiful image')
                width = int(data.get('width', 1024))
                height = int(data.get('height', 1024))
                num_steps = int(data.get('numSteps', 4))
                
                # Ensure dimensions are divisible by 16 for Flux
                width = (width // 16) * 16
                height = (height // 16) * 16
                
                # Reset generation state
                generation_id = uuid.uuid4().hex[:8]
                with generation_lock:
                    current_generation["id"] = generation_id
                    current_generation["cancelled"] = False
                    current_generation["result"] = None
                    current_generation["error"] = None
                    current_generation["status"] = "running"
                
                # Generate the image
                seed = int(time.time()) % 2147483647
                output_path = generate_image(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=num_steps,
                    seed=seed,
                    generation_id=generation_id,
                )
                
                with generation_lock:
                    current_generation["status"] = "complete"
                    current_generation["result"] = output_path
                
                self.send_json_response(200, {"status": "complete", "image_path": output_path})
                
            except Exception as e:
                with generation_lock:
                    if current_generation["cancelled"]:
                        current_generation["status"] = "cancelled"
                    else:
                        current_generation["status"] = "error"
                        current_generation["error"] = str(e)
                
                if "cancelled" in str(e).lower():
                    logger.info("Image generation cancelled by user")
                    self.send_json_response(200, {"status": "cancelled"})
                else:
                    logger.error(f"Image generation error: {e}")
                    import traceback
                    traceback.print_exc()
                    self.send_json_response(500, {"error": str(e)})
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
                            # Note: Text encoder is now always cached after first load.
                            # This setting is kept for future use (e.g., unload pipeline after generation)
                            # Cache is only cleared when switching between Flux and LTX pipelines.
                    
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
                    
                    if 'ltxApiKey' in data:
                        old_value = app_settings.get("ltx_api_key", "")
                        app_settings["ltx_api_key"] = str(data['ltxApiKey'])
                        if old_value != app_settings["ltx_api_key"]:
                            if app_settings["ltx_api_key"]:
                                logger.info("LTX API key configured - text encoding will use fast API (~1s)")
                            else:
                                logger.info("LTX API key removed - text encoding will use local encoder (~23s)")
                
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
