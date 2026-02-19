"""
LTX-2 Video Generation Server using the official ltx-pipelines package.
Supports both text-to-video (T2V) and image-to-video (I2V).

This module is a thin facade: all globals, the FastAPI app, and wrapper
functions live here so that tests can import/patch them.  Heavy logic is
delegated to ``_routes/`` (HTTP dispatch) and ``_services/`` (business logic).
"""
import os
import json
import logging
from pathlib import Path
import threading
from typing import Literal, TYPE_CHECKING, overload

if TYPE_CHECKING:
    from _services.pipeline_manager import VideoPipeline
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
    from ltx_pipelines.ti2vid_one_stage import TI2VidOneStagePipeline

ModelType = Literal["fast", "fast-native", "pro", "pro-native"]

# Note: expandable_segments is not supported on all platforms

import torch
import requests  # type: ignore[reportUnusedImport]  # accessed via _mod.requests in _routes/

# ============================================================
# Logging Configuration
# ============================================================

import platform
if platform.system() == "Windows":
    _log_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    LOG_DIR = _log_app_data / "LTX-desktop" / "logs"
else:
    LOG_DIR = Path.home() / ".ltx-video-studio" / "logs"

LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "backend.log"

log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(log_formatter)

from logging.handlers import RotatingFileHandler
file_handler = RotatingFileHandler(
    LOG_FILE,
    maxBytes=5*1024*1024,
    backupCount=3,
    encoding='utf-8'
)
file_handler.setLevel(logging.INFO)
file_handler.setFormatter(log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[console_handler, file_handler])
logger = logging.getLogger(__name__)
logger.info(f"Log file: {LOG_FILE}")

# ============================================================
# SageAttention Integration
# ============================================================
USE_SAGE_ATTENTION = os.environ.get("USE_SAGE_ATTENTION", "1") == "1"

if USE_SAGE_ATTENTION:
    try:
        from sageattention import sageattn
        import torch.nn.functional as F

        _original_sdpa = F.scaled_dot_product_attention

        def patched_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, **kwargs):
            try:
                if query.dim() == 4 and attn_mask is None and dropout_p == 0.0:
                    return sageattn(query, key, value, is_causal=is_causal, tensor_layout="HND")
                else:
                    return _original_sdpa(query, key, value, attn_mask=attn_mask,
                                         dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kwargs)
            except Exception:
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

# ============================================================
# Constants & Paths
# ============================================================

PORT = 8000
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16

if platform.system() == "Windows":
    _app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    APP_DATA_DIR = _app_data / "LTX-desktop"
else:
    APP_DATA_DIR = Path.home() / ".ltx-video-studio"

MODELS_DIR = APP_DATA_DIR / "models" / "ltx-2"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

FLUX_MODELS_DIR = APP_DATA_DIR / "models" / "FLUX.2-klein-4B"

PROJECT_ROOT = Path(__file__).parent.parent
OUTPUTS_DIR = Path(__file__).parent / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

logger.info(f"Models directory: {MODELS_DIR}")
logger.info(f"Flux models directory: {FLUX_MODELS_DIR}")

CHECKPOINT_PATH = MODELS_DIR / "ltx-2-19b-distilled-fp8.safetensors"
UPSAMPLER_PATH = MODELS_DIR / "ltx-2-spatial-upscaler-x2-1.0.safetensors"
GEMMA_PATH = MODELS_DIR
DISTILLED_LORA_PATH = MODELS_DIR / "ltx-2-19b-distilled-lora-384.safetensors"

IC_LORA_DIR = MODELS_DIR / "ic-loras"
IC_LORA_DIR.mkdir(parents=True, exist_ok=True)

MODEL_FILES_INFO = [
    {"name": "ltx-2-19b-distilled-fp8.safetensors", "size": 19_000_000_000, "description": "Main transformer model (FP8)"},
    {"name": "ltx-2-spatial-upscaler-x2-1.0.safetensors", "size": 1_000_000_000, "description": "2x Upscaler"},
    {"name": "ltx-2-19b-distilled-lora-384.safetensors", "size": 400_000_000, "description": "LoRA for Pro model"},
    {"name": "text_encoder", "size": 8_000_000_000, "description": "Gemma text encoder", "is_folder": True},
]

# ============================================================
# Settings
# ============================================================

