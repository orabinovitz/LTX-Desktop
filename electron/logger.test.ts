import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushLogsForTests,
  resetLoggerForTests,
  setLogFilePath,
  writeLogEntry,
} from "./logger";

describe("electron logger", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ltx-electron-logger-"));
    logPath = path.join(tempDir, "session.log");
    resetLoggerForTests();
  });

  afterEach(() => {
    resetLoggerForTests();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("buffers log entries written before the file path is initialized", async () => {
    writeLogEntry({
      level: "INFO",
      source: "Electron",
      category: "desktop.process",
      message: "Early startup line",
      sinks: { terminal: false, sessionFile: true },
    });

    setLogFilePath(logPath);
    await flushLogsForTests();

    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("Early startup line");
    expect(content).toContain("[desktop.process]");
  });

  it("skips terminal output for file-only log entries", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    setLogFilePath(logPath);
    writeLogEntry({
      level: "INFO",
      source: "Electron",
      category: "agent.tool",
      message: "Tool dispatch detail",
      sinks: { terminal: false, sessionFile: true },
    });
    await flushLogsForTests();

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(logPath, "utf-8")).toContain("Tool dispatch detail");
  });
});
