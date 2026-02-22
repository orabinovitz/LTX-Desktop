"""FastAPI composition root for the LTX backend server."""
import os
import sys
from typing import Any, cast

if os.environ.get("DEBUG") == "1":
    try:
        import debugpy

        if not debugpy.is_client_connected():
            debugpy.listen(("127.0.0.1", 5678))
    except (ImportError, RuntimeError) as exc:
        print(f"Debugpy setup failed: {exc}", file=sys.stderr)

import logging
from pathlib import Path
import threading
import tempfile
from datetime import datetime

# Note: expandable_segments is not supported on all platforms

import torch
from state.app_settings import AppSettings
from runtime_config.prompt_texts import DEFAULT_I2V_SYSTEM_PROMPT, DEFAULT_T2V_SYSTEM_PROMPT

# ============================================================
# Logging Configuration
# ============================================================

import platform
if platform.system() == "Windows":
    _log_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    log_dir = _log_app_data / "LTX-desktop" / "logs"
else:
    log_dir = Path.home() / ".ltx-video-studio" / "logs"

_env_log_file = os.environ.get("LTX_LOG_FILE")
if _env_log_file:
    log_file = Path(_env_log_file)
else:
    _ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_file = log_dir / f"backend_{_ts}_unknown.log"

log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(log_formatter)

handlers: list[logging.Handler] = [console_handler]
try:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(log_formatter)
    handlers.append(file_handler)
except Exception as exc:
    print(f"Primary log file setup failed at {log_file}: {exc}", file=sys.stderr)
    fallback_log_dir = Path(tempfile.gettempdir()) / "ltx-video-studio" / "logs"
    _ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    try:
        fallback_log_dir.mkdir(parents=True, exist_ok=True)
        log_file = fallback_log_dir / f"backend_{_ts}_unknown.log"
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(log_formatter)
        handlers.append(file_handler)
    except Exception as fallback_exc:
        print(f"Fallback log file setup failed at {fallback_log_dir}: {fallback_exc}", file=sys.stderr)

logging.basicConfig(level=logging.INFO, handlers=handlers)
logger = logging.getLogger(__name__)
logger.info(f"Log file: {log_file}")

# ============================================================
# SageAttention Integration
# ============================================================
use_sage_attention = os.environ.get("USE_SAGE_ATTENTION", "1") == "1"
_sageattention_runtime_fallback_logged = False

if use_sage_attention:
    try:
        from sageattention import sageattn  # type: ignore[reportMissingImports]
        import torch.nn.functional as F

        _original_sdpa = F.scaled_dot_product_attention

        def patched_sdpa(
            query: torch.Tensor,
            key: torch.Tensor,
            value: torch.Tensor,
            attn_mask: torch.Tensor | None = None,
            dropout_p: float = 0.0,
            is_causal: bool = False,
            scale: float | None = None,
            **kwargs: Any,
        ) -> torch.Tensor:
            global _sageattention_runtime_fallback_logged
            try:
                if query.dim() == 4 and attn_mask is None and dropout_p == 0.0:
                    return cast(torch.Tensor, sageattn(query, key, value, is_causal=is_causal, tensor_layout="HND"))  # type: ignore[reportUnnecessaryCast]
                else:
                    return _original_sdpa(query, key, value, attn_mask=attn_mask,
                                         dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kwargs)
            except Exception:
                if not _sageattention_runtime_fallback_logged:
                    logger.warning("SageAttention failed during runtime; falling back to default attention", exc_info=True)
                    _sageattention_runtime_fallback_logged = True
                return _original_sdpa(query, key, value, attn_mask=attn_mask,
                                     dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kwargs)

        F.scaled_dot_product_attention = patched_sdpa
        logger.info("SageAttention enabled - attention operations will be faster")
    except ImportError:
        logger.warning("SageAttention not installed - using default attention")
        use_sage_attention = False
    except Exception:
        logger.warning("Failed to enable SageAttention", exc_info=True)
        use_sage_attention = False

# ============================================================
# Constants & Paths
# ============================================================

PORT = 8000


def _get_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = _get_device()
DTYPE = torch.bfloat16

def _resolve_app_data_dir() -> Path:
    env_path = os.environ.get("LTX_APP_DATA_DIR")
    if env_path:
        candidate = Path(env_path)
    elif platform.system() == "Windows":
        _app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        candidate = _app_data / "LTX-desktop"
    else:
        candidate = Path.home() / ".ltx-video-studio"

    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except Exception:
        logger.warning("Could not create app data directory at %s, using temp dir fallback", candidate, exc_info=True)
        fallback = Path(tempfile.gettempdir()) / "ltx-video-studio"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


APP_DATA_DIR = _resolve_app_data_dir()

MODELS_DIR = APP_DATA_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

PROJECT_ROOT = Path(__file__).parent.parent
OUTPUTS_DIR = Path(__file__).parent / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

logger.info(f"Models directory: {MODELS_DIR}")

IC_LORA_DIR = MODELS_DIR / "ic-loras"

# ============================================================
# Settings
# ============================================================

SETTINGS_DIR = APP_DATA_DIR
SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULT_APP_SETTINGS = AppSettings(
    t2v_system_prompt=DEFAULT_T2V_SYSTEM_PROMPT,
    i2v_system_prompt=DEFAULT_I2V_SYSTEM_PROMPT,
)

from app_factory import DEFAULT_ALLOWED_ORIGINS, create_app
from state import RuntimeConfig, build_initial_state
from runtime_config.model_download_specs import DEFAULT_MODEL_DOWNLOAD_SPECS, DEFAULT_REQUIRED_MODEL_TYPES
from server_utils.model_layout_migration import migrate_legacy_models_layout

migrate_legacy_models_layout(APP_DATA_DIR)
IC_LORA_DIR.mkdir(parents=True, exist_ok=True)

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

runtime_config = RuntimeConfig(
    device=DEVICE,
    models_dir=MODELS_DIR,
    model_download_specs=DEFAULT_MODEL_DOWNLOAD_SPECS,
    required_model_types=DEFAULT_REQUIRED_MODEL_TYPES,
    outputs_dir=OUTPUTS_DIR,
    ic_lora_dir=IC_LORA_DIR,
    settings_file=SETTINGS_FILE,
    ltx_api_base_url=LTX_API_BASE_URL,
    use_sage_attention=use_sage_attention,
    camera_motion_prompts=CAMERA_MOTION_PROMPTS,
    default_negative_prompt=DEFAULT_NEGATIVE_PROMPT,
)

handler = build_initial_state(runtime_config, DEFAULT_APP_SETTINGS)
app = create_app(handler=handler, allowed_origins=DEFAULT_ALLOWED_ORIGINS)


def precache_model_files(model_dir: Path) -> int:
    if not model_dir.exists():
        return 0
    total_bytes = 0
    for f in model_dir.rglob("*"):
        if f.is_file() and f.suffix in (".safetensors", ".bin", ".pt", ".pth", ".onnx", ".model"):
            try:
                size = f.stat().st_size
                with open(f, "rb") as fh:
                    while fh.read(8 * 1024 * 1024):
                        pass
                total_bytes += size
            except Exception:
                logger.warning("Failed to precache model file: %s", f, exc_info=True)
    return total_bytes


def background_warmup() -> None:
    handler.health.default_warmup()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("LTX_PORT", PORT))
    logger.info("=" * 60)
    logger.info("LTX-2 Video Generation Server (FastAPI + Uvicorn)")
    logger.info(f"Log file: {log_file}")
    logger.info("=" * 60)

    warmup_thread = threading.Thread(target=background_warmup, daemon=True)
    warmup_thread.start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)
