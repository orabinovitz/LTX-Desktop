"""Model downloader service protocol definitions."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol


class ModelDownloader(Protocol):
    def download_file(self, repo_id: str, filename: str, local_dir: str) -> Path:
        ...

    def download_snapshot(
        self,
        repo_id: str,
        local_dir: str,
        allow_patterns: list[str] | None = None,
    ) -> Path:
        ...
