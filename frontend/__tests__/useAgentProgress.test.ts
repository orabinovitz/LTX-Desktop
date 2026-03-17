import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentProgress } from "@/hooks/use-agent-progress";

describe("useAgentProgress", () => {
  it("starts with idle phase and collapsed", () => {
    const { result } = renderHook(() => useAgentProgress());
    expect(result.current.progress.phase).toBe("idle");
    expect(result.current.progress.tasks).toEqual([]);
    expect(result.current.progress.currentTaskId).toBeNull();
    expect(result.current.progress.collapsed).toBe(true);
    expect(result.current.progress.reasoning).toBe("");
  });

  it("startSession resets to thinking phase and auto-opens", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());

    expect(result.current.progress.phase).toBe("thinking");
    expect(result.current.progress.thinkingLine).toBe("Analyzing your request...");
    expect(result.current.progress.startedAt).toBeGreaterThan(0);
    expect(result.current.progress.tasks).toEqual([]);
    expect(result.current.progress.collapsed).toBe(false);
    expect(result.current.progress.reasoning).toBe("");
  });

  it("setThinking updates the thinking line", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() => result.current.setThinking("Planning your edit..."));

    expect(result.current.progress.thinkingLine).toBe("Planning your edit...");
  });

  it("setReasoning updates reasoning text", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setReasoning("I'll create images and animate them"),
    );

    expect(result.current.progress.reasoning).toBe(
      "I'll create images and animate them",
    );
  });

  it("setPlan sets tasks, transitions to executing, and stays collapsed", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
        { id: "t2", label: "Step 2", status: "pending" },
      ]),
    );

    expect(result.current.progress.phase).toBe("executing");
    expect(result.current.progress.tasks).toHaveLength(2);
    expect(result.current.progress.thinkingLine).toBe("");
    expect(result.current.progress.collapsed).toBe(true);
  });

  it("setCollapsed controls collapsed state", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    expect(result.current.progress.collapsed).toBe(false);

    act(() => result.current.setCollapsed(true));
    expect(result.current.progress.collapsed).toBe(true);

    act(() => result.current.setCollapsed(false));
    expect(result.current.progress.collapsed).toBe(false);
  });

  it("startTask marks task in_progress and preserves collapsed state", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
        { id: "t2", label: "Step 2", status: "pending" },
      ]),
    );

    act(() => result.current.startTask("t1"));
    expect(result.current.progress.tasks[0].status).toBe("in_progress");
    expect(result.current.progress.tasks[0].startedAt).toBeGreaterThan(0);
    expect(result.current.progress.currentTaskId).toBe("t1");
    expect(result.current.progress.collapsed).toBe(true);

    act(() => result.current.setCollapsed(false));
    act(() => result.current.startTask("t2"));
    expect(result.current.progress.tasks[1].status).toBe("in_progress");
    expect(result.current.progress.currentTaskId).toBe("t2");
    expect(result.current.progress.collapsed).toBe(false);
  });

  it("startTask accepts a detail string", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Generate", status: "pending" },
      ]),
    );
    act(() => result.current.startTask("t1", "Image 1/6"));

    expect(result.current.progress.tasks[0].detail).toBe("Image 1/6");
  });

  it("completeTask marks task as completed", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
      ]),
    );
    act(() => result.current.startTask("t1"));
    act(() => result.current.completeTask("t1"));

    expect(result.current.progress.tasks[0].status).toBe("completed");
    expect(result.current.progress.tasks[0].completedAt).toBeGreaterThan(0);
    expect(result.current.progress.tasks[0].progress).toBe(100);
  });

  it("failTask marks task as failed with error", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
      ]),
    );
    act(() => result.current.startTask("t1"));
    act(() => result.current.failTask("t1", "Network error"));

    expect(result.current.progress.tasks[0].status).toBe("failed");
    expect(result.current.progress.tasks[0].error).toBe("Network error");
  });

  it("updateTaskProgress sets progress number and detail", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Generate", status: "pending" },
      ]),
    );
    act(() => result.current.startTask("t1"));
    act(() =>
      result.current.updateTaskProgress("t1", 45, "Loading model..."),
    );

    expect(result.current.progress.tasks[0].progress).toBe(45);
    expect(result.current.progress.tasks[0].detail).toBe("Loading model...");
  });

  it("addAdHocTask appends a new task", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.addAdHocTask({
        id: "adhoc-0",
        label: "Extra task",
        status: "in_progress",
        startedAt: Date.now(),
      }),
    );

    expect(result.current.progress.tasks).toHaveLength(1);
    expect(result.current.progress.tasks[0].label).toBe("Extra task");
  });

  it("incrementTurn increments the turn count", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() => result.current.incrementTurn());
    act(() => result.current.incrementTurn());

    expect(result.current.progress.turnCount).toBe(2);
  });

  it("endSession sets phase to done and completes in-progress tasks", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
      ]),
    );
    act(() => result.current.startTask("t1"));
    act(() => result.current.endSession());

    expect(result.current.progress.phase).toBe("done");
    expect(result.current.progress.tasks[0].status).toBe("completed");
    expect(result.current.progress.currentTaskId).toBeNull();
  });

  it("endSession with error sets phase to error", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() => result.current.endSession("Something broke"));

    expect(result.current.progress.phase).toBe("error");
    expect(result.current.progress.error).toBe("Something broke");
  });

  it("reset returns to idle state with collapsed=true", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => result.current.startSession());
    act(() =>
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
      ]),
    );
    act(() => result.current.reset());

    expect(result.current.progress.phase).toBe("idle");
    expect(result.current.progress.tasks).toEqual([]);
    expect(result.current.progress.collapsed).toBe(true);
  });

  it("handles rapid successive updates without stale state", () => {
    const { result } = renderHook(() => useAgentProgress());

    act(() => {
      result.current.startSession();
      result.current.setPlan([
        { id: "t1", label: "Step 1", status: "pending" },
        { id: "t2", label: "Step 2", status: "pending" },
      ]);
      result.current.startTask("t1");
      result.current.updateTaskProgress("t1", 50);
      result.current.completeTask("t1");
      result.current.startTask("t2");
    });

    expect(result.current.progress.tasks[0].status).toBe("completed");
    expect(result.current.progress.tasks[1].status).toBe("in_progress");
  });
});
