"""
Test infrastructure for ltx2_server integration tests.

Installs GPU/ML module stubs before importing the server module,
redirects file paths to temp directories, and provides server fixtures.
"""
import sys
import os
import threading
import socketserver
import tempfile
from pathlib import Path
from unittest.mock import MagicMock
from io import BytesIO

import pytest

# ============================================================
# 1. Pre-import stubs — must run before ltx2_server is imported
# ============================================================

os.environ["USE_SAGE_ATTENTION"] = "0"


def _make_torch_stub():
    """Create a torch stub that satisfies import-time usage."""
    torch = MagicMock()
    torch.cuda.is_available.return_value = False
    torch.device.return_value = MagicMock()
    torch.bfloat16 = MagicMock()
    torch.float16 = MagicMock()
    torch.float32 = MagicMock()
    # @torch.inference_mode() must work as a pass-through decorator
    torch.inference_mode.return_value = lambda fn: fn
    return torch


_torch_stub = _make_torch_stub()

_STUB_MODULES = {
    # PyTorch
    "torch": _torch_stub,
    "torch.nn": MagicMock(),
    "torch.nn.functional": MagicMock(),
    # GPU probing
    "pynvml": MagicMock(),
    # HuggingFace
    "huggingface_hub": MagicMock(),
    # SageAttention (skipped via env, stub as safety net)
    "sageattention": MagicMock(),
    # ltx_core tree
    "ltx_core": MagicMock(),
    "ltx_core.model": MagicMock(),
    "ltx_core.model.model_ledger": MagicMock(),
    "ltx_core.tiling": MagicMock(),
    "ltx_core.pipeline": MagicMock(),
    "ltx_core.pipeline.components": MagicMock(),
    "ltx_core.pipeline.components.diffusion_steps": MagicMock(),
    "ltx_core.pipeline.components.noisers": MagicMock(),
    "ltx_core.pipeline.components.protocols": MagicMock(),
    "ltx_core.pipeline.conditioning": MagicMock(),
    "ltx_core.pipeline.conditioning.item": MagicMock(),
    # ltx_pipelines tree
    "ltx_pipelines": MagicMock(),
    "ltx_pipelines.distilled": MagicMock(),
    "ltx_pipelines.pipeline_utils": MagicMock(),
    "ltx_pipelines.ti2vid_two_stages": MagicMock(),
    "ltx_pipelines.ti2vid_one_stage": MagicMock(),
    "ltx_pipelines.ic_lora": MagicMock(),
    "ltx_pipelines.utils": MagicMock(),
    "ltx_pipelines.constants": MagicMock(),
    "ltx_pipelines.media_io": MagicMock(),
    # diffusers
    "diffusers": MagicMock(),
    # media / IO
    "safetensors": MagicMock(),
    "safetensors.torch": MagicMock(),
    "cv2": MagicMock(),
    "imageio_ffmpeg": MagicMock(),
    "av": MagicMock(),
}

for _name, _stub in _STUB_MODULES.items():
    sys.modules.setdefault(_name, _stub)

# Make safetensors.safe_open always raise so the handler falls through
# to the except block and sets conditioning_type = "unknown".
sys.modules["safetensors"].safe_open.side_effect = Exception("stub")

# Now import the server module (stubs are in place)
import ltx2_server  # noqa: E402
from ltx2_server import Handler  # noqa: E402

# Suppress noisy server logging during tests
import logging  # noqa: E402

logging.getLogger("ltx2_server").setLevel(logging.CRITICAL)
logging.getLogger("__main__").setLevel(logging.CRITICAL)


# ============================================================
# 2. Path redirection — session-scoped
# ============================================================

@pytest.fixture(scope="session", autouse=True)
def _redirect_paths():
    """Redirect all module-level paths to a temporary directory."""
    with tempfile.TemporaryDirectory(prefix="ltx_test_") as tmpdir:
        tmp = Path(tmpdir)

        models_dir = tmp / "models" / "ltx-2"
        flux_dir = tmp / "models" / "FLUX.2-klein-4B"
        outputs_dir = tmp / "outputs"
        ic_lora_dir = models_dir / "ic-loras"
        log_dir = tmp / "logs"
        settings_dir = tmp

        for d in [models_dir, flux_dir, outputs_dir, ic_lora_dir, log_dir, settings_dir]:
            d.mkdir(parents=True, exist_ok=True)

        ltx2_server.APP_DATA_DIR = tmp
        ltx2_server.LOG_DIR = log_dir
        ltx2_server.LOG_FILE = log_dir / "backend.log"
        ltx2_server.MODELS_DIR = models_dir
        ltx2_server.FLUX_MODELS_DIR = flux_dir
        ltx2_server.OUTPUTS_DIR = outputs_dir
        ltx2_server.IC_LORA_DIR = ic_lora_dir
        ltx2_server.SETTINGS_DIR = settings_dir
        ltx2_server.SETTINGS_FILE = settings_dir / "settings.json"
        ltx2_server.CHECKPOINT_PATH = models_dir / "ltx-2-19b-distilled-fp8.safetensors"
        ltx2_server.UPSAMPLER_PATH = models_dir / "ltx-2-spatial-upscaler-x2-1.0.safetensors"
        ltx2_server.GEMMA_PATH = models_dir
        ltx2_server.DISTILLED_LORA_PATH = models_dir / "ltx-2-19b-distilled-lora-384.safetensors"

        yield tmp