SETTINGS_DIR = APP_DATA_DIR
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
    "keep_models_loaded": True,
    "use_torch_compile": False,
    "load_on_startup": False,
    "ltx_api_key": "",
    "use_local_text_encoder": False,
    "fast_model": {"steps": 8, "use_upscaler": True},
    "pro_model": {"steps": 20, "use_upscaler": True},
    "prompt_cache_size": 100,
    "prompt_enhancer_enabled_t2v": True,
    "prompt_enhancer_enabled_i2v": False,
    "gemini_api_key": "",
    "t2v_system_prompt": DEFAULT_T2V_SYSTEM_PROMPT,
    "i2v_system_prompt": DEFAULT_I2V_SYSTEM_PROMPT,
    "seed_locked": False,
    "locked_seed": 42,
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
                if 'prompt_enhancer_enabled_t2v' in saved:
                    app_settings['prompt_enhancer_enabled_t2v'] = bool(saved['prompt_enhancer_enabled_t2v'])
                if 'prompt_enhancer_enabled_i2v' in saved:
                    app_settings['prompt_enhancer_enabled_i2v'] = bool(saved['prompt_enhancer_enabled_i2v'])
                if 'prompt_enhancer_enabled' in saved and 'prompt_enhancer_enabled_t2v' not in saved:
                    val = bool(saved['prompt_enhancer_enabled'])
                    app_settings['prompt_enhancer_enabled_t2v'] = val
                    app_settings['prompt_enhancer_enabled_i2v'] = val
                if 'gemini_api_key' in saved:
                    app_settings['gemini_api_key'] = str(saved['gemini_api_key'])
                if 't2v_system_prompt' in saved:
                    app_settings['t2v_system_prompt'] = str(saved['t2v_system_prompt'])
                if 'i2v_system_prompt' in saved:
                    app_settings['i2v_system_prompt'] = str(saved['i2v_system_prompt'])
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


load_settings()

# ============================================================
# Global State
# ============================================================

distilled_pipeline = None
distilled_native_pipeline = None
pro_pipeline = None
pro_native_pipeline = None
flux_pipeline = None
ic_lora_pipeline = None
ic_lora_pipeline_path = None
flux_on_gpu = False

current_generation = {
    "id": None, "cancelled": False, "result": None, "error": None,
    "status": "idle", "phase": "", "progress": 0, "current_step": 0, "total_steps": 0,
}
generation_lock = threading.Lock()

warmup_state = {"status": "pending", "current_step": "", "progress": 0, "error": None}
warmup_lock = threading.Lock()

model_download_state = {
    "status": "idle", "current_file": "", "current_file_progress": 0,
    "total_progress": 0, "downloaded_bytes": 0, "total_bytes": 0,
    "files_completed": 0, "total_files": 0, "error": None, "speed_mbps": 0,
}
model_download_lock = threading.Lock()

cached_text_encoder = None
_model_ledger_patched = False
_encode_text_patched = False
_cached_model_id = None
_prompt_embeddings_cache = {}
_api_embeddings = None
compiled_models = {"fast": False, "pro": False}

LTX_API_BASE_URL = "https://api.ltx.video"

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

DEFAULT_NEGATIVE_PROMPT = """blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of field"""


# ============================================================
# Wrapper functions — thin delegates to _services/
# Tests patch these by name, so they MUST remain module-level.
# ============================================================

def patch_model_ledger_class():
    from _services.text_encoding import patch_model_ledger_class_impl
    patch_model_ledger_class_impl()

def patch_encode_text_for_api():
    from _services.text_encoding import patch_encode_text_for_api_impl
    patch_encode_text_for_api_impl()

def get_model_id_from_checkpoint(checkpoint_path):
    from _services.text_encoding import get_model_id_from_checkpoint_impl
    return get_model_id_from_checkpoint_impl(checkpoint_path)

def encode_text_via_api(prompt, api_key, model_id):
    from _services.text_encoding import encode_text_via_api_impl
    return encode_text_via_api_impl(prompt, api_key, model_id)

def compile_pipeline_transformer(pipeline: "VideoPipeline", model_type: "ModelType") -> None:
    from _services.pipeline_manager import compile_pipeline_transformer as _impl
    return _impl(pipeline, model_type)

