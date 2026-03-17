"""Optional Sentry integration — active only when SENTRY_DSN is set."""

from __future__ import annotations

import os


def init_sentry() -> None:
    """Initialize Sentry SDK if a DSN is configured via environment variable."""
    dsn = os.environ.get("SENTRY_DSN", "")
    if not dsn:
        return

    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    sentry_sdk.init(
        dsn=dsn,
        integrations=[
            FastApiIntegration(),
            StarletteIntegration(),
        ],
        traces_sample_rate=0.2,
        send_default_pii=False,
    )
