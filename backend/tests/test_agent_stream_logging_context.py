from __future__ import annotations

import logging

from app_factory import create_app
from log_context import log_extra


def test_agent_execute_stream_preserves_request_context_in_worker_logs(caplog, test_state, monkeypatch) -> None:
    caplog.set_level(logging.ERROR)

    worker_logger = logging.getLogger("agent_stream_context_test")

    def _execute(_request) -> object:
        worker_logger.error(
            "stream worker marker",
            extra=log_extra(category="agent.stream.test"),
        )
        from agent.types import AgentExecuteResponse

        return AgentExecuteResponse(done=True, session_id="sess-stream", message="ok")

    monkeypatch.setattr(test_state.agent, "execute", _execute)

    from starlette.testclient import TestClient

    with TestClient(create_app(handler=test_state), raise_server_exceptions=False) as test_client:
        response = test_client.post(
            "/api/agent/execute/stream",
            json={"prompt": "test"},
            headers={"x-request-id": "req-stream-1", "x-trace-id": "trace-stream-1"},
        )

    assert response.status_code == 200
    records = [
        record for record in caplog.records
        if record.name == "agent_stream_context_test" and "stream worker marker" in record.getMessage()
    ]
    assert len(records) == 1
    assert getattr(records[0], "request_id", None) == "req-stream-1"
    assert getattr(records[0], "trace_id", None) == "trace-stream-1"
