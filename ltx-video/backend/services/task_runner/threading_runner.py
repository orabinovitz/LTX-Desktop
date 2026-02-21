"""Background task runner service."""

from __future__ import annotations

import threading
from collections.abc import Callable


class ThreadingRunner:
    """Runs tasks on daemon threads."""

    def run_background(self, target: Callable[[], None], *, daemon: bool = True) -> None:
        thread = threading.Thread(target=target, daemon=daemon)
        thread.start()
