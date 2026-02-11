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

# ============================================================
# Logging Configuration
# ============================================================
# Log to both console and file for debugging installed app

# Determine log file location
import platform
if platform.system() == "Windows":
    _log_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    LOG_DIR = _log_app_data / "LTX-desktop" / "logs"
else:
    LOG_DIR = Path.home() / ".ltx-video-studio" / "logs"

LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "backend.log"

# Create formatters and handlers
log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

# Console handler
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(log_formatter)

# File handler with rotation (max 5MB, keep 3 backups)
from logging.handlers import RotatingFileHandler
file_handler = RotatingFileHandler(
    LOG_FILE, 
    maxBytes=5*1024*1024,  # 5 MB
    backupCount=3,
    encoding='utf-8'
)
file_handler.setLevel(logging.INFO)
file_handler.setFormatter(log_formatter)

# Configure root logger
logging.basicConfig(level=logging.INFO, handlers=[console_handler, file_handler])
logger = logging.getLogger(__name__)
logger.info(f"Log file: {LOG_FILE}")

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

# Model paths - use persistent user folder so models survive app reinstalls
# Windows: %LOCALAPPDATA%\LTX-desktop\models
# Linux/Mac: ~/.ltx-video-studio/models
import platform
if platform.system() == "Windows":
    _app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    APP_DATA_DIR = _app_data / "LTX-desktop"
else:
    APP_DATA_DIR = Path.home() / ".ltx-video-studio"

MODELS_DIR = APP_DATA_DIR / "models" / "ltx-2"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

FLUX_MODELS_DIR = APP_DATA_DIR / "models" / "FLUX.2-klein-4B"

# Outputs stay in the app folder for easy access
PROJECT_ROOT = Path(__file__).parent.parent  # ltx-video folder
OUTPUTS_DIR = Path(__file__).parent / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

logger.info(f"Models directory: {MODELS_DIR}")
logger.info(f"Flux models directory: {FLUX_MODELS_DIR}")

# LTX-2 Model file paths
CHECKPOINT_PATH = MODELS_DIR / "ltx-2-19b-distilled-fp8.safetensors"
UPSAMPLER_PATH = MODELS_DIR / "ltx-2-spatial-upscaler-x2-1.0.safetensors"
# Gemma root should contain both text_encoder and tokenizer folders
GEMMA_PATH = MODELS_DIR
DISTILLED_LORA_PATH = MODELS_DIR / "ltx-2-19b-distilled-lora-384.safetensors"

# Global pipelines (lazy loaded)
distilled_pipeline = None
distilled_native_pipeline = None  # Fast model at native resolution (no upsampler)
pro_pipeline = None
pro_native_pipeline = None  # Single-stage Pro without upscaler
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

# Model download state
model_download_state = {
    "status": "idle",  # idle, downloading, complete, error
    "current_file": "",
    "current_file_progress": 0,  # 0-100 for current file
    "total_progress": 0,  # 0-100 overall
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "files_completed": 0,
    "total_files": 0,
    "error": None,
    "speed_mbps": 0,
}
model_download_lock = threading.Lock()

# Model file sizes (approximate, in bytes)
MODEL_FILES_INFO = [
    {"name": "ltx-2-19b-distilled-fp8.safetensors", "size": 19_000_000_000, "description": "Main transformer model (FP8)"},
    {"name": "ltx-2-spatial-upscaler-x2-1.0.safetensors", "size": 1_000_000_000, "description": "2x Upscaler"},
    {"name": "ltx-2-19b-distilled-lora-384.safetensors", "size": 400_000_000, "description": "LoRA for Pro model"},
    {"name": "text_encoder", "size": 8_000_000_000, "description": "Gemma text encoder", "is_folder": True},
]

# App settings (persisted to user's AppData - survives app updates)
# Use the same persistent location as models and logs
SETTINGS_DIR = APP_DATA_DIR  # %LOCALAPPDATA%\LTX-desktop on Windows
SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULT_T2V_SYSTEM_PROMPT = """You are a prompt enhancer for a text-to-video model. Your task is to take user input and expand it into a fully realized, visually and acoustically specific scene.

CRITICAL INSTRUCTIONS:
Strictly follow all aspects of the user's input: include every element the user requests, such as style, visual details, motions, actions, camera movement, and audio.

The user's input may be vague. To prevent the video model from generating generic or "default" outputs (e.g., shirtless characters, textureless objects), you MUST invent reasonable, concrete details to fill in the visual gaps:
1. Visual Detail: Add fine-grained visual information about lighting, color palettes, textures, reflections, and atmospheric elements.
2. Subject Appearance: Define gender, clothing, hair, age and expressions if not specified, describe subjects interaction with the environment. Avoid mentioning charachter names unless specified, they are irrelevant and non visual.
3. Multiple Characters: When describing more than one person, introduce each with a clear subject (e.g., "A tall man... beside him, a shorter woman...") to avoid attribute confusion.
4. Object Texture & Environment: Define materials for objects and environments - Is the ground wet asphalt or dry sand? Is the light harsh neon or soft sun? For human skin and faces, keep descriptions natural and avoid "texture" language that could cause exaggerated features.
5. Physics & Movement: Describe exactly *how* things move (heavy trudging vs. light gliding, rigid impact vs. elastic bounce).

Guidelines for Enhancement:
- Audio Layer (Mandatory & Concrete): Abstract descriptions like "music plays" result in silent videos. You must describe the *source* and the *texture* of the sound (e.g., "The hollow drone of wind," "The wet splash of tires," "The metallic clank of machinery"). The audio may come from implied or off-screen sources, weave audio descriptions naturally into the chronological flow of the visual description. Do not add speech or dialogue if not mentioned in the input.
- Camera motion: DO NOT invent camera motion/movement unless requested by the user. Make sure to include camera motion if it is specified in the input.
- Temporal Flow: Suggest how the scene evolves over a few seconds — subtle changes in light, character movements, or environmental shifts.
- Avoid freezes: Throughout the prompt, use continuous motion verbs: "continues", "maintains", "keeps [verb]ing", "still [verb]ing" to sustain action from start to finish. NEVER use "static", "still", "frozen", "paused", "captures", "frames", "in the midst of"—even for camera descriptions—unless explicitly requested.
- Dialogue: Only if the input specifies dialogue, quote the exact lines within the action. Describe each speaker distinctively so it is unambiguous who speaks when. If a language other than English is required, explicitly state the language for the dialogue lines.

Output Format (Strict):
- Produce a single continuous paragraph in natural language.
- Length: Moderate (4-6 sentences). Enough to define physics, appearance and audio fully, but without fluff.
- Do NOT include titles, headings, prefaces, or sections.
- Do NOT include code fences or Markdown—plain prose only."""

DEFAULT_I2V_SYSTEM_PROMPT = """<OBJECTIVE_AND_PERSONA>
You are a Creative Assistant specializing in writing detailed, chronological image-to-video prompts in a clear, factual, filmic style for a movie production company.
</OBJECTIVE_AND_PERSONA>

<CONTEXT>
You will be provided an image that must be adapted into a short video. You may also receive user input describing desired action or camera motion.
The input may be visual-only (no audio information) or a combined visual+audio description; adapt accordingly.
Your task is to write a single, self-contained 'video prompt': a dense, chronological description that precisely states the setting, subjects, actions, gestures, micro-movements, background activity, camera placement and movement, lighting, and other visual details observable in the shot.
Write in clear, literal visual language that mirrors professional shot descriptions.
</CONTEXT>

<INSTRUCTIONS>
1. **Adhere strictly to the user's explicit intent**: include every requested motion/action, camera movement, transition, timing, subject, and on-screen text; do not omit, alter, or contradict any user-specified details.
2. **Mirror the examples in <FEW SHOT EXAMPLES> section**: Match their tone, density, paragraph structure, and chronological progression. Output should *look like the examples*.
3. **Chronological flow**: Describe subjects, actions, and camera moves in real-time order ("Initially…", "A moment later…").
4. **Subjects**: Include observable details—clothing, colors, materials, accessories, posture, gaze, hand/finger positions, micro-expressions—and update them as they change.
5. **Camera work**: Always specify framing, angle, lens feel (wide, compressed), and mention camera behavior when it's not static (pan, tilt, push, sway, etc.). Keep consistent unless the user requests a change. INITIAL DESCRIPTION MUST MATCH THE REFERENCE FIRST IMAGE, OTHERWISE IT WILL CREATE A SCENE CUT!
6. **Environment**: Describe setting in concrete detail—architecture, surfaces, textures, signage, background people/objects, props, lighting cues.
7. **Lighting & color**: Note direction, intensity, quality (soft, harsh, diffused), temperature (warm, cool), shadows, reflections, highlights, and time-of-day cues.
8. **Continuity**: Default to a single continuous shot. Only include transitions/cuts if explicitly requested.
9. **Detail density**: Each output should be richly detailed, specific over general ("matte red vinyl booth with subtle creases" vs. "nice red booth").
10. **Motion defaults**: If no action is specified, describe subtle subject or environmental motion (breathing, blinking, swaying, drifting camera).
11. **Tone**: Neutral, cinematic, literal. No metaphors, no filler, no meta commentary. Only what is observable.
12. **Dynamic action handling**: When the image or request implies motion (running, jumping, waving, driving, wind-blown hair, etc.), treat the image description as the starting state of a continuous shot. Begin describing motion within the first 0.5–1.0 seconds; do not hold the opening pose. Prefer present-progressive verbs and include continuous motion cues (follow-through in limbs, cloth/hair drag, footfalls/contacts, parallax in background, camera tracking).
13. **Anti-freeze bias**: Do not describe the scene or subject as "static/still" when motion is requested unless explicitly specified by the user. If uncertain, bias toward smooth, natural motion consistent with the image and request (light step cadence, breathing, gentle tracking or sway) rather than a freeze-frame.
14. **Sustain motion throughout**: For dynamic shots, explicitly maintain the subject's action for the full duration of the paragraph (e.g., "continues sprinting," "keeps paddling," "maintains a steady wave"), and avoid mid-shot returns to a held pose unless the user requests a stop. MOTION SHOULD BE SPECIFIED AND INTEGRATED CONTINUOUSLY IN THE DESCRIPTION TO MAINTAIN MOVEMENT.
15. **Cyclical cues and cadence**: Include repeating motion beats appropriate to the action (stride cycle, arm swing cadence, pedal stroke, breathing rhythm) and persistent parallax or flow in the environment to reinforce ongoing movement.
16. **End-of-shot default**: If the user does not specify an end action, assume the subject continues the requested motion through the final moment of the shot; avoid concluding with a static tableau.
17  **Problematic user input**: If user input is problematic or unclear (i.e: illegal, NSFW, unclear or gibberish input) and you cannot generate a prompt - YOU MUST RETURN AN EMPTY STRING ("").

<CONSTRAINTS>
- Write the video description in strict chronological order, emphasizing visible motion and camera behavior.
- CRITICAL: Be clear and specific; INITIAL DESCRIPTION MUST MATCH THE IMAGE EXACTLY IN SETTING, SHOT TYPE, AND VISUAL ELEMENTS. Do not invent elements.
- Use full sentences; avoid telegraphic fragments.
- Use temporal connectives when helpful (e.g., "Initially", "then", "as", "at 00:02") only if they aid clarity.
- Include many details but only those you are certain about; avoid guesses.
- Use neutral, literal language; avoid metaphors and superlatives.
- If motion is unclear, choose a natural, smooth motion consistent with the image, or add subtle camera movement.
- When no user request or motion/action intent is provided, still include subtle, appropriate subject or environmental motion.
- For dynamic requests, never freeze on the first frame; start and sustain motion immediately and consistently with the intent.
- Prefer present-progressive phrasing ("is sprinting", "camera tracks") over static state descriptors for motion shots.
- Avoid labeling the shot or subject as "static" unless the user explicitly requests a static camera or stillness.
- Do not revert to a still pose mid-shot for dynamic actions; MAINTAIN CONTINUOUS MOTION AND CAMERA BEHAVIOR unless a stop is explicitly requested.
- Reinforce continuity with cyclical motion descriptors and environmental parallax/cadence; avoid one-off action verbs that imply a single discrete movement only.
- NEVER respond in a conversation context or ask clarifying questions. Take your best guess on uncertainties.
</CONSTRAINTS>

<OUTPUT_FORMAT>
Output must be a **single paragraph** in English (regardless of input language) written as a cinematic, chronological shot description. Use present-progressive verbs and explicit continuation language to sustain motion when action is requested.
</OUTPUT_FORMAT>

<FEW_SHOT_EXAMPLES>
** Examples of good video prompts **
- A low-angle shot frames the front of a dark SUV, its headlights cutting through a smoky or hazy atmosphere, as it speeds directly towards the viewer. The camera quickly cuts to a closer view of the car's dark, reflective windshield, illuminated by green and blue neon light reflections. The view abruptly shifts to an extreme close-up of a determined woman with shoulder-length blonde hair, her face adorned with red lipstick. She holds a small automatic weapon, aiming it directly forward with intense focus. The perspective then moves to an over-the-shoulder shot, revealing the black SUV rapidly accelerating away through a dimly lit, green-tinted parking garage. The car makes a sharp turn, its body leaning as it navigates the concrete structure, disappearing out of frame.
- A first-person perspective in a dimly lit, ornate, art deco interior. Dark wooden walls are visible, and on the left, multiple white papers with the black bold text "SEIZED" are tacked. Ahead, a large doorway reveals an icy patch on the floor, and above it, an ornate sign reads "FRANK FONTAINE" in white metallic letters. Through the doorway, a large, grotesque humanoid creature, covered in icy, crystalline growths, stands frozen, momentarily stunned. The player's left hand, clad in a blue and black armored glove, holds a futuristic weapon with blue glowing accents, positioned centrally and aiming at the creature. The creature's body appears to have exposed flesh and glowing red eyes, distorted in a pained expression, as it faces the viewer.
- A boy with dark red, messy hair, wearing a red long-sleeved shirt and green shorts, stands in a light-colored room with his eyes closed and hands outstretched, positioned directly in front of a blue doorway. Standing in the doorway, a tall, slender animated girl with light green/blonde hair styled in two pigtails and dark eyebrows, wearing a black crop top and yellow fitted pants, looks down at the boy with an annoyed expression, her hands on her hips. The girl extends her right arm and tosses a yellow glove towards the boy, who catches it in his outstretched hands. The girl then holds a light blue/green cloth, then she tosses the cloth to the boy. The boy's eyes open, and he looks up with a wide-eyed, innocent, and expectant expression, holding both the yellow glove and the light blue/green cloth in his hands.
</FEW_SHOT_EXAMPLES>

<RECAP>
- Output one coherent paragraph that defaults to a single continuous shot (no invented cuts). Describe transitions only if explicitly requested.
- Strictly adhere to the user's intent: INCLUDE ALL USER-SPECIFIED MOTIONS/ACTIONS, CAMERA MOVES, TRANSITIONS, TIMING, SUBJECTS, AND ON-SCREEN TEXT VERBATIM WHEN PROVIDED; do not omit, alter, or contradict these details.
- When "slow motion" or other temporal effects are requested, explicitly state that in the output and keep all described motion consistent with that effect.
- Output one richly detailed paragraph, describing a continuous shot.
- For dynamic prompts, treat the provided image as the opening state and continue motion immediately; do not hold the initial pose.
- If no explicit stop is provided, the subject continues the requested action through the final moment; do not conclude on a static hold.
- This role may offer further collaboration based on performance and output quality.
</RECAP>"""

