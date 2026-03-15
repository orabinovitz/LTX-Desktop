import { useCallback, useRef, useState } from "react";
import type { AgentProgress, AgentTask } from "@/types/agent-progress";
import { INITIAL_PROGRESS } from "@/types/agent-progress";

export function useAgentProgress() {
  const [progress, setProgress] = useState<AgentProgress>(INITIAL_PROGRESS);
  const progressRef = useRef<AgentProgress>(INITIAL_PROGRESS);

  const update = useCallback((patch: Partial<AgentProgress>) => {
    setProgress((prev) => {
      const next = { ...prev, ...patch };
      progressRef.current = next;
      return next;
    });
  }, []);

  const updateTask = useCallback(
    (taskId: string, taskPatch: Partial<AgentTask>) => {
      setProgress((prev) => {
        const tasks = prev.tasks.map((t) =>
          t.id === taskId ? { ...t, ...taskPatch } : t,
        );
        const next = { ...prev, tasks };
        progressRef.current = next;
        return next;
      });
    },
    [],
  );

  const startSession = useCallback(() => {
    const fresh: AgentProgress = {
      ...INITIAL_PROGRESS,
      phase: "thinking",
      thinkingLine: "Analyzing your request...",
      reasoning: "",
      collapsed: false,
      startedAt: Date.now(),
    };
    progressRef.current = fresh;
    setProgress(fresh);
  }, []);

  const setThinking = useCallback(
    (line: string) => {
      update({ thinkingLine: line });
    },
    [update],
  );

  const setReasoning = useCallback(
    (text: string) => {
      update({ reasoning: text });
    },
    [update],
  );

  const setPlan = useCallback(
    (tasks: AgentTask[]) => {
      update({ phase: "executing", tasks, thinkingLine: "", collapsed: false });
    },
    [update],
  );

  const setCollapsed = useCallback(
    (value: boolean) => {
      update({ collapsed: value });
    },
    [update],
  );

  const startTask = useCallback(
    (taskId: string, detail?: string) => {
      setProgress((prev) => {
        const tasks = prev.tasks.map((t) => {
          if (t.id === taskId) {
            return {
              ...t,
              status: "in_progress" as const,
              startedAt: Date.now(),
              detail: detail ?? t.detail,
            };
          }
          if (t.status === "in_progress") {
            return {
              ...t,
              status: "completed" as const,
              completedAt: Date.now(),
            };
          }
          return t;
        });
        const next = { ...prev, tasks, currentTaskId: taskId, collapsed: false };
        progressRef.current = next;
        return next;
      });
    },
    [],
  );

  const completeTask = useCallback(
    (taskId: string) => {
      updateTask(taskId, {
        status: "completed",
        completedAt: Date.now(),
        progress: 100,
      });
    },
    [updateTask],
  );

  const failTask = useCallback(
    (taskId: string, error: string) => {
      updateTask(taskId, {
        status: "failed",
        completedAt: Date.now(),
        error,
      });
    },
    [updateTask],
  );

  const updateTaskProgress = useCallback(
    (taskId: string, progressValue: number, detail?: string) => {
      const patch: Partial<AgentTask> = { progress: progressValue };
      if (detail !== undefined) patch.detail = detail;
      updateTask(taskId, patch);
    },
    [updateTask],
  );

  const addAdHocTask = useCallback((task: AgentTask) => {
    setProgress((prev) => {
      const next = { ...prev, tasks: [...prev.tasks, task] };
      progressRef.current = next;
      return next;
    });
  }, []);

  const incrementTurn = useCallback(() => {
    setProgress((prev) => {
      const next = { ...prev, turnCount: prev.turnCount + 1 };
      progressRef.current = next;
      return next;
    });
  }, []);

  const endSession = useCallback((error?: string) => {
    setProgress((prev) => {
      const tasks = (prev.tasks ?? []).map((t) =>
        t.status === "in_progress"
          ? { ...t, status: "completed" as const, completedAt: Date.now() }
          : t,
      );
      const next: AgentProgress = {
        ...prev,
        tasks,
        phase: error ? "error" : "done",
        currentTaskId: null,
        completedAt: Date.now(),
        error,
      };
      progressRef.current = next;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    progressRef.current = INITIAL_PROGRESS;
    setProgress(INITIAL_PROGRESS);
  }, []);

  return {
    progress,
    progressRef,
    update,
    updateTask,
    startSession,
    setThinking,
    setReasoning,
    setPlan,
    setCollapsed,
    startTask,
    completeTask,
    failTask,
    updateTaskProgress,
    addAdHocTask,
    incrementTurn,
    endSession,
    reset,
  };
}
