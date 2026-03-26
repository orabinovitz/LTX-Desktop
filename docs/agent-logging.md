# Agent Logging Guide

## Default Behavior

LTX Desktop now treats the terminal as a high-signal surface, not a raw mirror of every log line.

- `ERROR` and `WARNING` logs still go to the terminal by default.
- A small set of agent lifecycle milestones also stay visible:
  - session start
  - plan received
  - session complete
  - backend/electron process lifecycle events
- Noisy per-turn, per-tool, and routine timing logs are still persisted to the session log file, but they are not part of the default terminal stream.

## Correlation Fields

These fields are now propagated across the agent stack:

- `request_id`: unique per HTTP request
- `trace_id`: stable across one agent run, including chained requests
- `agent_session_id`: backend agent/orchestrator session identifier
- `task_id`: orchestrator task identifier when applicable
- `tool_call_id`: frontend/backend tool invocation identifier

The session log file stores these as searchable `key=value` pairs, for example:

```text
2026-03-26 12:34:56,789 - ERROR - [Backend] [agent.error] Task failed | trace_id=trace-123 agent_session_id=sess-456 task_id=task-7
```

## In-App Log Viewer

The log viewer now loads a much larger tail and supports filtering by:

- level
- source
- trace ID
- session ID
- task ID
- free-text search

Use it to narrow directly from a failing run to the relevant log slice instead of scanning the whole file manually.

## Agent Debug Mode

If you want the old verbose stream back in the terminal temporarily, start the app with:

```bash
LTX_AGENT_DEBUG=1 pnpm dev
```

That forces the richer agent log stream back to the terminal without changing the default behavior for normal runs.

## Recommended Debug Workflow

1. Reproduce the failure once with default logging.
2. Copy the `Trace ID` shown in the chat error or log viewer.
3. Filter the log viewer by that trace ID.
4. If the default terminal stream is still too sparse, rerun with `LTX_AGENT_DEBUG=1`.
