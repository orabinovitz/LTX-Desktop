import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent, type ChatMessage, type OnToolProgress } from "../hooks/use-agent";
import { useOrchestratedAgent } from "../hooks/use-orchestrated-agent";
import type { AgentProgress } from "../types/agent-progress";
import type { ToolCall, ToolResult } from "../views/editor/useAgentExecutor";
import type { TimelineClip, ProjectTab } from "../types/project";
import { useProjects } from "./ProjectContext";
import { logger } from "../lib/logger";

type ViewContext = "editor" | "genspace" | "playground";

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

interface AgentDispatchValue {
  setAgentOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sendAgentPrompt: (prompt: string) => void;
  clearChat: () => void;
  registerExecutor: (executor: AgentViewExecutor) => void;
  unregisterExecutor: (viewContext: ViewContext) => void;
}

interface AgentStateValue {
  agentOpen: boolean;
  messages: ChatMessage[];
  isProcessing: boolean;
  progress: AgentProgress;
  setCollapsed: (value: boolean) => void;
  activeExecutor: AgentViewExecutor | null;
}

const AgentDispatchContext = createContext<AgentDispatchValue | null>(null);
const AgentStateContext = createContext<AgentStateValue | null>(null);

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

async function classifyComplexity(
  prompt: string,
): Promise<"simple" | "orchestrated"> {
  try {
    const backendUrl = await window.electronAPI.getBackendUrl();
    const res = await fetch(
      `${backendUrl}/api/agent/classify-complexity?prompt=${encodeURIComponent(prompt)}`,
    );
    if (res.ok) {
      const data = await res.json();
      return data.complexity === "orchestrated" ? "orchestrated" : "simple";
    }
  } catch {
    logger.warn("[agent-context] complexity classification failed, defaulting to simple");
  }
  return "simple";
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [agentOpen, setAgentOpen] = useState(false);

  const simpleAgent = useAgent();
  const orchestratedAgent = useOrchestratedAgent();

  const [activeMode, setActiveMode] = useState<"simple" | "orchestrated">("simple");

  const activeAgent = activeMode === "orchestrated" ? orchestratedAgent : simpleAgent;

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
    async (prompt: string) => {
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

      const complexity = await classifyComplexity(prompt);
      setActiveMode(complexity);

      if (complexity === "orchestrated") {
        logger.info("[agent-context] routing to orchestrated agent");
        orchestratedAgent.sendPrompt(
          prompt,
          timelineState?.clips ?? [],
          timelineState?.trackCount ?? 0,
          timelineState?.currentTime ?? 0,
          wrappedExecuteTool,
          executor?.projectId ?? null,
          executor?.viewContext,
          viewCtx,
        );
      } else {
        simpleAgent.sendPrompt(
          prompt,
          timelineState?.clips ?? [],
          timelineState?.trackCount ?? 0,
          timelineState?.currentTime ?? 0,
          wrappedExecuteTool,
          executor?.projectId ?? null,
          executor?.viewContext,
          viewCtx,
        );
      }
    },
    [simpleAgent, orchestratedAgent, handleSwitchView],
  );

  const clearChat = useCallback(() => {
    simpleAgent.clearChat();
    orchestratedAgent.clearChat();
    setActiveMode("simple");
  }, [simpleAgent, orchestratedAgent]);

  const dispatch = useMemo<AgentDispatchValue>(
    () => ({
      setAgentOpen,
      sendAgentPrompt,
      clearChat,
      registerExecutor,
      unregisterExecutor,
    }),
    [setAgentOpen, sendAgentPrompt, clearChat, registerExecutor, unregisterExecutor],
  );

  const state = useMemo<AgentStateValue>(
    () => ({
      agentOpen,
      messages: activeAgent.messages,
      isProcessing: activeAgent.isProcessing,
      progress: activeAgent.progress,
      setCollapsed: activeAgent.setCollapsed,
      activeExecutor: executorRef.current,
    }),
    [agentOpen, activeAgent.messages, activeAgent.isProcessing, activeAgent.progress, activeAgent.setCollapsed],
  );

  return (
    <AgentDispatchContext.Provider value={dispatch}>
      <AgentStateContext.Provider value={state}>{children}</AgentStateContext.Provider>
    </AgentDispatchContext.Provider>
  );
}

export function useAgentDispatch(): AgentDispatchValue {
  const ctx = useContext(AgentDispatchContext);
  if (!ctx) {
    throw new Error("useAgentDispatch must be used within an AgentProvider");
  }
  return ctx;
}

export function useAgentState(): AgentStateValue {
  const ctx = useContext(AgentStateContext);
  if (!ctx) {
    throw new Error("useAgentState must be used within an AgentProvider");
  }
  return ctx;
}

export function useAgentContext(): AgentDispatchValue & AgentStateValue {
  return { ...useAgentDispatch(), ...useAgentState() };
}
