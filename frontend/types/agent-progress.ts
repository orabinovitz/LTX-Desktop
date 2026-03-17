export interface ToolCall {
  tool_name: string;
  arguments: Record<string, unknown>;
  call_id?: string;
}

export interface ToolResult {
  tool_name: string;
  success: boolean;
  result: unknown;
  error: string | null;
  call_id?: string;
}

export interface ChatMessage {
  role: "user" | "agent";
  content: string;
  toolCalls?: ToolCall[];
  isExecuting?: boolean;
}

export type OnToolProgress = (progress: number, detail?: string) => void;

export interface AgentTask {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  subtasks?: AgentTask[];
  progress?: number;
  detail?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  skillId?: string;
  skillName?: string;
  dependsOn?: string[];
  activeToolCalls?: string[];
}

export type OrchestratorStatus = "planning" | "executing" | "awaiting_tool_results" | "reviewing" | "done" | "error";

export interface AgentProgress {
  phase: "idle" | "thinking" | "planning" | "executing" | "done" | "error";
  thinkingLine: string;
  reasoning: string;
  tasks: AgentTask[];
  currentTaskId: string | null;
  turnCount: number;
  startedAt: number;
  completedAt?: number;
  collapsed: boolean;
  error?: string;
  isOrchestrated?: boolean;
  orchestratorStatus?: OrchestratorStatus;
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
  isOrchestrated: false,
};

// Types matching the backend OrchestrateResponse

export interface OrchestrateTaskInfo {
  id: string;
  description: string;
  skill_id: string | null;
  skill_name: string | null;
  depends_on: string[];
  status: string;
  error: string | null;
}

export interface OrchestrateResponse {
  session_id: string;
  status: string;
  tasks: OrchestrateTaskInfo[];
  current_task_id: string | null;
  tool_calls: Array<{ tool_name: string; arguments: Record<string, unknown>; call_id?: string }>;
  message: string;
  done: boolean;
  memory_updated?: boolean;
}
