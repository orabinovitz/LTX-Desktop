"""Model download session handler."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, cast

from api_types import DownloadProgressResponse
from handlers.base import StateHandlerBase, with_state_lock
from handlers.models_handler import ModelsHandler
from runtime_config.model_download_specs import MODEL_FILE_ORDER
from services.interfaces import ModelDownloader, TaskRunner
from state.app_state_types import AppState, DownloadError, FileDownloadCompleted, FileDownloadRunning, ModelFileType

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)


class DownloadHandler(StateHandlerBase):
    def __init__(
        self,
        state: AppState,
        lock: RLock,
        models_handler: ModelsHandler,
        model_downloader: ModelDownloader,
        task_runner: TaskRunner,
        config: RuntimeConfig,
    ) -> None:
        super().__init__(state, lock)
        self._models_handler = models_handler
        self._model_downloader = model_downloader
        self._task_runner = task_runner
        self._config = config

    @with_state_lock
    def is_download_running(self) -> bool:
        return self.state.is_downloading

    @with_state_lock
    def start_download(self, files: dict[ModelFileType, tuple[str, int]]) -> None:
        self.state.downloading_session = {
            cast(ModelFileType, file_key): FileDownloadRunning(
                target_path=target,
                progress=0.0,
                downloaded_bytes=0,
                total_bytes=size,
                speed_mbps=0.0,
            )
            for file_key, (target, size) in files.items()
        }

    @with_state_lock
    def update_file_progress(self, file_key: str, downloaded: int, total: int, speed_mbps: float) -> None:
        match self.state.downloading_session:
            case dict() as files:
                if file_key not in files:
                    return
                match files[file_key]:
                    case FileDownloadRunning() as running:
                        running.downloaded_bytes = downloaded
                        running.total_bytes = total
                        running.progress = 0.0 if total == 0 else min(1.0, max(0.0, downloaded / total))
                        running.speed_mbps = speed_mbps
                    case FileDownloadCompleted():
                        return
            case _:
                return

    @with_state_lock
    def complete_file(self, file_key: str) -> None:
        match self.state.downloading_session:
            case dict() as files:
                files[file_key] = FileDownloadCompleted()
            case _:
                return

    @with_state_lock
    def fail_download(self, error: str) -> None:
        self.state.downloading_session = DownloadError(error=error)

    @with_state_lock
    def get_download_progress(self) -> DownloadProgressResponse:
        status = "idle"
        current_file = ""
        current_file_progress = 0
        speed_mbps = 0
        downloaded_bytes = 0
        total_bytes = 0
        files_completed = 0
        total_files = 0
        error: str | None = None

        match self.state.downloading_session:
            case DownloadError(error=err):
                status = "error"
                error = err
            case dict() as files:
                status = "downloading" if self.state.is_downloading else "complete"
                total_files = len(files)
                for file_key, file_state in files.items():
                    size = self._config.spec_for(file_key).expected_size_bytes
                    total_bytes += size
                    match file_state:
                        case FileDownloadCompleted():
                            files_completed += 1
                            downloaded_bytes += size
                        case FileDownloadRunning() as running:
                            current_file = file_key
                            current_file_progress = int(running.progress * 100)
                            speed_mbps = int(running.speed_mbps)
                            downloaded_bytes += running.downloaded_bytes
            case _:
                status = "idle"

        total_progress = int((downloaded_bytes / total_bytes) * 100) if total_bytes > 0 else 0

        return DownloadProgressResponse(
            status=status,
            currentFile=current_file,
            currentFileProgress=current_file_progress,
            totalProgress=total_progress,
            downloadedBytes=downloaded_bytes,
            totalBytes=total_bytes,
            filesCompleted=files_completed,
            totalFiles=total_files,
            error=error,
            speedMbps=speed_mbps,
        )

    def _rename_text_encoder_files(self, text_encoder_path: Path) -> None:
        if not text_encoder_path.exists():
            return

        for f in text_encoder_path.glob("diffusion_pytorch_model*.safetensors"):
            new_name = f.name.replace("diffusion_pytorch_model", "model")
            new_path = f.parent / new_name
            if not new_path.exists():
                f.rename(new_path)

        index_file = text_encoder_path / "diffusion_pytorch_model.safetensors.index.json"
        new_index_file = text_encoder_path / "model.safetensors.index.json"
        if index_file.exists() and not new_index_file.exists():
            with open(index_file, "r", encoding="utf-8") as f:
                index_data = json.load(f)
            if "weight_map" in index_data:
                new_weight_map = {}
                for key, value in index_data["weight_map"].items():
                    new_weight_map[key] = value.replace("diffusion_pytorch_model", "model")
                index_data["weight_map"] = new_weight_map
            with open(new_index_file, "w", encoding="utf-8") as f:
                json.dump(index_data, f, indent=2)
            index_file.unlink()

    def _download_models_worker(self, skip_text_encoder: bool) -> None:
        files_to_download: dict[ModelFileType, tuple[str, int]] = {}

        self._models_handler.refresh_available_files()
        available = self.state.available_files.copy()

        for model_type in MODEL_FILE_ORDER:
            if model_type == "text_encoder" and skip_text_encoder:
                continue
            if available[model_type] is not None:
                continue
            spec = self._config.spec_for(model_type)
            files_to_download[model_type] = (spec.name, spec.expected_size_bytes)

        if not files_to_download:
            with self._lock:
                self.state.downloading_session = {}
            return

        self.start_download(files_to_download)

        try:
            for file_key, (target_name, expected_size) in files_to_download.items():
                spec = self._config.spec_for(file_key)
                logger.info("Downloading %s from %s", target_name, spec.repo_id)

                if spec.is_folder:
                    allow_patterns = list(spec.snapshot_allow_patterns) if spec.snapshot_allow_patterns is not None else None
                    self._model_downloader.download_snapshot(
                        repo_id=spec.repo_id,
                        local_dir=str(self._config.download_local_dir(file_key)),
                        allow_patterns=allow_patterns,
                    )
                    if file_key == "text_encoder":
                        self._rename_text_encoder_files(self._config.model_path("text_encoder"))
                else:
                    self._model_downloader.download_file(
                        repo_id=spec.repo_id,
                        filename=spec.name,
                        local_dir=str(self._config.download_local_dir(file_key)),
                    )

                self.update_file_progress(file_key, expected_size, expected_size, 0)
                self.complete_file(file_key)

            self._models_handler.refresh_available_files()
        except Exception as exc:
            self.fail_download(str(exc))

    def start_model_download(self, skip_text_encoder: bool = False) -> bool:
        with self._lock:
            if self.state.is_downloading:
                return False

        self._task_runner.run_background(lambda: self._download_models_worker(skip_text_encoder), daemon=True)
        return True

    def start_text_encoder_download(self) -> bool:
        with self._lock:
            if self.state.is_downloading:
                return False

        def worker() -> None:
            try:
                text_spec = self._config.spec_for("text_encoder")
                self.start_download({"text_encoder": (text_spec.name, text_spec.expected_size_bytes)})
                self._model_downloader.download_snapshot(
                    repo_id=text_spec.repo_id,
                    local_dir=str(self._config.download_local_dir("text_encoder")),
                    allow_patterns=list(text_spec.snapshot_allow_patterns) if text_spec.snapshot_allow_patterns is not None else None,
                )
                self._rename_text_encoder_files(self._config.model_path("text_encoder"))
                self.update_file_progress(
                    "text_encoder",
                    text_spec.expected_size_bytes,
                    text_spec.expected_size_bytes,
                    0,
                )
                self.complete_file("text_encoder")
                self._models_handler.refresh_available_files()
            except Exception as exc:
                self.fail_download(str(exc))

        self._task_runner.run_background(worker, daemon=True)
        return True