app_settings = {
    "keep_models_loaded": True,  # Reserved for future use (e.g., unload pipeline after generation)
    "use_torch_compile": False,  # Disabled by default - can cause long compile times
    "load_on_startup": False,  # If True, preload models at startup; if False, load on first generation
    "ltx_api_key": "",  # LTX API key for fast text encoding (~1s vs 23s local)
    "use_local_text_encoder": False,  # If True, use local text encoder; if False, use LTX API (requires key)
    "fast_model": {"steps": 8, "use_upscaler": True},  # Fast model inference settings
    "pro_model": {"steps": 20, "use_upscaler": True},  # Pro model inference settings (20 steps with res_2s scheduler)
    "prompt_cache_size": 100,  # Max number of prompt embeddings to cache (saves ~4s per repeated prompt)
    # Prompt Enhancer settings
    "prompt_enhancer_enabled": True,  # Enable prompt enhancement by default
    "gemini_api_key": "",  # Gemini API key for prompt enhancement
    "t2v_system_prompt": DEFAULT_T2V_SYSTEM_PROMPT,  # T2V system prompt
    "i2v_system_prompt": DEFAULT_I2V_SYSTEM_PROMPT,  # I2V system prompt
    # Seed settings
    "seed_locked": False,  # If True, use locked_seed; if False, random seed each time
    "locked_seed": 42,  # The seed to use when seed_locked is True
}
settings_lock = threading.Lock()


def load_settings():
    """Load settings from disk on startup."""
    global app_settings
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, 'r') as f:
                saved = json.load(f)
            with settings_lock:
                # Only load known keys to avoid issues with old/invalid settings
                if 'keep_models_loaded' in saved:
                    app_settings['keep_models_loaded'] = bool(saved['keep_models_loaded'])
                if 'use_torch_compile' in saved:
                    app_settings['use_torch_compile'] = bool(saved['use_torch_compile'])
                if 'load_on_startup' in saved:
                    app_settings['load_on_startup'] = bool(saved['load_on_startup'])
                if 'ltx_api_key' in saved:
                    app_settings['ltx_api_key'] = str(saved['ltx_api_key'])
                if 'use_local_text_encoder' in saved:
                    app_settings['use_local_text_encoder'] = bool(saved['use_local_text_encoder'])
                if 'fast_model' in saved and isinstance(saved['fast_model'], dict):
                    app_settings['fast_model'] = {
                        'steps': int(saved['fast_model'].get('steps', 8)),
                        'use_upscaler': bool(saved['fast_model'].get('use_upscaler', True))
                    }
                if 'pro_model' in saved and isinstance(saved['pro_model'], dict):
                    app_settings['pro_model'] = {
                        'steps': int(saved['pro_model'].get('steps', 20)),
                        'use_upscaler': bool(saved['pro_model'].get('use_upscaler', True))
                    }
                if 'prompt_cache_size' in saved:
                    app_settings['prompt_cache_size'] = max(0, min(1000, int(saved['prompt_cache_size'])))
                # Prompt Enhancer settings
                if 'prompt_enhancer_enabled' in saved:
                    app_settings['prompt_enhancer_enabled'] = bool(saved['prompt_enhancer_enabled'])
                if 'gemini_api_key' in saved:
                    app_settings['gemini_api_key'] = str(saved['gemini_api_key'])
                if 't2v_system_prompt' in saved:
                    app_settings['t2v_system_prompt'] = str(saved['t2v_system_prompt'])
                if 'i2v_system_prompt' in saved:
                    app_settings['i2v_system_prompt'] = str(saved['i2v_system_prompt'])
                # Seed settings
                if 'seed_locked' in saved:
                    app_settings['seed_locked'] = bool(saved['seed_locked'])
                if 'locked_seed' in saved:
                    app_settings['locked_seed'] = int(saved['locked_seed'])
            logger.info(f"Settings loaded from {SETTINGS_FILE}")
        except Exception as e:
            logger.warning(f"Could not load settings: {e}")


def save_settings():
    """Save current settings to disk."""
    try:
        with settings_lock:
            settings_to_save = app_settings.copy()
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(settings_to_save, f, indent=2)
        logger.debug(f"Settings saved to {SETTINGS_FILE}")
    except Exception as e:
        logger.warning(f"Could not save settings: {e}")


# Load settings on module import
load_settings()

# Text encoder caching (used when not using LTX API)
cached_text_encoder = None
_model_ledger_patched = False

# LTX API endpoint for text encoding
LTX_API_BASE_URL = "https://api.ltx.video"


