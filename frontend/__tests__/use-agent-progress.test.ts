import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgent } from "@/hooks/use-agent";

beforeEach(() => {
  Object.defineProperty(window, "electronAPI", {
    value: {
      getBackendUrl: vi.fn().mockResolvedValue("http://localhost:8000"),
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

describe("useAgent progress integration", () => {
  it("simple response (done=true immediately) ends progress cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "Here is your answer.",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const { result } = renderHook(() => useAgent());

    expect(result.current.progress.phase).toBe("idle");

    const noopExecute = vi.fn(async () => ({
      tool_name: "noop",
      success: true,
      result: null,
      error: null,
    }));

    await act(async () => {
      await result.current.sendPrompt("What is this?", [], 0, 0, noopExecute);
    });

    expect(result.current.progress.phase).toBe("done");
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].content).toBe("Here is your answer.");
  });

  it("plan response extracts reasoning and creates tasks", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "I'll help you. Here's my plan:\n- Generate an image\n- Add it to timeline",
            tool_calls: [
              { tool_name: "generate_image", arguments: { prompt: "test" } },
            ],
            message: "",
            done: false,
            session_id: "s1",
          },
        },
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "All done!",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const executeFn = vi.fn(async () => ({
      tool_name: "generate_image",
      success: true,
      result: { assetId: "a1" },
      error: null,
    }));

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Generate an image and add to timeline",
        [],
        0,
        0,
        executeFn,
      );
    });

    expect(result.current.progress.phase).toBe("done");
    expect(result.current.progress.reasoning).toContain("I'll help you");
    expect(result.current.progress.tasks.length).toBeGreaterThan(0);
    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(result.current.isProcessing).toBe(false);
  });

  it("groups multiple identical tool calls into one task", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "- Generate 3 images",
            tool_calls: [
              { tool_name: "generate_image", arguments: { prompt: "a" } },
              { tool_name: "generate_image", arguments: { prompt: "b" } },
              { tool_name: "generate_image", arguments: { prompt: "c" } },
            ],
            message: "",
            done: false,
            session_id: "s1",
          },
        },
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "Done!",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const executeFn = vi.fn(async () => ({
      tool_name: "generate_image",
      success: true,
      result: { assetId: "a1" },
      error: null,
    }));

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt("Generate 3 images", [], 0, 0, executeFn);
    });

    expect(executeFn).toHaveBeenCalledTimes(3);

    const completedTasks = result.current.progress.tasks.filter(
      (t) => t.status === "completed",
    );
    expect(completedTasks.length).toBeLessThanOrEqual(2);

    const generateTasks = result.current.progress.tasks.filter((t) =>
      t.label.toLowerCase().includes("generat"),
    );
    expect(generateTasks.length).toBe(1);
  });

  it("error response sets progress to error phase", async () => {
    vi.stubGlobal("fetch", mockFetch([{ body: {}, ok: false }]));

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt("Do something", [], 0, 0, vi.fn());
    });

    expect(result.current.progress.phase).toBe("error");
  });

  it("clearChat resets progress to idle", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "Done",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt("test", [], 0, 0, vi.fn());
    });

    expect(result.current.progress.phase).toBe("done");

    act(() => result.current.clearChat());

    expect(result.current.progress.phase).toBe("idle");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.progress.collapsed).toBe(true);
  });

  it("tool failure marks task as failed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "- Generate a video",
            tool_calls: [
              { tool_name: "generate_video", arguments: { prompt: "test" } },
            ],
            message: "",
            done: false,
            session_id: "s1",
          },
        },
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "Generation failed.",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const failingExecute = vi.fn(async () => ({
      tool_name: "generate_video",
      success: false,
      result: null,
      error: "GPU out of memory",
    }));

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Generate a video",
        [],
        0,
        0,
        failingExecute,
      );
    });

    const failedTasks = result.current.progress.tasks.filter(
      (t) => t.status === "failed",
    );
    expect(failedTasks.length).toBeGreaterThanOrEqual(1);
  });

  it("multi-turn loop tracks turn count", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "- Step 1\n- Step 2",
            tool_calls: [
              { tool_name: "generate_image", arguments: { prompt: "a" } },
            ],
            message: "",
            done: false,
            session_id: "s1",
          },
        },
        {
          body: {
            plan: "",
            tool_calls: [
              {
                tool_name: "add_clip_to_track",
                arguments: { asset_id: "a1" },
              },
            ],
            message: "",
            done: false,
            session_id: "s1",
          },
        },
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "All done!",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const executeFn = vi.fn(async () => ({
      tool_name: "ok",
      success: true,
      result: null,
      error: null,
    }));

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.sendPrompt(
        "Do two things",
        [],
        0,
        0,
        executeFn,
      );
    });

    expect(result.current.progress.turnCount).toBe(2);
    expect(result.current.progress.phase).toBe("done");
  });

  it("startSession auto-opens collapsed progress", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          body: {
            plan: "",
            tool_calls: [],
            message: "Done",
            done: true,
            session_id: "s1",
          },
        },
      ]),
    );

    const { result } = renderHook(() => useAgent());

    expect(result.current.progress.collapsed).toBe(true);

    await act(async () => {
      await result.current.sendPrompt("test", [], 0, 0, vi.fn());
    });

    expect(result.current.progress.collapsed).toBe(false);
  });
});
