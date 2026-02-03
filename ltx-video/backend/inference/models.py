"""
Model management - downloading and validating models from Hugging Face.
"""
import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator, TypedDict

from huggingface_hub import hf_hub_download, snapshot_download
from tqdm import tqdm

from .config import MODELS_CONFIG, get_models_path

logger = logging.getLogger(__name__)


class ModelStatus(TypedDict):
    id: str
    name: str
    size: float  # Size in GB
    downloaded: bool
    downloadProgress: float


class DownloadProgress(TypedDict):
    progress: float
    speed: float  # MB/s
    eta: float  # seconds


class ModelManager:
    """Manages model downloads and validation."""
    
    def __init__(self, models_path: Path | None = None):
        self.models_path = models_path or get_models_path()
        self.models_path.mkdir(parents=True, exist_ok=True)
        
    def get_model_path(self, model_id: str) -> Path:
        """Get the local path for a model."""
        config = MODELS_CONFIG.get(model_id)
        if not config:
            raise ValueError(f"Unknown model: {model_id}")
        
        if "subfolder" in config:
            return self.models_path / config["subfolder"]
        else:
            return self.models_path / config["filename"]
    
    def is_model_downloaded(self, model_id: str) -> bool:
        """Check if a model is fully downloaded."""
        model_path = self.get_model_path(model_id)
        
        if model_path.is_dir():
            # For directories (like text encoder), check if it's not empty
            return any(model_path.iterdir())
        else:
            # For files, check if it exists and has non-zero size
            return model_path.exists() and model_path.stat().st_size > 0
    
    def all_models_available(self) -> bool:
        """Check if all required models are downloaded."""
        for model_id in MODELS_CONFIG:
            if not self.is_model_downloaded(model_id):
                return False
        return True
    
    def get_models_status(self) -> list[ModelStatus]:
        """Get the status of all models."""
        statuses = []
        
        for model_id, config in MODELS_CONFIG.items():
            downloaded = self.is_model_downloaded(model_id)
            statuses.append({
                "id": model_id,
                "name": config.get("filename", config.get("subfolder", model_id)),
                "size": config["size_gb"],
                "downloaded": downloaded,
                "downloadProgress": 100.0 if downloaded else 0.0,
            })
        
        return statuses
    
    async def download_model(self, model_id: str) -> Path:
        """Download a model from Hugging Face."""
        config = MODELS_CONFIG.get(model_id)
        if not config:
            raise ValueError(f"Unknown model: {model_id}")
        
        logger.info(f"Downloading model: {model_id} ({config.get('description', '')})")
        
        # Run in thread pool to not block
        loop = asyncio.get_event_loop()
        
        if "subfolder" in config:
            # Download entire folder
            path = await loop.run_in_executor(
                None,
                lambda: snapshot_download(
                    repo_id=config["repo_id"],
                    allow_patterns=f"{config['subfolder']}/**/*",
                    local_dir=self.models_path,
                    local_dir_use_symlinks=False,
                )
            )
        else:
            # Download single file
            path = await loop.run_in_executor(
                None,
                lambda: hf_hub_download(
                    repo_id=config["repo_id"],
                    filename=config["filename"],
                    local_dir=self.models_path,
                    local_dir_use_symlinks=False,
                )
            )
        
        logger.info(f"Model downloaded: {model_id} -> {path}")
        return Path(path)
    
    async def download_with_progress(self, model_id: str) -> AsyncIterator[DownloadProgress]:
        """Download a model with progress updates."""
        config = MODELS_CONFIG.get(model_id)
        if not config:
            raise ValueError(f"Unknown model: {model_id}")
        
        total_size = config["size_gb"] * 1024 * 1024 * 1024  # Convert to bytes
        downloaded = 0
        last_update = 0
        
        # This is a simplified progress - real implementation would hook into
        # huggingface_hub's progress callbacks
        
        # For now, simulate progress during download
        download_task = asyncio.create_task(self.download_model(model_id))
        
        while not download_task.done():
            # Check actual file size if possible
            model_path = self.get_model_path(model_id)
            if model_path.exists():
                if model_path.is_file():
                    downloaded = model_path.stat().st_size
                else:
                    downloaded = sum(f.stat().st_size for f in model_path.rglob("*") if f.is_file())
            
            progress = min(99.0, (downloaded / total_size) * 100)
            
            yield {
                "progress": progress,
                "speed": 0,  # Would need proper tracking
                "eta": 0,
            }
            
            await asyncio.sleep(0.5)
        
        # Final progress
        yield {
            "progress": 100.0,
            "speed": 0,
            "eta": 0,
        }
    
    async def download_all_models(self) -> None:
        """Download all required models."""
        for model_id in MODELS_CONFIG:
            if not self.is_model_downloaded(model_id):
                await self.download_model(model_id)
