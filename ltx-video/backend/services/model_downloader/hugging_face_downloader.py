"""Hugging Face model download service wrapper."""

from __future__ import annotations

from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download  # type: ignore[reportUnknownVariableType]


class HuggingFaceDownloader:
    """Wraps huggingface_hub download functions."""

    def download_file(self, repo_id: str, filename: str, local_dir: str) -> Path:
        path = hf_hub_download(repo_id=repo_id, filename=filename, local_dir=local_dir)
        return Path(path)

    def download_snapshot(
        self,
        repo_id: str,
        local_dir: str,
        allow_patterns: list[str] | None = None,
    ) -> Path:
        path = snapshot_download(repo_id=repo_id, local_dir=local_dir, allow_patterns=allow_patterns)
        return Path(path)
