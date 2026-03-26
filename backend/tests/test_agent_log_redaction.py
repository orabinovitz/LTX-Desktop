from __future__ import annotations

import json
import logging

from agent.orchestration.orchestrator import Orchestrator
from agent.skills.skill_registry import SkillRegistry
from agent.types import OrchestrateRequest
from tests.fakes.services import FakeHTTPClient, FakeResponse


def _planner_response(tasks_json: list[dict[str, object]]) -> FakeResponse:
    return FakeResponse(
        status_code=200,
        json_payload={
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": json.dumps({"tasks": tasks_json}),
                    }],
                },
            }],
        },
    )


def test_orchestrator_planning_log_omits_raw_prompt(caplog) -> None:
    caplog.set_level(logging.INFO)
    http = FakeHTTPClient()
    http.queue("post", _planner_response([
        {
            "id": "task-1",
            "description": "Write script",
            "task_type": "creative",
            "depends_on": [],
            "tool_categories": [],
            "context_requirements": [],
        },
    ]))
    orchestrator = Orchestrator(
        api_key="fake-key",
        http_client=http,
        skill_registry=SkillRegistry(),
    )
    prompt = "super secret launch campaign prompt"

    orchestrator.start(OrchestrateRequest(prompt=prompt))

    planning_records = [
        record
        for record in caplog.records
        if record.name == "agent.orchestration.orchestrator"
        and "[orchestrator] session=" in record.getMessage()
        and "planning" in record.getMessage()
    ]
    assert len(planning_records) == 1
    assert prompt not in planning_records[0].getMessage()
