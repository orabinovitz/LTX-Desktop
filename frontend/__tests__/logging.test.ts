import { describe, expect, it } from "vitest";

import {
  formatPersistedLogLine,
  parseLogLine,
  type LogEntry,
} from "../../shared/logging";

describe("shared logging helpers", () => {
  it("formats and parses structured log lines with context fields", () => {
    const entry: LogEntry = {
      level: "INFO",
      source: "Renderer",
      category: "agent.session",
      message: "Session started",
      requestId: "req-123",
      traceId: "trace-123",
      agentSessionId: "sess-123",
      sinks: { terminal: true, sessionFile: true },
    };

    const line = formatPersistedLogLine(entry, "2026-03-26 12:34:56,789");

    expect(line).toBe(
      "2026-03-26 12:34:56,789 - INFO - [Renderer] [agent.session] Session started | request_id=req-123 trace_id=trace-123 agent_session_id=sess-123",
    );

    expect(parseLogLine(line)).toEqual({
      timestamp: "2026-03-26 12:34:56,789",
      level: "INFO",
      source: "Renderer",
      category: "agent.session",
      message: "Session started",
      context: {
        request_id: "req-123",
        trace_id: "trace-123",
        agent_session_id: "sess-123",
      },
      raw: line,
    });
  });

  it("parses legacy lines without structured category or context", () => {
    const line = "2026-03-26 12:34:56,789 - ERROR - [Backend] Something exploded";

    expect(parseLogLine(line)).toEqual({
      timestamp: "2026-03-26 12:34:56,789",
      level: "ERROR",
      source: "Backend",
      category: undefined,
      message: "Something exploded",
      context: {},
      raw: line,
    });
  });

  it("keeps message content that legitimately contains a pipe separator", () => {
    const line =
      "2026-03-26 12:34:56,789 - INFO - [Backend] [agent.plan] session=abc | planning request (prompt_chars=42) | trace_id=trace-123 request_id=req-123";

    expect(parseLogLine(line)).toEqual({
      timestamp: "2026-03-26 12:34:56,789",
      level: "INFO",
      source: "Backend",
      category: "agent.plan",
      message: "session=abc | planning request (prompt_chars=42)",
      context: {
        trace_id: "trace-123",
        request_id: "req-123",
      },
      raw: line,
    });
  });
});
