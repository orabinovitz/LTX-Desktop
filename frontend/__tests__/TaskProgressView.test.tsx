import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskProgressView } from "@/components/TaskProgressView";
import type { AgentProgress, AgentTask } from "@/types/agent-progress";
import { INITIAL_PROGRESS } from "@/types/agent-progress";

function makeProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
  return { ...INITIAL_PROGRESS, ...overrides };
}

function makeTasks(...statuses: AgentTask["status"][]): AgentTask[] {
  return statuses.map((status, i) => ({
    id: `t${i}`,
    label: `Task ${i + 1}`,
    status,
    startedAt: status !== "pending" ? Date.now() - 5000 : undefined,
    completedAt: status === "completed" ? Date.now() : undefined,
  }));
}

const noop = () => {};

describe("TaskProgressView", () => {
  it("renders nothing when phase is idle", () => {
    const { container } = render(
      <TaskProgressView progress={makeProgress()} onSetCollapsed={noop} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders thinking line when in thinking phase", () => {
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "thinking",
          thinkingLine: "Analyzing your request...",
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("Analyzing your request...")).toBeInTheDocument();
  });

  it("renders reasoning block when reasoning is present", () => {
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          reasoning: "I'll create 6 images and arrange them",
          tasks: makeTasks("pending"),
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(
      screen.getByText("I'll create 6 images and arrange them"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-block")).toBeInTheDocument();
  });

  it("hides reasoning after session ends", () => {
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "done",
          reasoning: "I'll create 6 images",
          tasks: makeTasks("completed"),
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.queryByTestId("reasoning-block")).not.toBeInTheDocument();
  });

  it("renders correct number of task items", () => {
    const tasks = makeTasks("completed", "in_progress", "pending");
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now() - 10000,
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.getByText("Task 2")).toBeInTheDocument();
    expect(screen.getByText("Task 3")).toBeInTheDocument();
  });

  it("shows progress bar for in-progress task with progress", () => {
    const tasks: AgentTask[] = [
      {
        id: "t1",
        label: "Generating",
        status: "in_progress",
        progress: 45,
        startedAt: Date.now(),
      },
    ];
    const { container } = render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    const progressBar = container.querySelector('[style*="width: 45%"]');
    expect(progressBar).toBeInTheDocument();
  });

  it("shows detail text for active task", () => {
    const tasks: AgentTask[] = [
      {
        id: "t1",
        label: "Generating",
        status: "in_progress",
        detail: "2/6 complete",
        startedAt: Date.now(),
      },
    ];
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("2/6 complete")).toBeInTheDocument();
  });

  it("shows error text for failed task", () => {
    const tasks: AgentTask[] = [
      {
        id: "t1",
        label: "Failed task",
        status: "failed",
        error: "GPU out of memory",
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    ];
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("GPU out of memory")).toBeInTheDocument();
  });

  it("shows error banner when phase is error", () => {
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "error",
          error: "Connection failed",
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });

  it("collapse toggle calls onSetCollapsed", () => {
    const onSetCollapsed = vi.fn();
    const tasks = makeTasks("completed", "in_progress");
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={onSetCollapsed}
      />,
    );

    const toggle = screen.getByTestId("collapse-toggle");
    fireEvent.click(toggle);

    expect(onSetCollapsed).toHaveBeenCalledWith(true);
  });

  it("hides tasks when collapsed is true", () => {
    const tasks = makeTasks("completed", "in_progress");
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "executing",
          tasks,
          startedAt: Date.now(),
          collapsed: true,
        })}
        onSetCollapsed={noop}
      />,
    );

    const taskItem = screen.getByText("Task 1").closest("div");
    expect(taskItem?.closest('[class*="max-h-0"]')).toBeInTheDocument();
  });

  it("handles empty task list gracefully", () => {
    const { container } = render(
      <TaskProgressView
        progress={makeProgress({
          phase: "thinking",
          thinkingLine: "Working...",
          tasks: [],
          startedAt: Date.now(),
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(
      container.querySelector("[data-testid='task-progress-view']"),
    ).toBeInTheDocument();
  });

  it("shows completion summary", () => {
    const tasks = makeTasks("completed", "completed", "completed");
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "done",
          tasks,
          startedAt: Date.now() - 30000,
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("3/3 completed")).toBeInTheDocument();
  });

  it("shows failure count in summary", () => {
    const tasks: AgentTask[] = [
      { id: "t1", label: "OK", status: "completed", completedAt: Date.now() },
      {
        id: "t2",
        label: "Fail",
        status: "failed",
        error: "err",
        completedAt: Date.now(),
      },
    ];
    render(
      <TaskProgressView
        progress={makeProgress({
          phase: "done",
          tasks,
          startedAt: Date.now() - 5000,
          collapsed: false,
        })}
        onSetCollapsed={noop}
      />,
    );
    expect(screen.getByText("1 done, 1 failed")).toBeInTheDocument();
  });
});
