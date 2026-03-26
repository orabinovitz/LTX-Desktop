import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LogViewer } from "@/components/LogViewer";

describe("LogViewer", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      value: {
        getLogs: vi.fn().mockResolvedValue({
          logPath: "/tmp/session.log",
          totalLines: 4,
          lines: [
            "2026-03-26 12:34:56,789 - ERROR - [Backend] [agent.error] Task failed | trace_id=trace-1 agent_session_id=sess-1 task_id=task-1",
            'Traceback (most recent call last):',
            "2026-03-26 12:35:01,123 - INFO - [Renderer] [agent.session] Session started | trace_id=trace-2 agent_session_id=sess-2",
            "2026-03-26 12:35:03,999 - WARNING - [Electron] [backend.process] Python backend exited with code 1",
          ],
        }),
        openLogFolder: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });
  });

  it("filters log lines by trace id", async () => {
    render(<LogViewer isOpen={true} onClose={() => {}} embedded />);

    await screen.findByText(/Task failed/);
    expect(screen.getByText(/Session started/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Trace ID"), {
      target: { value: "trace-1" },
    });

    await waitFor(() => {
      expect(screen.getByText(/Task failed/)).toBeInTheDocument();
      expect(screen.getByText(/Traceback/)).toBeInTheDocument();
      expect(screen.queryByText(/Session started/)).not.toBeInTheDocument();
    });
  });
});