# ============================================================
# 3. Default settings factory
# ============================================================

def _default_settings():
    return {
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
        "t2v_system_prompt": ltx2_server.DEFAULT_T2V_SYSTEM_PROMPT,
        "i2v_system_prompt": ltx2_server.DEFAULT_I2V_SYSTEM_PROMPT,
        "seed_locked": False,
        "locked_seed": 42,
    }


# ============================================================
# 4. State reset — function-scoped, autouse
# ============================================================

@pytest.fixture(autouse=True)
def _reset_state():
    """Reset all module-level global state between tests."""
    # Clean temp directories so files from one test don't leak to the next
    import shutil

    for d in [ltx2_server.IC_LORA_DIR, ltx2_server.OUTPUTS_DIR]:
        if d.exists():
            shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

    # Remove model placeholder files (but keep the dirs)
    for p in [
        ltx2_server.CHECKPOINT_PATH,
        ltx2_server.UPSAMPLER_PATH,
        ltx2_server.DISTILLED_LORA_PATH,
    ]:
        if p.exists():
            p.unlink()

    # Clean text_encoder dir
    te_dir = ltx2_server.GEMMA_PATH / "text_encoder"
    if te_dir.exists():
        shutil.rmtree(te_dir)

    # Clean Flux dir
    if ltx2_server.FLUX_MODELS_DIR.exists():
        shutil.rmtree(ltx2_server.FLUX_MODELS_DIR)
        ltx2_server.FLUX_MODELS_DIR.mkdir(parents=True, exist_ok=True)

    # Pipeline globals
    ltx2_server.distilled_pipeline = None
    ltx2_server.distilled_native_pipeline = None
    ltx2_server.pro_pipeline = None
    ltx2_server.pro_native_pipeline = None
    ltx2_server.flux_pipeline = None
    ltx2_server.ic_lora_pipeline = None
    ltx2_server.ic_lora_pipeline_path = None

    # Generation state
    ltx2_server.current_generation = {
        "id": None,
        "cancelled": False,
        "result": None,
        "error": None,
        "status": "idle",
        "phase": "",
        "progress": 0,
        "current_step": 0,
        "total_steps": 0,
    }

    # Warmup state
    ltx2_server.warmup_state = {
        "status": "pending",
        "current_step": "",
        "progress": 0,
        "error": None,
    }

    # Download state
    ltx2_server.model_download_state = {
        "status": "idle",
        "current_file": "",
        "current_file_progress": 0,
        "total_progress": 0,
        "downloaded_bytes": 0,
        "total_bytes": 0,
        "files_completed": 0,
        "total_files": 0,
        "error": None,
        "speed_mbps": 0,
    }

    # Settings
    ltx2_server.app_settings = _default_settings()

    # Caches & flags
    ltx2_server._prompt_embeddings_cache = {}
    ltx2_server._api_embeddings = None
    ltx2_server._cached_model_id = None
    ltx2_server.cached_text_encoder = None
    ltx2_server._model_ledger_patched = False
    ltx2_server._encode_text_patched = False
    ltx2_server.compiled_models = {"fast": False, "pro": False}
    ltx2_server.export_sessions = {}

    # Reset torch mock
    _torch_stub.cuda.is_available.return_value = False

    yield


# ============================================================
# 5. Server fixture
# ============================================================

class _ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


@pytest.fixture
def server():
    """Start a real HTTP server on a random port and yield its base URL."""
    httpd = _ReusableTCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    httpd.server_close()


# ============================================================
# 6. Helper fixtures
# ============================================================

@pytest.fixture
def create_fake_model_files():
    """Create small placeholder files at model paths."""
    def _create():
        for p in [
            ltx2_server.CHECKPOINT_PATH,
            ltx2_server.UPSAMPLER_PATH,
            ltx2_server.DISTILLED_LORA_PATH,
        ]:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"\x00" * 1024)

        te_dir = ltx2_server.GEMMA_PATH / "text_encoder"
        te_dir.mkdir(parents=True, exist_ok=True)
        (te_dir / "model.safetensors").write_bytes(b"\x00" * 1024)
    return _create


@pytest.fixture
def create_fake_ic_lora_files():
    """Create fake .safetensors files in IC_LORA_DIR."""
    def _create(names):
        for name in names:
            path = ltx2_server.IC_LORA_DIR / f"{name}.safetensors"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\x00" * 1024)
    return _create


@pytest.fixture
def make_test_image():
    """Create a real PIL Image in a BytesIO buffer for multipart tests."""
    def _make(w=64, h=64, color="red"):
        from PIL import Image
        img = Image.new("RGB", (w, h), color)
        buf = BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return buf
    return _make