def patch_model_ledger_class():
    """Patch the ModelLedger class globally to support API embeddings and caching.
    
    This patches the class itself, not instances, so ALL ModelLedger instances
    will use our patched text_encoder method from the moment they're created.
    """
    global _model_ledger_patched, cached_text_encoder
    
    if _model_ledger_patched:
        return
    
    try:
        from ltx_core.model.model_ledger import ModelLedger
        
        # Store the original method from the class
        original_text_encoder = ModelLedger.text_encoder
        
        def patched_text_encoder(self):
            global cached_text_encoder, _api_embeddings
            
            # If we have API embeddings, return dummy - don't load real encoder
            if _api_embeddings is not None:
                logger.info("API embeddings set - returning dummy encoder (skipping load)")
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
            cached_text_encoder = original_text_encoder(self)
            logger.info("Text encoder loaded and cached in CPU RAM")
            return cached_text_encoder
        
        # Patch the class method
        ModelLedger.text_encoder = patched_text_encoder
        _model_ledger_patched = True
        logger.info("ModelLedger.text_encoder patched globally for API embeddings support")
        
        # Also patch cleanup_memory to move cached encoder to CPU
        from ltx_pipelines import utils as ltx_utils
        original_cleanup = ltx_utils.cleanup_memory
        
        def patched_cleanup_memory():
            global cached_text_encoder
            if cached_text_encoder is not None:
                try:
                    cached_text_encoder.to("cpu")
                    logger.debug("Moved cached text encoder to CPU during cleanup")
                except Exception:
                    pass
            original_cleanup()
        
        ltx_utils.cleanup_memory = patched_cleanup_memory
        
    except Exception as e:
        logger.warning(f"Failed to patch ModelLedger class: {e}")


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
    
    Uses an in-memory cache to skip API calls for repeated prompts.
    
    Returns:
        Tuple of (video_context, audio_context) tensors, or None if failed
    """
    global _prompt_embeddings_cache
    
    if not model_id:
        logger.warning("No model_id available for API encoding")
        return None
    
    # Check cache first
    cache_key = prompt.strip()
    if cache_key in _prompt_embeddings_cache:
        logger.info("Using cached prompt embeddings (skipping API call)")
        return _prompt_embeddings_cache[cache_key]
        
    try:
        logger.info("Encoding text via LTX API...")
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
            
            elapsed = time.time() - start
            logger.info(f"Text encoded via API in {elapsed:.1f}s")
            
            # Cache the result (respecting user-configured cache size)
            max_cache_size = app_settings.get("prompt_cache_size", 100)
            if max_cache_size > 0:
                if len(_prompt_embeddings_cache) >= max_cache_size:
                    # Remove oldest entry (first key) to make room
                    oldest_key = next(iter(_prompt_embeddings_cache))
                    del _prompt_embeddings_cache[oldest_key]
                
                _prompt_embeddings_cache[cache_key] = (video_context, audio_context)
                logger.info(f"Cached prompt ({len(_prompt_embeddings_cache)}/{max_cache_size})")
            
            return (video_context, audio_context)
        
        logger.warning("LTX API returned unexpected conditioning format")
        return None
        
    except Exception as e:
        logger.warning(f"LTX API encoding failed: {e}, falling back to local encoder")
        return None


# Cache the model_id after first extraction
_cached_model_id = None

# Prompt embeddings cache (key: prompt text, value: (video_context, audio_context))
# This avoids repeated API calls for the same prompt
_prompt_embeddings_cache = {}

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
                logger.info("Using API embeddings (patched encode_text)")
                # Return in the same format as the original function
                # Original returns list of (video_context, audio_context) tuples
                # For pipelines that pass multiple prompts (positive + negative),
                # we need to return embeddings for each prompt
                # Note: For negative prompt, we use zeros (unconditioned) for proper CFG
                num_prompts = len(prompts) if isinstance(prompts, list) else 1
                results = []
                for i in range(num_prompts):
                    if i == 0:
                        # First prompt is positive - use API embeddings
                        results.append((video_context, audio_context))
                    else:
                        # Subsequent prompts (negative) - use zeros for unconditioned guidance
                        zero_video = torch.zeros_like(video_context)
                        zero_audio = torch.zeros_like(audio_context) if audio_context is not None else None
                        results.append((zero_video, zero_audio))
                return results
            # Otherwise, use the original encoder
            return original_encode_text(text_encoder, prompts, *args, **kwargs)
        
        # Patch in all pipeline module locations
        pipeline_utils.encode_text = patched_encode_text
        distilled_module.encode_text = patched_encode_text
        
        # Also patch ti2vid modules if available
        try:
            from ltx_pipelines import ti2vid_one_stage as one_stage_module
            one_stage_module.encode_text = patched_encode_text
        except ImportError:
            pass
        
        try:
            from ltx_pipelines import ti2vid_two_stages as two_stages_module
            two_stages_module.encode_text = patched_encode_text
        except ImportError:
            pass
        
        _encode_text_patched = True
        logger.info("Patched encode_text for API embeddings injection (all pipeline modules)")
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
        # Rename files to match ltx_core expected pattern
        _rename_text_encoder_files(MODELS_DIR / "text_encoder")
        logger.info("Downloaded text_encoder")
    else:
        logger.info("Found text_encoder")


def get_text_encoder_status():
    """Get the status of the text encoder model.
    
    Returns:
        dict with downloaded, size_bytes, size_gb
    """
    text_encoder_path = GEMMA_PATH / "text_encoder"
    exists = text_encoder_path.exists() and any(text_encoder_path.iterdir()) if text_encoder_path.exists() else False
    size_bytes = sum(f.stat().st_size for f in text_encoder_path.rglob("*") if f.is_file()) if exists else 0
    expected_size = 8_000_000_000  # ~8GB
    
    return {
        "downloaded": exists,
        "size_bytes": size_bytes if exists else expected_size,
        "size_gb": round(size_bytes / (1024**3), 1) if exists else round(expected_size / (1024**3), 1),
        "expected_size_gb": round(expected_size / (1024**3), 1),
    }


def get_models_status(has_api_key: bool = None):
    """Get detailed status of all required models.
    
    Args:
        has_api_key: If True, text encoder is optional (API will be used instead).
                    If None, checks app_settings for ltx_api_key.
    """
    models = []
    total_size = 0
    downloaded_size = 0
    
    # Check if API key is configured (text encoder becomes optional)
    if has_api_key is None:
        has_api_key = bool(app_settings.get("ltx_api_key", ""))
    
    # Check individual model files
    model_files = [
        ("ltx-2-19b-distilled-fp8.safetensors", CHECKPOINT_PATH, 19_000_000_000, "Main transformer model (FP8)"),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", UPSAMPLER_PATH, 1_000_000_000, "2x Upscaler"),
        ("ltx-2-19b-distilled-lora-384.safetensors", DISTILLED_LORA_PATH, 400_000_000, "LoRA for Pro model"),
    ]
    
    for name, path, expected_size, description in model_files:
        exists = path.exists()
        actual_size = path.stat().st_size if exists else 0
        total_size += expected_size
        if exists:
            downloaded_size += actual_size
        models.append({
            "name": name,
            "description": description,
            "downloaded": exists,
            "size": actual_size if exists else expected_size,
            "expected_size": expected_size,
            "required": True,  # Core models are always required
        })
    
    # Check text encoder folder
    # Text encoder is OPTIONAL if API key is configured (uses LTX API for text encoding)
    text_encoder_exists = GEMMA_PATH.exists() and any(GEMMA_PATH.iterdir()) if GEMMA_PATH.exists() else False
    text_encoder_size = sum(f.stat().st_size for f in GEMMA_PATH.rglob("*") if f.is_file()) if text_encoder_exists else 0
    expected_te_size = 8_000_000_000
    text_encoder_required = not has_api_key  # Only required if no API key
    
    if text_encoder_required:
        total_size += expected_te_size
        if text_encoder_exists:
            downloaded_size += text_encoder_size
    
    models.append({
        "name": "text_encoder",
        "description": "Gemma text encoder" + (" (optional with API key)" if has_api_key else ""),
        "downloaded": text_encoder_exists,
        "size": text_encoder_size if text_encoder_exists else expected_te_size,
        "expected_size": expected_te_size,
        "is_folder": True,
        "required": text_encoder_required,  # Optional if API key is configured
        "optional_reason": "Uses LTX API for text encoding" if has_api_key else None,
    })
    
    # Check Flux model (for text-to-image)
    flux_exists = FLUX_MODELS_DIR.exists() and any(FLUX_MODELS_DIR.iterdir()) if FLUX_MODELS_DIR.exists() else False
    flux_size = sum(f.stat().st_size for f in FLUX_MODELS_DIR.rglob("*") if f.is_file()) if flux_exists else 0
    expected_flux_size = 15_000_000_000  # ~15GB for Flux Klein 4B
    total_size += expected_flux_size
    if flux_exists:
        downloaded_size += flux_size
    
    models.append({
        "name": "FLUX.2-klein-4B",
        "description": "Flux model for text-to-image",
        "downloaded": flux_exists,
        "size": flux_size if flux_exists else expected_flux_size,
        "expected_size": expected_flux_size,
        "is_folder": True,
        "required": True,
    })
    
    # All REQUIRED models must be downloaded (optional ones don't count)
    all_downloaded = all(m["downloaded"] for m in models if m.get("required", True))
    
    return {
        "models": models,
        "all_downloaded": all_downloaded,
        "total_size": total_size,
        "downloaded_size": downloaded_size,
        "total_size_gb": round(total_size / (1024**3), 1),
        "downloaded_size_gb": round(downloaded_size / (1024**3), 1),
        "models_path": str(MODELS_DIR),
        "has_api_key": has_api_key,
        "text_encoder_status": get_text_encoder_status(),
        "use_local_text_encoder": app_settings.get("use_local_text_encoder", False),
    }


def _rename_text_encoder_files(text_encoder_path: Path):
    """Rename text encoder files to match ltx_core expected pattern.
    
    The Hugging Face repo uses 'diffusion_pytorch_model*.safetensors' naming,
    but ltx_core expects 'model*.safetensors'. This renames files after download.
    """
    if not text_encoder_path.exists():
        return
    
    # Rename safetensors files
    for f in text_encoder_path.glob("diffusion_pytorch_model*.safetensors"):
        new_name = f.name.replace("diffusion_pytorch_model", "model")
        new_path = f.parent / new_name
        if not new_path.exists():
            logger.info(f"Renaming {f.name} -> {new_name}")
            f.rename(new_path)
    
    # Rename and update index file
    index_file = text_encoder_path / "diffusion_pytorch_model.safetensors.index.json"
    new_index_file = text_encoder_path / "model.safetensors.index.json"
    if index_file.exists() and not new_index_file.exists():
        # Read, update references, and write to new file
        import json
        with open(index_file, 'r') as f:
            index_data = json.load(f)
        
        # Update weight_map references
        if "weight_map" in index_data:
            new_weight_map = {}
            for key, value in index_data["weight_map"].items():
                new_value = value.replace("diffusion_pytorch_model", "model")
                new_weight_map[key] = new_value
            index_data["weight_map"] = new_weight_map
        
        with open(new_index_file, 'w') as f:
            json.dump(index_data, f, indent=2)
        
        # Remove old index file
        index_file.unlink()
        logger.info("Updated text encoder index file")


def download_models_with_progress(skip_text_encoder: bool = False):
    """Download models with progress tracking. Runs in a background thread.
    
    Args:
        skip_text_encoder: If True, skip downloading the text encoder (when using LTX API).
    """
    global model_download_state
    
    repo_id = "Lightricks/LTX-2"
    
    models_to_download = [
        ("ltx-2-19b-distilled-fp8.safetensors", CHECKPOINT_PATH, 19_000_000_000),
        ("ltx-2-spatial-upscaler-x2-1.0.safetensors", UPSAMPLER_PATH, 1_000_000_000),
        ("ltx-2-19b-distilled-lora-384.safetensors", DISTILLED_LORA_PATH, 400_000_000),
    ]
    
    # Calculate what needs downloading
    files_to_download = []
    total_bytes = 0
    
    for filename, local_path, expected_size in models_to_download:
        if not local_path.exists():
            files_to_download.append((filename, local_path, expected_size, False, repo_id))
            total_bytes += expected_size
    
    # Check text encoder (skip if using API key)
    if not skip_text_encoder:
        text_encoder_needs_download = not GEMMA_PATH.exists() or not any(GEMMA_PATH.iterdir()) if GEMMA_PATH.exists() else True
        if text_encoder_needs_download:
            files_to_download.append(("text_encoder", GEMMA_PATH, 8_000_000_000, True, "Lightricks/LTX-2"))
            total_bytes += 8_000_000_000
    else:
        logger.info("Skipping text encoder download (using LTX API for text encoding)")
    
    # Check Flux model (for text-to-image)
    flux_needs_download = not FLUX_MODELS_DIR.exists() or not any(FLUX_MODELS_DIR.iterdir()) if FLUX_MODELS_DIR.exists() else True
    if flux_needs_download:
        files_to_download.append(("FLUX.2-klein-4B", FLUX_MODELS_DIR, 15_000_000_000, True, "black-forest-labs/FLUX.2-klein-4B"))
        total_bytes += 15_000_000_000
    
    if not files_to_download:
        with model_download_lock:
            model_download_state["status"] = "complete"
            model_download_state["total_progress"] = 100
        return
    
    with model_download_lock:
        model_download_state["status"] = "downloading"
        model_download_state["total_files"] = len(files_to_download)
        model_download_state["files_completed"] = 0
        model_download_state["total_bytes"] = total_bytes
        model_download_state["downloaded_bytes"] = 0
        model_download_state["error"] = None
    
    downloaded_so_far = 0
    
    try:
        for i, (filename, local_path, expected_size, is_folder, file_repo_id) in enumerate(files_to_download):
            with model_download_lock:
                model_download_state["current_file"] = filename
                model_download_state["current_file_progress"] = 0
            
            logger.info(f"Downloading {filename} ({i+1}/{len(files_to_download)}) from {file_repo_id}...")
            
            if is_folder:
                if filename == "text_encoder":
                    # Download text encoder folder from LTX-2 repo
                    snapshot_download(
                        repo_id=file_repo_id,
                        allow_patterns=["text_encoder/*"],
                        local_dir=MODELS_DIR,
                        local_dir_use_symlinks=False,
                    )
                    # Rename files to match ltx_core expected pattern
                    # (diffusion_pytorch_model*.safetensors -> model*.safetensors)
                    _rename_text_encoder_files(MODELS_DIR / "text_encoder")
                else:
                    # Download full repo (e.g., Flux)
                    snapshot_download(
                        repo_id=file_repo_id,
                        local_dir=str(local_path),
                        local_dir_use_symlinks=False,
                    )
            else:
                # Download individual file
                hf_hub_download(
                    repo_id=file_repo_id,
                    filename=filename,
                    local_dir=MODELS_DIR,
                    local_dir_use_symlinks=False,
                )
            
            downloaded_so_far += expected_size
            
            with model_download_lock:
                model_download_state["files_completed"] = i + 1
                model_download_state["downloaded_bytes"] = downloaded_so_far
                model_download_state["current_file_progress"] = 100
                model_download_state["total_progress"] = int((downloaded_so_far / total_bytes) * 100)
            
            logger.info(f"Downloaded {filename}")
        
        with model_download_lock:
            model_download_state["status"] = "complete"
            model_download_state["total_progress"] = 100
        
        logger.info("All models downloaded successfully!")
        
    except Exception as e:
        logger.error(f"Model download failed: {e}")
        with model_download_lock:
            model_download_state["status"] = "error"
            model_download_state["error"] = str(e)


def start_model_download(skip_text_encoder: bool = False):
    """Start model download in a background thread.
    
    Args:
        skip_text_encoder: If True, skip downloading the text encoder (when using LTX API).
    """
    if model_download_state["status"] == "downloading":
        return False  # Already downloading
    
    thread = threading.Thread(
        target=download_models_with_progress, 
        args=(skip_text_encoder,),
        daemon=True
    )
    thread.start()
    return True


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




class DistilledNativePipeline:
    """Fast Native pipeline - distilled model at native resolution WITHOUT upsampler.
    
    Uses the distilled model's 8-step sigma schedule but generates at full resolution.
    Doesn't load the upsampler to save VRAM.
    """
    
    def __init__(
        self,
        checkpoint_path: str,
        gemma_root: str,
        device=None,
        fp8transformer: bool = False,
    ):
        import torch
        from ltx_core.model.model_ledger import ModelLedger
        from ltx_pipelines.pipeline_utils import PipelineComponents
        from ltx_pipelines import utils
        
        if device is None:
            device = utils.get_device()
        
        self.device = device
        self.dtype = torch.bfloat16
        
        # Initialize ModelLedger WITHOUT upsampler (saves ~2GB VRAM)
        self.model_ledger = ModelLedger(
            dtype=self.dtype,
            device=device,
            checkpoint_path=checkpoint_path,
            gemma_root_path=gemma_root,
            loras=[],
            fp8transformer=fp8transformer,
            # No spatial_upsampler_path!
        )
        
        self.pipeline_components = PipelineComponents(
            dtype=self.dtype,
            device=device,
        )
    
    @torch.inference_mode()
    def __call__(
        self,
        prompt: str,
        output_path: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list,
        tiling_config=None,
    ) -> None:
        from ltx_pipelines import utils
        from ltx_pipelines.pipeline_utils import (
            denoise_audio_video,
            encode_text,
            euler_denoising_loop,
            simple_denoising_func,
        )
        from ltx_pipelines.pipeline_utils import decode_audio as vae_decode_audio
        from ltx_pipelines.pipeline_utils import decode_video as vae_decode_video
        from ltx_pipelines.constants import DISTILLED_SIGMA_VALUES, AUDIO_SAMPLE_RATE
        from ltx_pipelines.media_io import encode_video
        from ltx_core.pipeline.components.diffusion_steps import EulerDiffusionStep
        from ltx_core.pipeline.components.noisers import GaussianNoiser
        from ltx_core.pipeline.components.protocols import DiffusionStepProtocol, VideoPixelShape
        from ltx_core.pipeline.conditioning.item import LatentState
        from ltx_pipelines.utils import image_conditionings_by_replacing_latent
        
        logger.info("Fast Native: 8-step distilled model at native resolution (no upsampler)")
        
        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        stepper = EulerDiffusionStep()
        dtype = torch.bfloat16

        text_encoder = self.model_ledger.text_encoder()
        context_p = encode_text(text_encoder, prompts=[prompt])[0]
        video_context, audio_context = context_p

        torch.cuda.synchronize()
        del text_encoder
        utils.cleanup_memory()

        video_encoder = self.model_ledger.video_encoder()
        transformer = self.model_ledger.transformer()
        sigmas = torch.Tensor(DISTILLED_SIGMA_VALUES).to(self.device)

        def denoising_loop(
            sigmas: torch.Tensor, video_state: LatentState, audio_state: LatentState, stepper: DiffusionStepProtocol
        ) -> tuple:
            return euler_denoising_loop(
                sigmas=sigmas,
                video_state=video_state,
                audio_state=audio_state,
                stepper=stepper,
                denoise_fn=simple_denoising_func(
                    video_context=video_context,
                    audio_context=audio_context,
                    transformer=transformer,
                ),
            )

        output_shape = VideoPixelShape(batch=1, frames=num_frames, width=width, height=height, fps=frame_rate)
        conditionings = image_conditionings_by_replacing_latent(
            images=images,
            height=output_shape.height,
            width=output_shape.width,
            video_encoder=video_encoder,
            dtype=dtype,
            device=self.device,
        )

        video_state, audio_state = denoise_audio_video(
            output_shape=output_shape,
            conditionings=conditionings,
            noiser=noiser,
            sigmas=sigmas,
            stepper=stepper,
            denoising_loop_fn=denoising_loop,
            components=self.pipeline_components,
            dtype=dtype,
            device=self.device,
        )

        torch.cuda.synchronize()
        del transformer
        del video_encoder
        utils.cleanup_memory()

        decoded_video = vae_decode_video(video_state, self.model_ledger.video_decoder(), tiling_config)
        decoded_audio = vae_decode_audio(audio_state, self.model_ledger.audio_decoder(), self.model_ledger.vocoder())

        encode_video(
            video=decoded_video,
            fps=frame_rate,
            audio=decoded_audio,
            audio_sample_rate=AUDIO_SAMPLE_RATE,
            output_path=output_path,
        )


def load_pipeline(model_type: str = "fast"):
    """Load the appropriate LTX-2 pipeline based on model type."""
    global distilled_pipeline, distilled_native_pipeline, pro_pipeline, pro_native_pipeline
    
    # Check if required model files exist before attempting to load
    if not CHECKPOINT_PATH.exists():
        logger.warning(f"Model checkpoint not found at {CHECKPOINT_PATH}. Models need to be downloaded first.")
        return None
    
    # For pipelines that require upsampler, check if it exists
    if model_type in ("fast", "pro") and not UPSAMPLER_PATH.exists():
        logger.warning(f"Upsampler not found at {UPSAMPLER_PATH}. Models need to be downloaded first.")
        return None
    
    # IMPORTANT: Patch these BEFORE importing any pipeline modules
    # This ensures the patched functions are used when modules are imported
    patch_encode_text_for_api()
    patch_model_ledger_class()
    
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
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(distilled_pipeline, "fast")
            
            logger.info(f"Distilled Pipeline loaded in {time.time() - start:.1f}s")
            return distilled_pipeline
        
        elif model_type == "fast-native" and distilled_native_pipeline is None:
            logger.info("Loading LTX-2 Fast Native Pipeline (8-step distilled, no upsampler)...")
            start = time.time()
            
            # Fast Native: distilled model at native resolution WITHOUT loading upsampler
            distilled_native_pipeline = DistilledNativePipeline(
                checkpoint_path=str(CHECKPOINT_PATH),
                gemma_root=str(GEMMA_PATH),
                device=DEVICE,
                fp8transformer=True,
            )
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(distilled_native_pipeline, "fast-native")
            
            logger.info(f"Fast Native Pipeline loaded in {time.time() - start:.1f}s")
            return distilled_native_pipeline
            
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
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(pro_pipeline, "pro")
            
            logger.info(f"Pro Pipeline loaded in {time.time() - start:.1f}s")
            return pro_pipeline
        
        elif model_type == "pro-native" and pro_native_pipeline is None:
            from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline
            
            logger.info("Loading LTX-2 One-Stage Pipeline (Pro Native, no upscaler)...")
            start = time.time()
            
            # Single-stage pipeline: generates at full resolution without upscaler
            pro_native_pipeline = TI2VidOneStagePipeline(
                checkpoint_path=str(CHECKPOINT_PATH),
                gemma_root=str(GEMMA_PATH),
                loras=[],
                device=DEVICE,
                fp8transformer=True,
            )
            
            # Compile the transformer for faster inference
            compile_pipeline_transformer(pro_native_pipeline, "pro-native")
            
            logger.info(f"Pro Native Pipeline loaded in {time.time() - start:.1f}s")
            return pro_native_pipeline
        
        if model_type == "fast":
            return distilled_pipeline
        elif model_type == "fast-native":
            return distilled_native_pipeline
        elif model_type == "pro":
            return pro_pipeline
        elif model_type == "pro-native":
            return pro_native_pipeline
        return None
        
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


def unload_pipeline(model_type: str):
    """Unload a pipeline to free VRAM."""
    global distilled_pipeline, distilled_native_pipeline, pro_pipeline, pro_native_pipeline, flux_pipeline
    
    if model_type == "fast" and distilled_pipeline is not None:
        logger.info("Unloading Fast pipeline to free VRAM...")
        del distilled_pipeline
        distilled_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Fast pipeline unloaded")
    elif model_type == "fast-native" and distilled_native_pipeline is not None:
        logger.info("Unloading Fast Native pipeline to free VRAM...")
        del distilled_native_pipeline
        distilled_native_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Fast Native pipeline unloaded")
    elif model_type == "pro" and pro_pipeline is not None:
        logger.info("Unloading Pro pipeline to free VRAM...")
        del pro_pipeline
        pro_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Pro pipeline unloaded")
    elif model_type == "pro-native" and pro_native_pipeline is not None:
        logger.info("Unloading Pro Native pipeline to free VRAM...")
        del pro_native_pipeline
        pro_native_pipeline = None
        torch.cuda.empty_cache()
        gc.collect()
        logger.info("Pro Native pipeline unloaded")
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
    num_images: int = 1,
) -> list:
    """Generate one or more images using the Flux pipeline."""
    global current_generation
    
    # Check if already cancelled before starting
    if current_generation["cancelled"]:
        raise RuntimeError("Generation was cancelled")
    
    update_generation_progress("loading_model", 5, 0, num_inference_steps)
    
    pipeline = get_flux_pipeline()
    if pipeline is None:
        raise RuntimeError("Failed to load Flux pipeline")
    
    update_generation_progress("inference", 15, 0, num_inference_steps)
    
    output_paths = []
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    try:
        logger.info(f"Generating {num_images} image(s): {width}x{height}, seed={seed}")
        logger.info(f"Prompt: {prompt[:100]}...")
        
        start = time.time()
        
        # Set seed for reproducibility
        # Use "cuda" device for generator when using CPU offload
        if seed is None:
            seed = int(time.time()) % 2147483647
        
        # Generate images one by one (Flux Klein works best this way)
        for i in range(num_images):
            # Check if cancelled
            if current_generation["cancelled"]:
                raise RuntimeError("Generation was cancelled")
            
            # Use different seed for each variation
            current_seed = seed + i
            generator = torch.Generator(device="cuda").manual_seed(current_seed)
            
            # Update progress - distribute across variations
            progress = 15 + int((i / num_images) * 80)
            update_generation_progress("inference", progress, i, num_images)
            
            # Generate the image using Flux2KleinPipeline
            result = pipeline(
                prompt=prompt,
                height=height,
                width=width,
                guidance_scale=1.0,
                num_inference_steps=num_inference_steps,
                generator=generator,
            )
            
            # Save the image
            output_filename = f"flux_image_{timestamp}_{uuid.uuid4().hex[:8]}.png"
            output_path = OUTPUTS_DIR / output_filename
            image = result.images[0]
            image.save(str(output_path))
            output_paths.append(str(output_path))
            
            logger.info(f"Generated image {i+1}/{num_images}: {output_path}")
        
        # Check if cancelled after generation
        if current_generation["cancelled"]:
            raise RuntimeError("Generation was cancelled")
        
        update_generation_progress("complete", 100, num_images, num_images)
        
        logger.info(f"Image generation took {time.time() - start:.1f}s")
        logger.info(f"Generated {len(output_paths)} image(s)")
        return output_paths
        
    except Exception as e:
        logger.error(f"Image generation failed: {e}")
        raise


def get_pipeline(model_type: str = "fast", skip_warmup: bool = False):
    """Get or load the appropriate pipeline.
    
    Only one model is loaded at a time to conserve VRAM.
    Switching models will unload the previous one.
    
    Args:
        model_type: "fast", "fast-native", "pro", or "pro-native"
        skip_warmup: If True, skip warmup (user's generation serves as warmup)
    """
    global distilled_pipeline, distilled_native_pipeline, pro_pipeline, pro_native_pipeline, flux_pipeline
    
    # Always unload Flux pipeline first to free VRAM for video generation
    if flux_pipeline is not None:
        logger.info("Unloading Flux pipeline to free VRAM for video generation...")
        unload_pipeline("flux")
        torch.cuda.empty_cache()
        gc.collect()
    
    # Unload other video pipelines to free VRAM (only one at a time)
    def unload_others(keep: str):
        if keep != "fast" and distilled_pipeline is not None:
            unload_pipeline("fast")
        if keep != "fast-native" and distilled_native_pipeline is not None:
            unload_pipeline("fast-native")
        if keep != "pro" and pro_pipeline is not None:
            unload_pipeline("pro")
        if keep != "pro-native" and pro_native_pipeline is not None:
            unload_pipeline("pro-native")
    
    if model_type == "fast":
        if distilled_pipeline is None:
            unload_others("fast")
            load_pipeline("fast")
            if not skip_warmup:
                warmup_pipeline("fast")
        return distilled_pipeline
    elif model_type == "fast-native":
        if distilled_native_pipeline is None:
            unload_others("fast-native")
            load_pipeline("fast-native")
            # Skip warmup for fast-native - first gen serves as warmup
        return distilled_native_pipeline
    elif model_type == "pro":
        if pro_pipeline is None:
            unload_others("pro")
            load_pipeline("pro")
            if not skip_warmup:
                warmup_pipeline("pro")
        return pro_pipeline
    elif model_type == "pro-native":
        if pro_native_pipeline is None:
            unload_others("pro-native")
            load_pipeline("pro-native")
            # Skip warmup for pro-native - first gen serves as warmup
        return pro_native_pipeline
    
    return None


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
    
    # Check text encoding configuration
    with settings_lock:
        ltx_api_key = app_settings.get("ltx_api_key", "")
        use_local = app_settings.get("use_local_text_encoder", False)
    
    if not use_local and not ltx_api_key:
        # User needs either an API key or local encoder enabled
        raise RuntimeError(
            "TEXT_ENCODING_NOT_CONFIGURED: "
            "To generate videos, you need to configure text encoding. "
            "Either enter an LTX API Key in Settings, or enable the Local Text Encoder."
        )
    
    if use_local:
        # Check if local text encoder is downloaded
        text_encoder_path = GEMMA_PATH / "text_encoder"
        if not text_encoder_path.exists() or not any(text_encoder_path.iterdir()):
            raise RuntimeError(
                "TEXT_ENCODER_NOT_DOWNLOADED: "
                "Local text encoder is enabled but not downloaded. "
                "Please download it from Settings (~8 GB), or switch to using the LTX API."
            )
    
    # Determine total steps for this model based on user settings
    with settings_lock:
        fast_model_settings = app_settings.get("fast_model", {"steps": 8})
        pro_model_settings = app_settings.get("pro_model", {"steps": 20})
    
    if model_type in ("fast", "fast-native"):
        total_steps = 8  # Distilled model always uses 8 steps
    else:  # pro or pro-native both use pro settings
        total_steps = pro_model_settings.get("steps", 20)
    update_generation_progress("loading_model", 5, 0, total_steps)
    
    # Check if models are downloaded before attempting to load
    if not CHECKPOINT_PATH.exists():
        raise RuntimeError("Models not downloaded. Please download the AI models first using the Model Status menu.")
    
    # Skip warmup - the user's generation itself serves as the warmup
    pipeline = get_pipeline(model_type, skip_warmup=True)
    if pipeline is None:
        raise RuntimeError(f"Failed to load {model_type} pipeline. Check the console for detailed error messages.")
    
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
            use_local = app_settings.get("use_local_text_encoder", False)
        
        # Only use API if not using local encoder
        if ltx_api_key and not use_local:
            # Get or cache the model_id from checkpoint
            if _cached_model_id is None:
                _cached_model_id = get_model_id_from_checkpoint(str(CHECKPOINT_PATH))
            
            if _cached_model_id:
                # Use LTX API for text encoding (~1s vs 23s local)
                embeddings = encode_text_via_api(enhanced_prompt, ltx_api_key, _cached_model_id)
                if embeddings is not None:
                    # Store embeddings globally - the patched encode_text will use them
                    _api_embeddings = embeddings
                else:
                    logger.info("Falling back to local text encoder")
            else:
                logger.warning("Could not extract model_id, using local encoder")
        
        # Update progress to inference phase (this is where most time is spent)
        update_generation_progress("inference", 15, 0, total_steps)
        
        # Get inference settings
        with settings_lock:
            fast_settings = app_settings.get("fast_model", {"steps": 8, "use_upscaler": True})
            pro_settings = app_settings.get("pro_model", {"steps": 20, "use_upscaler": True})
        
        try:
            if model_type == "fast":
                # Distilled pipeline - fixed 8 steps (built into distilled model)
                # Note: DistilledPipeline doesn't accept num_inference_steps and always requires upscaler
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
            elif model_type == "fast-native":
                # Fast Native pipeline - 8-step distilled at native resolution (no upsampler loaded)
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
            elif model_type == "pro":
                # Pro pipeline - uses configured steps and upscaler setting
                pro_steps = pro_settings.get("steps", 20)
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
                    num_inference_steps=pro_steps,
                    cfg_guidance_scale=3.0,
                    images=images,
                    tiling_config=tiling_config,
                )
            elif model_type == "pro-native":
                # Pro Native pipeline (configured steps, no upscaler)
                # Note: TI2VidOneStagePipeline doesn't support tiling_config
                pro_steps = pro_settings.get("steps", 20)
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
                    num_inference_steps=pro_steps,
                    cfg_guidance_scale=3.0,
                    images=images,
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
        
        # Update progress to complete (total_steps already computed at start)
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
            elif pro_native_pipeline is not None:
                active_model = "pro-native"
            
            self.send_json_response(200, {
                "status": "ok",
                "models_loaded": distilled_pipeline is not None or pro_pipeline is not None or pro_native_pipeline is not None,
                "active_model": active_model,
                "fast_loaded": distilled_pipeline is not None,
                "pro_loaded": pro_pipeline is not None,
                "pro_native_loaded": pro_native_pipeline is not None,
                "gpu_info": get_gpu_info(),
                "sage_attention": USE_SAGE_ATTENTION,
                "models_status": [
                    {"id": "fast", "name": "LTX-2 Fast (Distilled)", "loaded": distilled_pipeline is not None, "downloaded": CHECKPOINT_PATH.exists()},
                    {"id": "pro", "name": "LTX-2 Pro (Two-Stage)", "loaded": pro_pipeline is not None, "downloaded": CHECKPOINT_PATH.exists()},
                    {"id": "pro-native", "name": "LTX-2 Pro Native (One-Stage)", "loaded": pro_native_pipeline is not None, "downloaded": CHECKPOINT_PATH.exists()}
                ]
            })
        elif self.path == "/api/models":
            # Get current settings for step counts
            with settings_lock:
                fast_steps = app_settings.get("fast_model", {}).get("steps", 8)
                pro_steps = app_settings.get("pro_model", {}).get("steps", 20)
                pro_upscaler = app_settings.get("pro_model", {}).get("use_upscaler", True)
            
            self.send_json_response(200, [
                {"id": "fast", "name": "Fast (Distilled)", "description": f"{fast_steps} steps + 2x upscaler"},
                {"id": "pro", "name": "Pro (Full)", "description": f"{pro_steps} steps" + (" + 2x upscaler" if pro_upscaler else " (native resolution)")}
            ])
        elif self.path == "/api/models/status":
            # Get detailed model download status
            status = get_models_status()
            self.send_json_response(200, status)
        elif self.path == "/api/models/download/progress":
            # Get current download progress
            with model_download_lock:
                self.send_json_response(200, {
                    "status": model_download_state["status"],
                    "currentFile": model_download_state["current_file"],
                    "currentFileProgress": model_download_state["current_file_progress"],
                    "totalProgress": model_download_state["total_progress"],
                    "downloadedBytes": model_download_state["downloaded_bytes"],
                    "totalBytes": model_download_state["total_bytes"],
                    "filesCompleted": model_download_state["files_completed"],
                    "totalFiles": model_download_state["total_files"],
                    "error": model_download_state["error"],
                    "speedMbps": model_download_state["speed_mbps"],
                })
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
        elif self.path == "/api/logs":
            # Return last 200 lines of log file for debugging
            try:
                lines = []
                if LOG_FILE.exists():
                    with open(LOG_FILE, 'r', encoding='utf-8') as f:
                        lines = f.readlines()[-200:]
                self.send_json_response(200, {
                    "logPath": str(LOG_FILE),
                    "lines": [l.rstrip() for l in lines],
                })
            except Exception as e:
                self.send_json_response(500, {"error": str(e)})
        elif self.path == "/api/logs/path":
            # Just return the log file path
            self.send_json_response(200, {
                "logPath": str(LOG_FILE),
                "logDir": str(LOG_DIR),
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
                "useLocalTextEncoder": app_settings.get("use_local_text_encoder", False),
                "fastModel": {
                    "steps": app_settings["fast_model"]["steps"],
                    "useUpscaler": app_settings["fast_model"]["use_upscaler"],
                },
                "proModel": {
                    "steps": app_settings["pro_model"]["steps"],
                    "useUpscaler": app_settings["pro_model"]["use_upscaler"],
                },
                "promptCacheSize": app_settings.get("prompt_cache_size", 100),
                # Prompt Enhancer settings
                "promptEnhancerEnabled": app_settings.get("prompt_enhancer_enabled", True),
                "geminiApiKey": app_settings.get("gemini_api_key", ""),
                "t2vSystemPrompt": app_settings.get("t2v_system_prompt", DEFAULT_T2V_SYSTEM_PROMPT),
                "i2vSystemPrompt": app_settings.get("i2v_system_prompt", DEFAULT_I2V_SYSTEM_PROMPT),
                # Seed settings
                "seedLocked": app_settings.get("seed_locked", False),
                "lockedSeed": app_settings.get("locked_seed", 42),
            })
        elif self.path == "/api/gpu-info":
            # Dedicated GPU info endpoint for first-run checks
            gpu_info = get_gpu_info()
            cuda_available = torch.cuda.is_available()
            gpu_name = None
            vram_gb = None
            
            if cuda_available:
                try:
                    gpu_name = torch.cuda.get_device_name(0)
                    vram_gb = torch.cuda.get_device_properties(0).total_memory // (1024**3)
                except Exception as e:
                    print(f"Error getting detailed GPU info: {e}")
            
            self.send_json_response(200, {
                "cuda_available": cuda_available,
                "gpu_name": gpu_name,
                "vram_gb": vram_gb,
                "gpu_info": gpu_info,
            })
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        global current_generation
        
        if self.path == "/api/models/download":
            # Start model download
            try:
                if model_download_state["status"] == "downloading":
                    self.send_json_response(409, {"error": "Download already in progress"})
                    return
                
                # Check if we should skip text encoder (API key is configured)
                skip_text_encoder = False
                try:
                    content_len = int(self.headers.get('Content-Length', 0))
                    if content_len > 0:
                        body = self.rfile.read(content_len).decode('utf-8')
                        data = json.loads(body)
                        skip_text_encoder = data.get('skipTextEncoder', False)
                        # Also check if API key is provided in this request
                        if data.get('ltxApiKey'):
                            skip_text_encoder = True
                except Exception:
                    pass
                
                # Also check current settings for API key
                if app_settings.get("ltx_api_key"):
                    skip_text_encoder = True
                
                if skip_text_encoder:
                    logger.info("LTX API key configured - text encoder download will be skipped")
                
                started = start_model_download(skip_text_encoder=skip_text_encoder)
                if started:
                    self.send_json_response(200, {
                        "status": "started", 
                        "message": "Model download started",
                        "skippingTextEncoder": skip_text_encoder
                    })
                else:
                    self.send_json_response(400, {"error": "Failed to start download"})
            except Exception as e:
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/text-encoder/download":
            # Download just the text encoder
            try:
                if model_download_state["status"] == "downloading":
                    self.send_json_response(409, {"error": "Download already in progress"})
                    return
                
                # Check if already downloaded
                text_encoder_path = GEMMA_PATH / "text_encoder"
                if text_encoder_path.exists() and any(text_encoder_path.iterdir()):
                    self.send_json_response(200, {"status": "already_downloaded", "message": "Text encoder already downloaded"})
                    return
                
                # Start download in background
                def download_text_encoder():
                    global model_download_state
                    try:
                        with model_download_lock:
                            model_download_state["status"] = "downloading"
                            model_download_state["current_file"] = "text_encoder"
                            model_download_state["total_files"] = 1
                            model_download_state["files_completed"] = 0
                            model_download_state["total_bytes"] = 8_000_000_000
                            model_download_state["downloaded_bytes"] = 0
                        
                        logger.info("Downloading text encoder (~8 GB)...")
                        from huggingface_hub import snapshot_download
                        snapshot_download(
                            repo_id="Lightricks/LTX-2",
                            allow_patterns=["text_encoder/*"],
                            local_dir=MODELS_DIR,
                            local_dir_use_symlinks=False,
                        )
                        _rename_text_encoder_files(MODELS_DIR / "text_encoder")
                        
                        with model_download_lock:
                            model_download_state["status"] = "complete"
                            model_download_state["total_progress"] = 100
                            model_download_state["files_completed"] = 1
                        logger.info("Text encoder download complete!")
                    except Exception as e:
                        logger.error(f"Text encoder download failed: {e}")
                        with model_download_lock:
                            model_download_state["status"] = "error"
                            model_download_state["error"] = str(e)
                
                thread = threading.Thread(target=download_text_encoder, daemon=True)
                thread.start()
                self.send_json_response(200, {"status": "started", "message": "Text encoder download started"})
            except Exception as e:
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/enhance-prompt":
            # Enhance prompt using Gemini API
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                
                prompt = data.get("prompt", "").strip()
                mode = data.get("mode", "t2v")  # t2v, i2v, or t2i
                
                if not prompt:
                    self.send_json_response(400, {"error": "Prompt is required"})
                    return
                
                # Skip enhancement for T2I mode
                if mode == "t2i":
                    self.send_json_response(200, {
                        "status": "success",
                        "enhanced_prompt": prompt,
                        "skipped": True,
                        "reason": "Prompt enhancement disabled for image generation"
                    })
                    return
                
                # Check if enhancer is enabled
                if not app_settings.get("prompt_enhancer_enabled", True):
                    # Return original prompt if enhancer is disabled
                    self.send_json_response(200, {
                        "status": "success",
                        "enhanced_prompt": prompt,
                        "skipped": True,
                        "reason": "Prompt enhancer is disabled"
                    })
                    return
                
                # Check for Gemini API key
                gemini_api_key = app_settings.get("gemini_api_key", "")
                if not gemini_api_key:
                    self.send_json_response(400, {
                        "error": "GEMINI_API_KEY_MISSING",
                        "message": "Gemini API key is required for prompt enhancement. Add it in Settings or disable the prompt enhancer."
                    })
                    return
                
                # Select system prompt based on mode
                if mode == "i2v":
                    system_prompt = app_settings.get("i2v_system_prompt", DEFAULT_I2V_SYSTEM_PROMPT)
                else:  # t2v is default
                    system_prompt = app_settings.get("t2v_system_prompt", DEFAULT_T2V_SYSTEM_PROMPT)
                
                logger.info(f"Enhancing prompt ({mode}): {prompt[:50]}...")
                
                # Call Gemini API
                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_api_key}"
                
                gemini_payload = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{"text": prompt}]
                        }
                    ],
                    "systemInstruction": {
                        "parts": [{"text": system_prompt}]
                    },
                    "generationConfig": {
                        "temperature": 0.7,
                        "maxOutputTokens": 1024
                    }
                }
                
                response = requests.post(
                    gemini_url,
                    headers={"Content-Type": "application/json"},
                    json=gemini_payload,
                    timeout=30
                )
                
                if response.status_code != 200:
                    logger.error(f"Gemini API error: {response.status_code} - {response.text}")
                    self.send_json_response(response.status_code, {
                        "error": "GEMINI_API_ERROR",
                        "message": f"Gemini API error: {response.text}"
                    })
                    return
                
                result = response.json()
                
                # Extract enhanced prompt from response
                try:
                    enhanced_prompt = result["candidates"][0]["content"]["parts"][0]["text"]
                    logger.info(f"Prompt enhanced successfully: {enhanced_prompt[:50]}...")
                    self.send_json_response(200, {
                        "status": "success",
                        "enhanced_prompt": enhanced_prompt,
                        "original_prompt": prompt
                    })
                except (KeyError, IndexError) as e:
                    logger.error(f"Failed to parse Gemini response: {e}")
                    self.send_json_response(500, {
                        "error": "GEMINI_PARSE_ERROR",
                        "message": "Failed to parse Gemini API response"
                    })
                    
            except requests.exceptions.Timeout:
                self.send_json_response(504, {"error": "Gemini API request timed out"})
            except Exception as e:
                logger.error(f"Prompt enhancement error: {e}")
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/suggest-gap-prompt":
            # Suggest a prompt for a gap in the timeline based on neighboring clips
            # Accepts: beforeFrame (base64), afterFrame (base64), beforePrompt, afterPrompt, gapDuration, mode
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                
                before_frame = data.get("beforeFrame")  # base64 JPEG or null
                after_frame = data.get("afterFrame")     # base64 JPEG or null
                before_prompt = data.get("beforePrompt", "")
                after_prompt = data.get("afterPrompt", "")
                gap_duration = data.get("gapDuration", 5)
                mode = data.get("mode", "t2v")  # t2v or i2v
                
                if not before_frame and not after_frame and not before_prompt and not after_prompt:
                    self.send_json_response(400, {"error": "At least one neighboring frame or prompt is required"})
                    return
                
                gemini_api_key = app_settings.get("gemini_api_key", "")
                if not gemini_api_key:
                    self.send_json_response(400, {
                        "error": "GEMINI_API_KEY_MISSING",
                        "message": "Gemini API key is required for gap prompt suggestions."
                    })
                    return
                
                logger.info(f"Suggesting gap prompt: before={'frame+' if before_frame else ''}{bool(before_prompt)}, after={'frame+' if after_frame else ''}{bool(after_prompt)}, dur={gap_duration}s, mode={mode}")
                
                # Build the Gemini request with images and text context
                system_text = (
                    "You are a video production assistant. The user is editing a video timeline and has a gap "
                    f"of {gap_duration:.1f} seconds between two shots. Your job is to suggest a detailed prompt "
                    "for generating a video clip to fill this gap, so that it flows naturally between the "
                    "preceding and following shots.\n\n"
                    "Guidelines:\n"
                    "- Describe the scene, action, camera movement, lighting, and mood\n"
                    "- Match the visual style and tone of the surrounding shots\n"
                    "- Create a smooth narrative or visual transition between the two shots\n"
                    "- Keep the prompt concise (2-4 sentences max)\n"
                    "- Write only the prompt text, no explanations or labels\n"
                    "- If only one neighboring shot is available, suggest something that naturally leads into or out of it\n"
                )
                
                # Build multimodal content parts
                user_parts = []
                context_text = "Here is the context from the timeline:\n\n"
                
                if before_frame or before_prompt:
                    context_text += "SHOT BEFORE THE GAP:\n"
                    if before_prompt:
                        context_text += f"  Prompt: {before_prompt}\n"
                    if before_frame:
                        context_text += "  Last frame (see image below):\n"
                
                if after_frame or after_prompt:
                    context_text += "\nSHOT AFTER THE GAP:\n"
                    if after_prompt:
                        context_text += f"  Prompt: {after_prompt}\n"
                    if after_frame:
                        context_text += "  First frame (see image below):\n"
                
                context_text += f"\nGap duration: {gap_duration:.1f} seconds\n"
                context_text += f"Generation mode: {'image-to-video' if mode == 'i2v' else 'text-to-video'}\n"
                context_text += "\nPlease suggest a detailed prompt for generating a video clip to fill this gap."
                
                user_parts.append({"text": context_text})
                
                # Add frame images inline
                if before_frame:
                    user_parts.append({"text": "Last frame of the shot BEFORE the gap:"})
                    user_parts.append({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": before_frame
                        }
                    })
                
                if after_frame:
                    user_parts.append({"text": "First frame of the shot AFTER the gap:"})
                    user_parts.append({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": after_frame
                        }
                    })
                
                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_api_key}"
                
                gemini_payload = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": user_parts
                        }
                    ],
                    "systemInstruction": {
                        "parts": [{"text": system_text}]
                    },
                    "generationConfig": {
                        "temperature": 0.7,
                        "maxOutputTokens": 512
                    }
                }
                
                response = requests.post(
                    gemini_url,
                    headers={"Content-Type": "application/json"},
                    json=gemini_payload,
                    timeout=30
                )
                
                if response.status_code != 200:
                    logger.error(f"Gemini gap suggestion error: {response.status_code} - {response.text}")
                    self.send_json_response(response.status_code, {
                        "error": "GEMINI_API_ERROR",
                        "message": f"Gemini API error: {response.text}"
                    })
                    return
                
                result = response.json()
                
                try:
                    suggested_prompt = result["candidates"][0]["content"]["parts"][0]["text"].strip()
                    logger.info(f"Gap prompt suggested: {suggested_prompt[:80]}...")
                    self.send_json_response(200, {
                        "status": "success",
                        "suggested_prompt": suggested_prompt
                    })
                except (KeyError, IndexError) as e:
                    logger.error(f"Failed to parse Gemini gap suggestion: {e}")
                    self.send_json_response(500, {
                        "error": "GEMINI_PARSE_ERROR",
                        "message": "Failed to parse Gemini response"
                    })
                    
            except requests.exceptions.Timeout:
                self.send_json_response(504, {"error": "Gemini API request timed out"})
            except Exception as e:
                logger.error(f"Gap prompt suggestion error: {e}")
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/suggest-gap-prompt":
            # Use Gemini Flash to suggest a prompt for a gap based on neighboring clips
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                
                gemini_api_key = app_settings.get("gemini_api_key", "")
                if not gemini_api_key:
                    self.send_json_response(400, {
                        "error": "GEMINI_API_KEY_MISSING",
                        "message": "Gemini API key is required for prompt suggestions."
                    })
                    return
                
                gap_duration = data.get("gapDuration", 3)
                mode = data.get("mode", "text-to-video")  # text-to-video, image-to-video, text-to-image
                before_prompt = data.get("beforePrompt", "")
                after_prompt = data.get("afterPrompt", "")
                before_frame = data.get("beforeFrame", "")  # base64 JPEG
                after_frame = data.get("afterFrame", "")    # base64 JPEG
                
                # Build the Gemini request with text + optional images
                parts = []
                
                system_text = (
                    "You are a professional video editor's AI assistant. "
                    "The user has a video timeline with a gap between two shots. "
                    "Based on the surrounding shots (their frames and/or prompts), "
                    "suggest a single concise prompt that would create a smooth, "
                    "contextually appropriate shot to fill the gap. "
                    f"The gap is {gap_duration:.1f} seconds long. "
                    f"The output will be used for {'video' if 'video' in mode else 'image'} generation. "
                    "Return ONLY the prompt text, nothing else — no quotes, no explanation, no preamble."
                )
                
                user_parts = []
                
                context_desc = "Here is the context from the timeline:\n\n"
                
                if before_frame or before_prompt:
                    context_desc += "=== SHOT BEFORE THE GAP ===\n"
                    if before_prompt:
                        context_desc += f"Prompt: {before_prompt}\n"
                    if before_frame:
                        context_desc += "(Last frame attached below)\n"
                    context_desc += "\n"
                
                if after_frame or after_prompt:
                    context_desc += "=== SHOT AFTER THE GAP ===\n"
                    if after_prompt:
                        context_desc += f"Prompt: {after_prompt}\n"
                    if after_frame:
                        context_desc += "(First frame attached below)\n"
                    context_desc += "\n"
                
                if not before_frame and not after_frame and not before_prompt and not after_prompt:
                    self.send_json_response(400, {"error": "No context provided (no frames or prompts)"})
                    return
                
                context_desc += f"\nSuggest a prompt for a {gap_duration:.1f}s {'video' if 'video' in mode else 'image'} shot that would fit naturally between these shots."
                
                user_parts.append({"text": context_desc})
                
                # Add frames as inline images
                if before_frame:
                    user_parts.append({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": before_frame
                        }
                    })
                    user_parts.append({"text": "(Above: last frame of the shot BEFORE the gap)"})
                
                if after_frame:
                    user_parts.append({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": after_frame
                        }
                    })
                    user_parts.append({"text": "(Above: first frame of the shot AFTER the gap)"})
                
                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_api_key}"
                
                gemini_payload = {
                    "contents": [{"role": "user", "parts": user_parts}],
                    "systemInstruction": {"parts": [{"text": system_text}]},
                    "generationConfig": {
                        "temperature": 0.7,
                        "maxOutputTokens": 512
                    }
                }
                
                logger.info(f"Requesting gap prompt suggestion (before: {'frame+' if before_frame else ''}{'prompt' if before_prompt else 'none'}, after: {'frame+' if after_frame else ''}{'prompt' if after_prompt else 'none'})")
                
                response = requests.post(
                    gemini_url,
                    headers={"Content-Type": "application/json"},
                    json=gemini_payload,
                    timeout=30
                )
                
                if response.status_code != 200:
                    logger.error(f"Gemini API error: {response.status_code} - {response.text[:200]}")
                    self.send_json_response(response.status_code, {
                        "error": "GEMINI_API_ERROR",
                        "message": f"Gemini API error: {response.text[:200]}"
                    })
                    return
                
                result = response.json()
                try:
                    suggested_prompt = result["candidates"][0]["content"]["parts"][0]["text"].strip()
                    # Remove surrounding quotes if present
                    if (suggested_prompt.startswith('"') and suggested_prompt.endswith('"')) or \
                       (suggested_prompt.startswith("'") and suggested_prompt.endswith("'")):
                        suggested_prompt = suggested_prompt[1:-1]
                    logger.info(f"Gap prompt suggestion: {suggested_prompt[:80]}...")
                    self.send_json_response(200, {
                        "status": "success",
                        "suggested_prompt": suggested_prompt
                    })
                except (KeyError, IndexError) as e:
                    logger.error(f"Failed to parse Gemini response: {e}")
                    self.send_json_response(500, {"error": "Failed to parse Gemini response"})
                    
            except requests.exceptions.Timeout:
                self.send_json_response(504, {"error": "Gemini API request timed out"})
            except Exception as e:
                logger.error(f"Gap prompt suggestion error: {e}")
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/generate":
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
                
                duration = int(float(get_form_value('duration', '2')))
                fps = int(float(get_form_value('fps', '24')))
                
                # Pipeline selection based on resolution:
                # - 540p and 720p: native pipeline (single pass, no upsampler)
                # - 1080p: 2-stage pipeline (540p first pass + upsampler to 1080p)
                use_upsampler = resolution == "1080p"
                
                if not use_upsampler:
                    # Switch to native pipeline for 540p and 720p
                    if model_type == "fast":
                        model_type = "fast-native"
                        logger.info(f"Resolution {resolution} - using fast-native pipeline (no upsampler)")
                    elif model_type == "pro":
                        model_type = "pro-native"
                        logger.info(f"Resolution {resolution} - using pro-native pipeline (no upsampler)")
                else:
                    logger.info(f"Resolution {resolution} - using 2-stage pipeline with upsampler")
                
                # Resolution mapping - all dimensions must be divisible by 32
                # 540p/720p: direct output at target resolution
                # 1080p: half resolution (upsampler doubles to final)
                resolution_map = {
                    "540p": (960, 544),     # Native 540p output (single pass)
                    "720p": (1280, 704),    # Native 720p output (single pass)
                    "1080p": (960, 544),    # Stage1: 960x544 → Stage2: 1920x1088 (with upsampler)
                }
                width, height = resolution_map.get(resolution, (960, 544))
                
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
                # Use locked seed if enabled, otherwise random
                if app_settings.get("seed_locked", False):
                    seed = app_settings.get("locked_seed", 42)
                    logger.info(f"Using locked seed: {seed}")
                else:
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
                num_images = int(data.get('numImages', 1))
                
                # Clamp num_images to reasonable range
                num_images = max(1, min(12, num_images))
                
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
                
                # Generate the images
                # Use locked seed if enabled, otherwise random
                if app_settings.get("seed_locked", False):
                    seed = app_settings.get("locked_seed", 42)
                    logger.info(f"Using locked seed for image: {seed}")
                else:
                    seed = int(time.time()) % 2147483647
                output_paths = generate_image(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=num_steps,
                    seed=seed,
                    generation_id=generation_id,
                    num_images=num_images,
                )
                
                with generation_lock:
                    current_generation["status"] = "complete"
                    current_generation["result"] = output_paths
                
                # Return array of image paths
                self.send_json_response(200, {"status": "complete", "image_paths": output_paths})
                
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
                    
                    if 'useLocalTextEncoder' in data:
                        old_value = app_settings.get("use_local_text_encoder", False)
                        app_settings["use_local_text_encoder"] = bool(data['useLocalTextEncoder'])
                        if old_value != app_settings["use_local_text_encoder"]:
                            if app_settings["use_local_text_encoder"]:
                                logger.info("Switched to local text encoder")
                            else:
                                logger.info("Switched to LTX API for text encoding")
                    
                    if 'fastModel' in data and isinstance(data['fastModel'], dict):
                        new_settings = {
                            'steps': int(data['fastModel'].get('steps', 8)),
                            'use_upscaler': bool(data['fastModel'].get('useUpscaler', True))
                        }
                        if new_settings != app_settings["fast_model"]:
                            app_settings["fast_model"] = new_settings
                            logger.info(f"Fast model settings updated: {new_settings['steps']} steps, upscaler={'on' if new_settings['use_upscaler'] else 'off'}")
                    
                    if 'proModel' in data and isinstance(data['proModel'], dict):
                        new_settings = {
                            'steps': int(data['proModel'].get('steps', 20)),
                            'use_upscaler': bool(data['proModel'].get('useUpscaler', True))
                        }
                        if new_settings != app_settings["pro_model"]:
                            app_settings["pro_model"] = new_settings
                            logger.info(f"Pro model settings updated: {new_settings['steps']} steps, upscaler={'on' if new_settings['use_upscaler'] else 'off'}")
                    
                    if 'promptCacheSize' in data:
                        new_size = max(0, min(1000, int(data['promptCacheSize'])))
                        if new_size != app_settings.get("prompt_cache_size", 100):
                            app_settings["prompt_cache_size"] = new_size
                            # Trim cache if new size is smaller
                            while len(_prompt_embeddings_cache) > new_size:
                                oldest_key = next(iter(_prompt_embeddings_cache))
                                del _prompt_embeddings_cache[oldest_key]
                            logger.info(f"Prompt cache size set to {new_size}")
                    
                    # Prompt Enhancer settings
                    if 'promptEnhancerEnabled' in data:
                        old_value = app_settings.get("prompt_enhancer_enabled", True)
                        app_settings["prompt_enhancer_enabled"] = bool(data['promptEnhancerEnabled'])
                        if old_value != app_settings["prompt_enhancer_enabled"]:
                            if app_settings["prompt_enhancer_enabled"]:
                                logger.info("Prompt enhancer enabled")
                            else:
                                logger.info("Prompt enhancer disabled")
                    
                    if 'geminiApiKey' in data:
                        old_key = app_settings.get("gemini_api_key", "")
                        app_settings["gemini_api_key"] = str(data['geminiApiKey'])
                        if old_key != app_settings["gemini_api_key"]:
                            if app_settings["gemini_api_key"]:
                                logger.info("Gemini API key configured for prompt enhancement")
                            else:
                                logger.info("Gemini API key removed")
                    
                    if 't2vSystemPrompt' in data:
                        app_settings["t2v_system_prompt"] = str(data['t2vSystemPrompt'])
                        logger.info("T2V system prompt updated")
                    
                    if 'i2vSystemPrompt' in data:
                        app_settings["i2v_system_prompt"] = str(data['i2vSystemPrompt'])
                        logger.info("I2V system prompt updated")
                    
                    # Seed settings
                    if 'seedLocked' in data:
                        old_value = app_settings.get("seed_locked", False)
                        app_settings["seed_locked"] = bool(data['seedLocked'])
                        if old_value != app_settings["seed_locked"]:
                            if app_settings["seed_locked"]:
                                logger.info(f"Seed locked to {app_settings.get('locked_seed', 42)}")
                            else:
                                logger.info("Seed unlocked (random)")
                    
                    if 'lockedSeed' in data:
                        app_settings["locked_seed"] = int(data['lockedSeed'])
                        if app_settings.get("seed_locked", False):
                            logger.info(f"Locked seed updated to {app_settings['locked_seed']}")
                
                # Persist settings to disk
                save_settings()
                
                self.send_json_response(200, {"status": "ok"})
            except Exception as e:
                logger.error(f"Failed to update settings: {e}")
                self.send_json_response(500, {"error": str(e)})
        
        elif self.path == "/api/upscale":
            # Upscale video to 4K using LTX API, then sharpen for quality
            def sharpen_video(input_path, output_path=None):
                """Apply sharpening + mild contrast enhancement to upscaled video using FFmpeg."""
                try:
                    import subprocess
                    import imageio_ffmpeg
                    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
                    
                    if output_path is None:
                        output_path = str(input_path).replace('.mp4', '_sharp.mp4')
                    
                    # unsharp mask: luma_size:luma_strength:chroma_size:chroma_strength
                    # 5:0.8 = moderate sharpening (5x5 kernel, 0.8 strength)
                    # eq=contrast=1.02 = very subtle contrast boost
                    cmd = [
                        ffmpeg_path, '-y', '-i', str(input_path),
                        '-vf', 'unsharp=5:5:0.8:5:5:0.4,eq=contrast=1.02:brightness=0.01',
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
                        '-c:a', 'copy',
                        '-movflags', '+faststart',
                        str(output_path)
                    ]
                    
                    logger.info(f"Sharpening video: {input_path}")
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                    
                    if result.returncode == 0:
                        # Replace the original with the sharpened version
                        import shutil
                        shutil.move(str(output_path), str(input_path))
                        logger.info(f"Sharpened video saved: {input_path}")
                        return True
                    else:
                        logger.warning(f"FFmpeg sharpen failed: {result.stderr[:500]}")
                        # Clean up failed output
                        try:
                            Path(output_path).unlink(missing_ok=True)
                        except:
                            pass
                        return False
                except Exception as e:
                    logger.warning(f"Video sharpening skipped: {e}")
                    return False
            try:
                content_type = self.headers.get('Content-Type')
                ctype, pdict = cgi.parse_header(content_type)
                
                if ctype == 'multipart/form-data':
                    pdict['boundary'] = pdict['boundary'].encode()
                    content_len = int(self.headers.get('Content-Length'))
                    form_data = cgi.parse_multipart(BytesIO(self.rfile.read(content_len)), pdict)
                    
                    video_path = form_data.get('video_path', [None])[0]
                    if isinstance(video_path, bytes):
                        video_path = video_path.decode('utf-8')
                    
                    width = int(form_data.get('width', [3840])[0])
                    height = int(form_data.get('height', [2160])[0])
                else:
                    content_len = int(self.headers.get('Content-Length', 0))
                    body = self.rfile.read(content_len).decode('utf-8')
                    data = json.loads(body)
                    video_path = data.get('video_path')
                    width = data.get('width', 3840)
                    height = data.get('height', 2160)
                
                if not video_path:
                    self.send_json_response(400, {"error": "Missing video_path parameter"})
                    return
                
                video_file = Path(video_path)
                if not video_file.exists():
                    self.send_json_response(400, {"error": f"Video file not found: {video_path}"})
                    return
                
                # Get video dimensions and duration using av
                try:
                    import av
                    with av.open(str(video_file)) as container:
                        stream = container.streams.video[0]
                        original_width = stream.width
                        original_height = stream.height
                        # Use container duration if stream duration is unreliable
                        if container.duration:
                            video_duration = float(container.duration) / 1_000_000  # microseconds to seconds
                        elif stream.duration and stream.time_base:
                            video_duration = float(stream.duration * stream.time_base)
                        else:
                            video_duration = 5.0
                except Exception as e:
                    logger.warning(f"Could not get video info: {e}, using defaults")
                    original_width = 1280
                    original_height = 720
                    video_duration = 5.0
                
                # Calculate target resolution: always 2x the original
                # Model generates at: 960x540 → 1920x1080, 1280x704 → 2560x1408
                target_width = original_width * 2
                target_height = original_height * 2
                
                # Ensure even dimensions (required for video encoding)
                target_width = target_width if target_width % 2 == 0 else target_width + 1
                target_height = target_height if target_height % 2 == 0 else target_height + 1
                
                logger.info(f"Upscaling video: {video_path}")
                logger.info(f"Original: {original_width}x{original_height} -> Target: {target_width}x{target_height}")
                logger.info(f"Video duration: {video_duration}s")
                
                # Call LTX upscale API (production endpoint)
                # Matches the working curl format exactly:
                #   -F 'params={"upscale_only_mode":true,"width":W,"height":H,"mask_end_time":D}'
                #   -F "input_video=@file.mp4"
                upscale_url = "https://cf.res.lightricks.com/v2/api/ltx2-edit/predict-sync"
                
                api_headers = {
                    "x-lightricks-api-key": "Sp6MeaxIkqs8rIUBNcV3OqdjmosPLfbqzqFFm8tN4fQHOXLcDzUTKbDbqqrSnBp2",
                    "x-app-id": "ltxv-api",
                    "x-platform": "backend",
                    "x-client-user-id": f"ltx-desktop-{uuid.uuid4().hex[:8]}",
                    "x-lightricks-org-id": "montage-pro",
                    "x-request-id": f"upscale-{uuid.uuid4().hex}"
                }
                
                params = {
                    "upscale_only_mode": True,
                    "width": target_width,
                    "height": target_height,
                    "mask_end_time": round(video_duration, 3)
                }
                
                params_json = json.dumps(params, separators=(',', ':'))
                logger.info(f"Sending to upscale API with params: {params_json}")
                
                # Build multipart exactly like curl -F does:
                # 'params' as a plain text form field (no filename, no content-type)
                # 'input_video' as a file upload
                response = requests.post(
                    upscale_url, 
                    headers=api_headers, 
                    files={
                        'params': (None, params_json),
                        'input_video': (video_file.name, open(video_file, 'rb'), 'video/mp4')
                    },
                    timeout=300
                )
                
                logger.info(f"Upscale API response status: {response.status_code}")
                logger.info(f"Upscale API response headers: {dict(response.headers)}")
                
                # Log raw response for debugging
                raw_response = response.text[:1000] if response.text else "(empty)"
                logger.info(f"Upscale API raw response: {raw_response}")
                
                if response.status_code == 200:
                    # Check if response is empty
                    if not response.text or not response.text.strip():
                        logger.error("Upscale API returned empty response")
                        self.send_json_response(500, {"error": "Upscale API returned empty response"})
                        return
                    
                    # Try to parse JSON
                    try:
                        result = response.json()
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse upscale response as JSON: {e}")
                        # Maybe it's returning the video directly?
                        content_type = response.headers.get('Content-Type', '')
                        if 'video' in content_type:
                            # Save directly as video
                            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                            unique_id = uuid.uuid4().hex[:8]
                            upscaled_filename = f"upscaled_{timestamp}_{unique_id}.mp4"
                            upscaled_path = OUTPUTS_DIR / upscaled_filename
                            with open(upscaled_path, 'wb') as f:
                                f.write(response.content)
                            logger.info(f"Saved upscaled video directly: {upscaled_path}")
                            sharpen_video(upscaled_path)
                            self.send_json_response(200, {
                                "status": "complete",
                                "upscaled_path": str(upscaled_path),
                                "width": target_width,
                                "height": target_height
                            })
                            return
                        self.send_json_response(500, {"error": f"Invalid response format: {response.text[:200]}"})
                        return
                    
                    # Check if the response contains a video URL
                    if 'output_video' in result or 'video_url' in result or 'result' in result:
                        video_url = result.get('output_video') or result.get('video_url') or result.get('result', {}).get('video_url')
                        
                        if video_url:
                            # Download the upscaled video
                            upscaled_response = requests.get(video_url, timeout=120)
                            if upscaled_response.status_code == 200:
                                # Save to outputs folder
                                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                                output_filename = f"upscaled_{timestamp}_{uuid.uuid4().hex[:8]}.mp4"
                                output_path = str(OUTPUT_DIR / output_filename)
                                
                                with open(output_path, 'wb') as out_f:
                                    out_f.write(upscaled_response.content)
                                
                                logger.info(f"Upscaled video saved to: {output_path}")
                                sharpen_video(output_path)
                                self.send_json_response(200, {
                                    "status": "complete",
                                    "upscaled_path": output_path,
                                    "width": target_width,
                                    "height": target_height
                                })
                            else:
                                self.send_json_response(500, {"error": f"Failed to download upscaled video: {upscaled_response.status_code}"})
                        else:
                            # Maybe the response has the video data directly
                            logger.info(f"Upscale API response keys: {result.keys()}")
                            self.send_json_response(200, {"status": "complete", "result": result})
                    else:
                        logger.info(f"Upscale API response: {result}")
                        self.send_json_response(200, {"status": "complete", "result": result})
                else:
                    error_text = response.text[:500] if response.text else "Unknown error"
                    logger.error(f"Upscale API error: {response.status_code} - {error_text}")
                    self.send_json_response(response.status_code, {"error": f"Upscale API error: {error_text}"})
                    
            except Exception as e:
                logger.error(f"Upscale error: {e}")
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


def background_warmup():
    """Run model loading and warmup in background thread.
    
    If load_on_startup is False (default), just check models and mark ready.
    Models will load on first generation.
    """
    global warmup_state
    
    try:
        with warmup_lock:
            warmup_state["status"] = "loading"
            warmup_state["current_step"] = "Checking models..."
            warmup_state["progress"] = 10
        
        # Check if models exist (don't auto-download - let user use the wizard)
        logger.info("Checking models...")
        models_status = get_models_status()
        models_ready = models_status.get("all_downloaded", False)
        
        if not models_ready:
            logger.warning("Models not downloaded. User needs to download via the app.")
            with warmup_lock:
                warmup_state["status"] = "pending"
                warmup_state["current_step"] = "Models need to be downloaded"
                warmup_state["progress"] = 0
            return
        
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
