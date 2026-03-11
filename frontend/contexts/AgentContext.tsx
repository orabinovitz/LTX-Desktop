import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent, type ChatMessage, type OnToolProgress } from "../hooks/use-agent";
import type { AgentProgress } from "../types/agent-progress";
import type { ToolCall, ToolResult } from "../views/editor/useAgentExecutor";
import type { TimelineClip, ProjectTab } from "../types/project";
import { useProjects } from "./ProjectContext";

export type ViewContext = "editor" | "genspace" | "playground";

export interface AgentViewExecutor {
  viewContext: ViewContext;
  executeTool: (toolCall: ToolCall, onProgress?: OnToolProgress) => Promise<ToolResult>;
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
  progress: AgentProgress;
  setCollapsed: (value: boolean) => void;
  sendAgentPrompt: (prompt: string) => void;
  clearChat: () => void;
  registerExecutor: (executor: AgentViewExecutor) => void;
  unregisterExecutor: (viewContext: ViewContext) => void;
  activeExecutor: AgentViewExecutor | null;
}

const AgentContext = createContext<AgentContextValue | null>(null);

const VALID_TABS = new Set<ProjectTab>(["gen-space", "video-editor"]);

function waitForExecutorSwitch(
  executorRef: React.MutableRefObject<AgentViewExecutor | null>,
  targetView: ViewContext,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (executorRef.current?.viewContext === targetView) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 20);
    };
    setTimeout(check, 30);
  });
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [agentOpen, setAgentOpen] = useState(false);
  const { messages, isProcessing, sendPrompt, clearChat, progress, setCollapsed } =
    useAgent();
  const executorRef = useRef<AgentViewExecutor | null>(null);
  const { setCurrentTab } = useProjects();
  const setCurrentTabRef = useRef(setCurrentTab);
  setCurrentTabRef.current = setCurrentTab;

  const registerExecutor = useCallback((executor: AgentViewExecutor) => {
    executorRef.current = executor;
  }, []);

  const unregisterExecutor = useCallback((viewContext: ViewContext) => {
    if (executorRef.current?.viewContext === viewContext) {
      executorRef.current = null;
    }
  }, []);

  const handleSwitchView = useCallback(
    async (tc: ToolCall): Promise<ToolResult> => {
      const targetView = tc.arguments?.target_view as string | undefined;
      if (!targetView || !VALID_TABS.has(targetView as ProjectTab)) {
        return {
          tool_name: tc.tool_name,
          success: false,
          result: null,
          error: `Invalid target_view: "${targetView}". Must be "gen-space" or "video-editor".`,
        };
      }
      setCurrentTabRef.current(targetView as ProjectTab);
      const expectedExecutor: ViewContext =
        targetView === "video-editor" ? "editor" : "genspace";
      const switched = await waitForExecutorSwitch(executorRef, expectedExecutor);
      return {
        tool_name: tc.tool_name,
        success: switched,
        result: switched
          ? { switched_to: targetView, view_context: expectedExecutor }
          : null,
        error: switched ? null : `Timed out waiting for ${targetView} executor to register.`,
      };
    },
    [],
  );

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

      const baseExecuteTool = executor?.executeTool ?? noopExecuteTool;

      const wrappedExecuteTool = async (
        tc: ToolCall,
        onProgress?: OnToolProgress,
      ): Promise<ToolResult> => {
        if (tc.tool_name === "switch_view") {
          return handleSwitchView(tc);
        }
        const currentExecutor = executorRef.current;
        if (currentExecutor) {
          return currentExecutor.executeTool(tc, onProgress);
        }
        return baseExecuteTool(tc, onProgress);
      };

      const viewCtx = executor?.getViewContext?.() ?? null;

      sendPrompt(
        prompt,
        timelineState?.clips ?? [],
        timelineState?.trackCount ?? 0,
        timelineState?.currentTime ?? 0,
        wrappedExecuteTool,
        executor?.projectId ?? null,
        executor?.viewContext,
        viewCtx,
      );
    },
    [sendPrompt, handleSwitchView],
  );

  const value = useMemo<AgentContextValue>(
    () => ({
      agentOpen,
      setAgentOpen,
      messages,
      isProcessing,
      progress,
      setCollapsed,
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
      progress,
      setCollapsed,
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
