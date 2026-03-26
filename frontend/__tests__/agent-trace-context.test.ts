import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useOrchestratedAgent } from "@/hooks/use-orchestrated-agent";
import type { OrchestrateResponse } from "@/types/agent-progress";

function makeOrchestrateResponse(
  overrides: Partial<OrchestrateResponse> = {},
): OrchestrateResponse {
  return {
    session_id: "sess-trace-1",
    status: "done",
    tasks: [],
    current_task_id: null,
    tool_calls: [],
    message: "All tasks completed.",
    done: true,
    ...overrides,
  };
}

describe("agent trace propagation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      value: {
        getBackend: vi.fn().mockResolvedValue({
          url: "http://localhost:8000",
          token: "test-token",
        }),
        writeLog: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses one trace id across chained orchestrated agent requests", async () => {
    const fetchCalls: Array<{ url: string; headers: Headers }> = [];
    const responses = [
      makeOrchestrateResponse({
        status: "awaiting_tool_results",
        done: false,
        current_task_id: "task-1",
        tasks: [
          {
            id: "task-1",
            description: "Generate the image",
            skill_id: null,
            skill_name: null,
            depends_on: [],
            status: "running",
            error: null,
          },
        ],
        tool_calls: [
          {
            tool_name: "generate_image",
            arguments: { prompt: "a cat" },
            task_id: "task-1",
            call_id: "call-1",
          },
        ],
      }),
      makeOrchestrateResponse({
        done: true,
        tasks: [
          {
            id: "task-1",
            description: "Generate the image",
            skill_id: null,
            skill_name: null,
            depends_on: [],
            status: "completed",
            error: null,
          },
        ],
      }),
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          headers: new Headers(init?.headers),
        });
        const body = responses.shift() ?? makeOrchestrateResponse();
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }) as unknown as typeof globalThis.fetch,
    );

    const executeTool = vi.fn(async () => ({
      tool_name: "generate_image",
      success: true,
      result: { asset_id: "img-1" },
      error: null,
      call_id: "call-1",
    }));

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Generate an image of a cat",
        [],
        1,
        0,
        executeTool,
      );
    });

    const agentCalls = fetchCalls.filter((call) =>
      call.url.includes("/api/agent/orchestrate"),
    );
    expect(agentCalls).toHaveLength(2);

    const traceIds = agentCalls.map((call) => call.headers.get("X-Trace-ID"));
    expect(traceIds[0]).toBeTruthy();
    expect(new Set(traceIds).size).toBe(1);

    const requestIds = agentCalls.map((call) => call.headers.get("X-Request-ID"));
    expect(new Set(requestIds).size).toBe(2);
  });
});
