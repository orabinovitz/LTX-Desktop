import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger, setRendererLogContext, clearRendererLogContext } from "@/lib/logger";

describe("frontend logger", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      value: {
        writeLog: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    clearRendererLogContext();
    vi.restoreAllMocks();
  });

  it("sends structured log payloads to the Electron bridge", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Session started", {
      category: "agent.session",
      requestId: "req-1",
      traceId: "trace-1",
      agentSessionId: "sess-1",
      sinks: { terminal: false, sessionFile: true },
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(window.electronAPI.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "INFO",
        source: "Renderer",
        category: "agent.session",
        message: "Session started",
        requestId: "req-1",
        traceId: "trace-1",
        agentSessionId: "sess-1",
        sinks: { terminal: false, sessionFile: true },
      }),
    );
  });

  it("warns to the console when persisting the log entry fails", async () => {
    const persistError = new Error("ipc failed");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.electronAPI.writeLog = vi.fn().mockRejectedValue(persistError);

    logger.info("Session started", {
      category: "agent.session",
    });

    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist renderer log"),
      persistError,
    );
  });

  it("merges session-wide renderer log context into emitted entries", () => {
    setRendererLogContext({
      traceId: "trace-global",
      agentSessionId: "sess-global",
    });

    logger.info("Session started", {
      category: "agent.session",
    });

    expect(window.electronAPI.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-global",
        agentSessionId: "sess-global",
      }),
    );
  });

  it("clearing an older renderer context does not remove the newest context", () => {
    const firstId = setRendererLogContext({
      traceId: "trace-first",
      agentSessionId: "sess-first",
    });
    setRendererLogContext({
      traceId: "trace-second",
      agentSessionId: "sess-second",
    });

    clearRendererLogContext(firstId);
    logger.info("Session started", {
      category: "agent.session",
    });

    expect(window.electronAPI.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-second",
        agentSessionId: "sess-second",
      }),
    );
  });
});