@overload
def load_pipeline(model_type: "Literal['fast']" = ...) -> "DistilledPipeline | None": ...
@overload
def load_pipeline(model_type: "Literal['fast-native']") -> "DistilledNativePipeline | None": ...
@overload
def load_pipeline(model_type: "Literal['pro']") -> "TI2VidTwoStagesPipeline | None": ...
@overload
def load_pipeline(model_type: "Literal['pro-native']") -> "TI2VidOneStagePipeline | None": ...

def load_pipeline(model_type: "ModelType" = "fast") -> "VideoPipeline | None":
    from _services.pipeline_manager import load_pipeline_impl
    return load_pipeline_impl(model_type)

def unload_pipeline(model_type: str) -> None:
    from _services.pipeline_manager import unload_pipeline_impl
    unload_pipeline_impl(model_type)

@overload
def get_pipeline(model_type: "Literal['fast']" = ..., skip_warmup: bool = ...) -> "DistilledPipeline | None": ...
@overload
def get_pipeline(model_type: "Literal['fast-native']", skip_warmup: bool = ...) -> "DistilledNativePipeline | None": ...
@overload
def get_pipeline(model_type: "Literal['pro']", skip_warmup: bool = ...) -> "TI2VidTwoStagesPipeline | None": ...
@overload
def get_pipeline(model_type: "Literal['pro-native']", skip_warmup: bool = ...) -> "TI2VidOneStagePipeline | None": ...

def get_pipeline(model_type: "ModelType" = "fast", skip_warmup: bool = False) -> "VideoPipeline | None":
    from _services.pipeline_manager import get_pipeline_impl
    return get_pipeline_impl(model_type, skip_warmup)

def warmup_pipeline(model_type: "ModelType") -> None:
    from _services.pipeline_manager import warmup_pipeline_impl
    warmup_pipeline_impl(model_type)

def load_ic_lora_pipeline(lora_path):
    from _services.pipeline_manager import load_ic_lora_pipeline_impl
    return load_ic_lora_pipeline_impl(lora_path)

def download_models():
    from _services.model_download import download_models_impl
    download_models_impl()

def get_text_encoder_status():
    from _services.model_download import get_text_encoder_status_impl
    return get_text_encoder_status_impl()

def get_models_status(has_api_key=None):
    from _services.model_download import get_models_status_impl
    return get_models_status_impl(has_api_key)

def _rename_text_encoder_files(text_encoder_path):
    from _services.model_download import _rename_text_encoder_files as _impl
    _impl(text_encoder_path)

def download_models_with_progress(skip_text_encoder=False):
    from _services.model_download import download_models_with_progress_impl
    download_models_with_progress_impl(skip_text_encoder)

def start_model_download(skip_text_encoder=False):
    from _services.model_download import start_model_download_impl
    return start_model_download_impl(skip_text_encoder)

def download_flux_model():
    from _services.flux_manager import download_flux_model_impl
    return download_flux_model_impl()

def load_flux_pipeline(to_gpu=True):
    from _services.flux_manager import load_flux_pipeline_impl
    return load_flux_pipeline_impl(to_gpu)

def get_flux_pipeline():
    from _services.flux_manager import get_flux_pipeline_impl
    return get_flux_pipeline_impl()

def update_generation_progress(phase, progress, current_step=0, total_steps=0):
    from _services.video_generation import update_generation_progress_impl
    update_generation_progress_impl(phase, progress, current_step, total_steps)

def generate_video(prompt, image, height, width, num_frames, fps, seed,
                   model_type: "ModelType" = "fast", camera_motion="none",
                   negative_prompt="", generation_id=None):
    from _services.video_generation import generate_video_impl
    return generate_video_impl(prompt, image, height, width, num_frames, fps, seed,
                               model_type, camera_motion, negative_prompt, generation_id)

def generate_image(prompt, width=1024, height=1024, num_inference_steps=4,
                   seed=None, generation_id=None, num_images=1):
    from _services.image_generation import generate_image_impl
    return generate_image_impl(prompt, width, height, num_inference_steps,
                               seed, generation_id, num_images)

def edit_image(prompt, input_images, width=1024, height=1024,
               num_inference_steps=4, seed=None, generation_id=None):
    from _services.image_generation import edit_image_impl
    return edit_image_impl(prompt, input_images, width, height,
                           num_inference_steps, seed, generation_id)

