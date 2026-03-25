from __future__ import annotations

from types import SimpleNamespace

import app_handler


def test_build_provider_http_clients_separates_fal_transport() -> None:
    assert hasattr(app_handler, "_build_provider_http_clients")

    created: list[SimpleNamespace] = []

    def factory(**kwargs):
        client = SimpleNamespace(kwargs=kwargs)
        created.append(client)
        return client

    general_http, fal_http = app_handler._build_provider_http_clients(factory)

    assert general_http is not fal_http
    assert len(created) == 2
    assert created[0].kwargs["client_name"] == "default"
    assert created[1].kwargs["client_name"] == "fal-nb2"
    assert created[1].kwargs["http2"] is False
    assert created[1].kwargs["max_connections"] < created[0].kwargs["max_connections"]
