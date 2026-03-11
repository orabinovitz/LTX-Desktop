export interface AgentTask {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  subtasks?: AgentTask[];
  progress?: number;
  detail?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AgentProgress {
  phase: "idle" | "thinking" | "planning" | "executing" | "done" | "error";
  thinkingLine: string;
  reasoning: string;
  tasks: AgentTask[];
  currentTaskId: string | null;
  turnCount: number;
  startedAt: number;
  collapsed: boolean;
  error?: string;
}

export const INITIAL_PROGRESS: AgentProgress = {
  phase: "idle",
  thinkingLine: "",
  reasoning: "",
  tasks: [],
  currentTaskId: null,
  turnCount: 0,
  startedAt: 0,
  collapsed: true,
};