def get_gpu_info():
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        pynvml.nvmlShutdown()
        return {"name": name, "vram": memory.total // (1024 * 1024), "vramUsed": memory.used // (1024 * 1024)}
    except Exception:
        return {"name": "Unknown", "vram": 0, "vramUsed": 0}


# ============================================================
# DummyTextEncoder — referenced by _services/text_encoding.py
# ============================================================

class DummyTextEncoder:
    pass


# ============================================================
# DistilledNativePipeline — kept in-module (complex class)
# ============================================================

class DistilledNativePipeline:
    """Fast Native pipeline - distilled model at native resolution WITHOUT upsampler."""

    def __init__(self, checkpoint_path, gemma_root, device=None, fp8transformer=False):
        from ltx_pipelines.utils import ModelLedger
        from ltx_pipelines.utils.types import PipelineComponents
        from ltx_pipelines.utils.helpers import get_device

        if device is None:
            device = get_device()

        self.device = device
        self.dtype = torch.bfloat16

        from ltx_core.quantization import QuantizationPolicy

        self.model_ledger = ModelLedger(
            dtype=self.dtype, device=device,
            checkpoint_path=checkpoint_path, gemma_root_path=gemma_root,
            loras=None,
            quantization=QuantizationPolicy.fp8_cast() if fp8transformer else None,
        )
        self.pipeline_components = PipelineComponents(dtype=self.dtype, device=device)

    @torch.inference_mode()
    def __call__(self, prompt, seed, height, width, num_frames,
                 frame_rate, images, tiling_config=None):
        from ltx_pipelines.utils.helpers import (
            cleanup_memory, denoise_audio_video, euler_denoising_loop,
            image_conditionings_by_replacing_latent, simple_denoising_func,
        )
        from ltx_core.text_encoders.gemma import encode_text
        from ltx_core.model.audio_vae import decode_audio as vae_decode_audio
        from ltx_core.model.video_vae import decode_video as vae_decode_video
        from ltx_pipelines.utils.constants import DISTILLED_SIGMA_VALUES
        from ltx_core.components.diffusion_steps import EulerDiffusionStep
        from ltx_core.components.noisers import GaussianNoiser
        from ltx_core.types import VideoPixelShape

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
        cleanup_memory()

        video_encoder = self.model_ledger.video_encoder()
        transformer = self.model_ledger.transformer()
        sigmas = torch.Tensor(DISTILLED_SIGMA_VALUES).to(self.device)

        def denoising_loop(sigmas, video_state, audio_state, stepper):
            return euler_denoising_loop(
                sigmas=sigmas, video_state=video_state, audio_state=audio_state,
                stepper=stepper,
                denoise_fn=simple_denoising_func(
                    video_context=video_context, audio_context=audio_context,
                    transformer=transformer,
                ),
            )

        output_shape = VideoPixelShape(batch=1, frames=num_frames, width=width, height=height, fps=frame_rate)
        conditionings = image_conditionings_by_replacing_latent(
            images=images, height=output_shape.height, width=output_shape.width,
            video_encoder=video_encoder, dtype=dtype, device=self.device,
        )

        video_state, audio_state = denoise_audio_video(
            output_shape=output_shape, conditionings=conditionings,
            noiser=noiser, sigmas=sigmas, stepper=stepper,
            denoising_loop_fn=denoising_loop, components=self.pipeline_components,
            dtype=dtype, device=self.device,
        )

        torch.cuda.synchronize()
        del transformer
        del video_encoder
        cleanup_memory()

        decoded_video = vae_decode_video(video_state.latent, self.model_ledger.video_decoder(), tiling_config)
        decoded_audio = vae_decode_audio(audio_state.latent, self.model_ledger.audio_decoder(), self.model_ledger.vocoder())

        return decoded_video, decoded_audio


# ============================================================
# FastAPI application
# ============================================================

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from _routes._errors import HTTPError
from _routes.health import router as health_router
from _routes.generation import router as generation_router
from _routes.models import router as models_router
from _routes.settings import router as settings_router
from _routes.image_gen import router as image_gen_router
from _routes.prompt import router as prompt_router
from _routes.retake import router as retake_router
from _routes.ic_lora import router as ic_lora_router

ALLOWED_ORIGINS: list[str] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app = FastAPI(title="LTX-2 Video Generation Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPError)
async def _route_http_error_handler(_request: Request, exc: HTTPError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
    )


@app.exception_handler(Exception)
async def _route_generic_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.error(f"Unhandled error: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
    )


app.include_router(health_router)
app.include_router(generation_router)
app.include_router(models_router)
app.include_router(settings_router)
app.include_router(image_gen_router)
app.include_router(prompt_router)
app.include_router(retake_router)
app.include_router(ic_lora_router)


# ============================================================
# Startup helpers
# ============================================================

def precache_model_files(model_dir):
    """Read model files into OS file cache so subsequent loads are faster."""
    if not model_dir.exists():
        return
    total_bytes = 0
    for f in model_dir.rglob("*"):
        if f.is_file() and f.suffix in ('.safetensors', '.bin', '.pt', '.pth', '.onnx', '.model'):
            try:
                size = f.stat().st_size
                with open(f, 'rb') as fh:
                    while fh.read(8 * 1024 * 1024):
                        pass
                total_bytes += size
            except Exception:
                pass
    return total_bytes


def background_warmup():
    """Run model loading and warmup in background thread."""
    global warmup_state
    try:
        with warmup_lock:
            warmup_state["status"] = "loading"
            warmup_state["current_step"] = "Checking models..."
            warmup_state["progress"] = 10

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

        if not app_settings.get("load_on_startup", False):
            with warmup_lock:
                warmup_state["status"] = "ready"
                warmup_state["current_step"] = "Ready (models load on first use)"
                warmup_state["progress"] = 100
            logger.info("=" * 60)
            logger.info("Models downloaded and ready!")
            logger.info("Models will load on first generation (lazy loading)")
            logger.info("=" * 60)
            return

        with warmup_lock:
            warmup_state["current_step"] = "Loading video model..."
            warmup_state["progress"] = 20

        logger.info("[1/3] Loading Fast (Distilled) pipeline...")
        if load_pipeline("fast"):
            logger.info("[1/3] Fast pipeline ready!")
        else:
            logger.warning("[1/3] Fast pipeline failed to load")

        with warmup_lock:
            warmup_state["status"] = "warming"
            warmup_state["current_step"] = "Warming up video model..."
            warmup_state["progress"] = 45

        logger.info("[2/3] Warming up Fast pipeline (loading text encoder)...")
        warmup_pipeline("fast")
        logger.info("[2/3] Fast pipeline warmed up!")

        flux_exists = FLUX_MODELS_DIR.exists() and any(FLUX_MODELS_DIR.iterdir()) if FLUX_MODELS_DIR.exists() else False
        if flux_exists:
            with warmup_lock:
                warmup_state["current_step"] = "Loading image model to CPU..."
                warmup_state["progress"] = 60
            logger.info("[3/3] Preloading Flux Klein 4B pipeline to CPU RAM (background)...")
            try:
                load_flux_pipeline(to_gpu=False)
                logger.info("[3/3] Flux Klein 4B preloaded to CPU — will transfer to GPU on first use")
            except Exception as e:
                logger.warning(f"[3/3] Failed to preload Flux to CPU: {e}")
                logger.warning("[3/3] Image model will load from disk on first use instead")
        else:
            logger.info("[3/3] Image model not downloaded — skipping preload")

        with warmup_lock:
            warmup_state["status"] = "ready"
            warmup_state["current_step"] = "Ready!"
            warmup_state["progress"] = 100

        logger.info("=" * 60)
        logger.info("Video model loaded and warmed up on GPU!")
        if flux_exists and flux_pipeline is not None:
            logger.info("Image model preloaded in CPU RAM (fast GPU transfer on first use)")
        logger.info("Pro model will load on first use (to conserve VRAM)")
        logger.info("=" * 60)

    except Exception as e:
        logger.error(f"Background warmup failed: {e}")
        import traceback
        traceback.print_exc()
        with warmup_lock:
            warmup_state["status"] = "error"
            warmup_state["error"] = str(e)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("LTX_PORT", PORT))
    logger.info("=" * 60)
    logger.info("LTX-2 Video Generation Server (FastAPI + Uvicorn)")
    logger.info("=" * 60)

    warmup_thread = threading.Thread(target=background_warmup, daemon=True)
    warmup_thread.start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)
