import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOrchestratedAgent } from "@/hooks/use-orchestrated-agent";
import type { OrchestrateResponse } from "@/types/agent-progress";

beforeEach(() => {
  Object.defineProperty(window, "electronAPI", {
    value: {
      getBackend: vi
        .fn()
        .mockResolvedValue({
          url: "http://localhost:8000",
          token: "test-token",
        }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responses: Array<{ body: object; ok?: boolean }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok ?? true,
      status: resp.ok === false ? 500 : 200,
      json: async () => resp.body,
    };
  }) as unknown as typeof globalThis.fetch;
}

function makeOrchestrateResponse(
  overrides: Partial<OrchestrateResponse> = {},
): OrchestrateResponse {
  return {
    session_id: "sess-1",
    status: "done",
    tasks: [],
    current_task_id: null,
    tool_calls: [],
    message: "All tasks completed.",
    done: true,
    ...overrides,
  };
}

const noopExecute = vi.fn(async () => ({
  tool_name: "noop",
  success: true,
  result: null,
  error: null,
}));

describe("useOrchestratedAgent", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useOrchestratedAgent());
    expect(result.current.progress.phase).toBe("idle");
    expect(result.current.messages).toEqual([]);
    expect(result.current.isProcessing).toBe(false);
  });

  it("simple orchestrate response (done immediately) ends cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ body: makeOrchestrateResponse() }]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Create a video",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.isProcessing).toBe(false);
    expect(result.current.progress.phase).toBe("done");
    expect(result.current.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("Create a video");
  });

  it("parses task plan from orchestrate response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: makeOrchestrateResponse({
            tasks: [
              {
                id: "task-1",
                description: "Write a script for the video",
                skill_id: "screenwriting",
                skill_name: "Screenwriting",
                depends_on: [],
                status: "completed",
                error: null,
              },
              {
                id: "task-2",
                description: "Generate all shots",
                skill_id: null,
                skill_name: null,
                depends_on: ["task-1"],
                status: "completed",
                error: null,
              },
            ],
          }),
        },
      ]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Make a video",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.progress.tasks.length).toBeGreaterThanOrEqual(2);
    const taskIds = result.current.progress.tasks.map((t) => t.id);
    expect(taskIds).toContain("task-1");
    expect(taskIds).toContain("task-2");
  });

  it("handles multi-round tool execution", async () => {
    const executeTool = vi.fn(async (tc: { tool_name: string }) => ({
      tool_name: tc.tool_name,
      success: true,
      result: { asset_id: "a1" },
      error: null,
    }));

    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: makeOrchestrateResponse({
            done: false,
            status: "awaiting_tool_results",
            tool_calls: [
              {
                tool_name: "generate_image",
                arguments: { prompt: "a cat" },
                call_id: "c1",
              },
            ],
            current_task_id: "task-1",
            tasks: [
              {
                id: "task-1",
                description: "Generate image",
                skill_id: null,
                skill_name: null,
                depends_on: [],
                status: "running",
                error: null,
              },
            ],
          }),
        },
        {
          body: makeOrchestrateResponse({
            done: true,
            status: "done",
            tasks: [
              {
                id: "task-1",
                description: "Generate image",
                skill_id: null,
                skill_name: null,
                depends_on: [],
                status: "completed",
                error: null,
              },
            ],
            message: "Image generated successfully.",
          }),
        },
      ]),
    );

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

    expect(executeTool).toHaveBeenCalled();
    expect(result.current.progress.phase).toBe("done");
    expect(result.current.isProcessing).toBe(false);
  });

  it("handles API error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ body: {}, ok: false }]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Do something",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.progress.phase).toBe("error");
    expect(result.current.isProcessing).toBe(false);
    const lastMsg = result.current.messages[result.current.messages.length - 1];
    expect(lastMsg.role).toBe("agent");
    expect(lastMsg.content).toContain("Orchestrate API error");
  });

  it("clearChat resets state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ body: makeOrchestrateResponse() }]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Test",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.messages.length).toBeGreaterThan(0);

    act(() => {
      result.current.clearChat();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.progress.phase).toBe("idle");
  });

  it("sets orchestrated flag in progress", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ body: makeOrchestrateResponse() }]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Orchestrate this",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.progress.isOrchestrated).toBe(true);
  });

  it("advances when no tool calls but not done", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: makeOrchestrateResponse({
            done: false,
            status: "executing",
            tool_calls: [],
            message: "Completed 1/2 tasks. Advancing...",
            tasks: [
              {
                id: "task-1",
                description: "Script",
                skill_id: null,
                skill_name: null,
                depends_on: [],
                status: "completed",
                error: null,
              },
              {
                id: "task-2",
                description: "Generate",
                skill_id: null,
                skill_name: null,
                depends_on: ["task-1"],
                status: "pending",
                error: null,
              },
            ],
          }),
        },
        {
          body: makeOrchestrateResponse({
            done: true,
            tasks: [
              {
                id: "task-1",
                description: "Script",
                skill_id: null,
                skill_name: null,
                depends_on: [],
                status: "completed",
                error: null,
              },
              {
                id: "task-2",
                description: "Generate",
                skill_id: null,
                skill_name: null,
                depends_on: ["task-1"],
                status: "completed",
                error: null,
              },
            ],
          }),
        },
      ]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Do two things",
        [],
        1,
        0,
        noopExecute,
      );
    });

    expect(result.current.progress.phase).toBe("done");
    expect(result.current.progress.turnCount).toBeGreaterThanOrEqual(1);
  });

  it("tracks failed tasks from backend response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: makeOrchestrateResponse({
            tasks: [
              {
                id: "task-1",
                description: "This task failed",
                skill_id: null,
                skill_name: null,
                depends_on: [],
                status: "failed",
                error: "Sub-agent crashed",
              },
            ],
          }),
        },
      ]),
    );

    const { result } = renderHook(() => useOrchestratedAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Failing task",
        [],
        1,
        0,
        noopExecute,
      );
    });

    const failedTask = result.current.progress.tasks.find(
      (t) => t.id === "task-1",
    );
    expect(failedTask?.status).toBe("failed");
  });
});
