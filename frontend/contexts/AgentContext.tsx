import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent, type ChatMessage } from "../hooks/use-agent";
import type { ToolCall, ToolResult } from "../views/editor/useAgentExecutor";
import type { TimelineClip } from "../types/project";

export type ViewContext = "editor" | "genspace" | "playground";

export interface AgentViewExecutor {
  viewContext: ViewContext;
  executeTool: (toolCall: ToolCall) => Promise<ToolResult>;
  getTimelineState: () => {
    clips: TimelineClip[];
    trackCount: number;
    currentTime: number;
  } | null;
  getViewContext?: () => Record<string, unknown> | null;
  projectId: string | null;
  canUndo: boolean;
  onUndo: () => void;
}

interface AgentContextValue {
  agentOpen: boolean;
  setAgentOpen: React.Dispatch<React.SetStateAction<boolean>>;
  messages: ChatMessage[];
  isProcessing: boolean;
  sendAgentPrompt: (prompt: string) => void;
  clearChat: () => void;
  registerExecutor: (executor: AgentViewExecutor) => void;
  unregisterExecutor: (viewContext: ViewContext) => void;
  activeExecutor: AgentViewExecutor | null;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [agentOpen, setAgentOpen] = useState(false);
  const { messages, isProcessing, sendPrompt, clearChat } = useAgent();
  const executorRef = useRef<AgentViewExecutor | null>(null);

  const registerExecutor = useCallback((executor: AgentViewExecutor) => {
    executorRef.current = executor;
  }, []);

  const unregisterExecutor = useCallback((viewContext: ViewContext) => {
    if (executorRef.current?.viewContext === viewContext) {
      executorRef.current = null;
    }
  }, []);

  const sendAgentPrompt = useCallback(
    (prompt: string) => {
      const executor = executorRef.current;
      const timelineState = executor?.getTimelineState();
      const noopExecuteTool = async (tc: ToolCall): Promise<ToolResult> => ({
        tool_name: tc.tool_name,
        success: false,
        error: "No view executor registered. Open a project to use editing tools.",
        result: null,
      });

      const viewCtx = executor?.getViewContext?.() ?? null;

      sendPrompt(
        prompt,
        timelineState?.clips ?? [],
        timelineState?.trackCount ?? 0,
        timelineState?.currentTime ?? 0,
        executor?.executeTool ?? noopExecuteTool,
        executor?.projectId ?? null,
        executor?.viewContext,
        viewCtx,
      );
    },
    [sendPrompt],
  );

  const value = useMemo<AgentContextValue>(
    () => ({
      agentOpen,
      setAgentOpen,
      messages,
      isProcessing,
      sendAgentPrompt,
      clearChat,
      registerExecutor,
      unregisterExecutor,
      activeExecutor: executorRef.current,
    }),
    [
      agentOpen,
      messages,
      isProcessing,
      sendAgentPrompt,
      clearChat,
      registerExecutor,
      unregisterExecutor,
    ],
  );

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgentContext must be used within an AgentProvider");
  }
  return ctx;
}
