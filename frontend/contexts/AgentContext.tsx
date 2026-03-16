import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent, type ChatMessage, type OnToolProgress, type AgentMessage } from "../hooks/use-agent";
import { useOrchestratedAgent } from "../hooks/use-orchestrated-agent";
import type { AgentProgress } from "../types/agent-progress";
import type { ToolCall, ToolResult } from "../views/editor/useAgentExecutor";
import type { TimelineClip, ProjectTab } from "../types/project";
import type {
  ClarificationAnswer,
  ClarificationState,
  ClarifyResponse,
} from "../types/clarification";
import { useProjects } from "./ProjectContext";
import { logger } from "../lib/logger";
import { backendFetch } from "../lib/backend";

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
  submitClarification: (answers: ClarificationAnswer[]) => void;
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
  clarificationState: ClarificationState | null;
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
    const res = await backendFetch(
      `/api/agent/classify-complexity?prompt=${encodeURIComponent(prompt)}`,
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

async function fetchClarification(
  prompt: string,
  timelineState: { clips: TimelineClip[]; trackCount: number; currentTime: number } | null,
  projectId: string | null,
  viewContext?: string,
  assetsContext?: Record<string, unknown> | null,
): Promise<ClarifyResponse | null> {
  try {
    const body: Record<string, unknown> = { prompt };
    if (timelineState && timelineState.clips.length > 0) {
      body.timeline_state = {
        clips: timelineState.clips.map((c) => ({
          id: c.id,
          asset_id: c.assetId,
          type: c.type,
          start_time: c.startTime,
          duration: c.duration,
          trim_start: c.trimStart,
          trim_end: c.trimEnd,
          track_index: c.trackIndex,
          speed: c.speed,
          linked_clip_ids: c.linkedClipIds ?? [],
          volume: c.volume,
          muted: c.muted,
        })),
        track_count: timelineState.trackCount,
        total_duration: timelineState.clips.reduce(
          (max, c) => Math.max(max, c.startTime + c.duration),
          0,
        ),
        playhead_time: timelineState.currentTime,
      };
    }
    if (projectId) body.project_id = projectId;
    if (viewContext) body.view_context = viewContext;
    if (assetsContext) body.assets_context = assetsContext;

    const res = await backendFetch("/api/agent/clarify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data: ClarifyResponse = await res.json();
      if (data.needs_clarification && data.questions.length > 0) {
        return data;
      }
    }
  } catch {
    logger.warn("[agent-context] clarification fetch failed, proceeding without");
  }
  return null;
}

function formatClarificationContext(
  questions: ClarificationState["questions"],
  answers: ClarificationAnswer[],
): string {
  const answerMap = new Map(answers.map((a) => [a.question_id, a]));
  const lines: string[] = ["User clarifications:"];
  for (const q of questions) {
    const answer = answerMap.get(q.id);
    if (!answer || answer.skipped) {
      lines.push(`- ${q.question}: [Skipped]`);
      continue;
    }
    if (answer.custom_answer) {
      lines.push(`- ${q.question}: ${answer.custom_answer}`);
    } else if (answer.selected_option_id) {
      const opt = q.options.find((o) => o.id === answer.selected_option_id);
      lines.push(`- ${q.question}: ${opt?.label ?? answer.selected_option_id}`);
    } else {
      lines.push(`- ${q.question}: [Skipped]`);
    }
  }
  return lines.join("\n");
}

function chatMessagesToConversationHistory(messages: ChatMessage[]): AgentMessage[] {
  return messages
    .filter((m) => m.content)
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [agentOpen, setAgentOpen] = useState(false);

  const simpleAgent = useAgent();
  const orchestratedAgent = useOrchestratedAgent();

  const [activeMode, setActiveMode] = useState<"simple" | "orchestrated">("simple");
  const [clarificationState, setClarificationState] = useState<ClarificationState | null>(null);

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

  const getExecutorContext = useCallback(() => {
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

    return {
      executor,
      timelineState,
      wrappedExecuteTool,
      viewCtx: executor?.getViewContext?.() ?? null,
    };
  }, [handleSwitchView]);

  const executePrompt = useCallback(
    (
      prompt: string,
      complexity: "simple" | "orchestrated",
      ctx: ReturnType<typeof getExecutorContext>,
    ) => {
      setActiveMode(complexity);
      const { executor, timelineState, wrappedExecuteTool, viewCtx } = ctx;

      if (complexity === "simple") {
        const priorHistory = chatMessagesToConversationHistory(
          orchestratedAgent.messages,
        );
        simpleAgent.sendPrompt(
          prompt,
          timelineState?.clips ?? [],
          timelineState?.trackCount ?? 0,
          timelineState?.currentTime ?? 0,
          wrappedExecuteTool,
          executor?.projectId ?? null,
          executor?.viewContext,
          viewCtx,
          priorHistory.length > 0 ? priorHistory : undefined,
        );
      } else {
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
      }
    },
    [simpleAgent, orchestratedAgent],
  );

  const sendAgentPrompt = useCallback(
    async (prompt: string) => {
      setClarificationState(null);
      const ctx = getExecutorContext();

      const complexity = await classifyComplexity(prompt);

      if (complexity === "orchestrated") {
        logger.info("[agent-context] orchestrated request — checking if clarification needed");

        orchestratedAgent.setMessages((prev) => [...prev, { role: "user", content: prompt }]);
        setActiveMode("orchestrated");

        const clarification = await fetchClarification(
          prompt,
          ctx.timelineState ?? null,
          ctx.executor?.projectId ?? null,
          ctx.executor?.viewContext,
          ctx.viewCtx as Record<string, unknown> | null,
        );

        if (clarification) {
          logger.info(`[agent-context] clarification needed — ${clarification.questions.length} questions`);
          setClarificationState({
            questions: clarification.questions,
            originalPrompt: prompt,
          });
          return;
        }

        logger.info("[agent-context] no clarification needed — executing directly");
        orchestratedAgent.setMessages([]);
        executePrompt(prompt, complexity, ctx);
      } else {
        executePrompt(prompt, complexity, ctx);
      }
    },
    [getExecutorContext, executePrompt, orchestratedAgent],
  );

  const submitClarification = useCallback(
    (answers: ClarificationAnswer[]) => {
      if (!clarificationState) return;

      const ctx = getExecutorContext();
      const allSkipped = answers.every((a) => a.skipped);

      let enrichedPrompt = clarificationState.originalPrompt;
      if (!allSkipped) {
        const clarificationContext = formatClarificationContext(
          clarificationState.questions,
          answers,
        );
        enrichedPrompt = `${clarificationState.originalPrompt}\n\n${clarificationContext}`;
      }

      setClarificationState(null);
      orchestratedAgent.setMessages([]);
      executePrompt(enrichedPrompt, "orchestrated", ctx);
    },
    [clarificationState, getExecutorContext, executePrompt, orchestratedAgent],
  );

  const clearChat = useCallback(() => {
    simpleAgent.clearChat();
    orchestratedAgent.clearChat();
    setClarificationState(null);
    setActiveMode("simple");
  }, [simpleAgent, orchestratedAgent]);

  const dispatch = useMemo<AgentDispatchValue>(
    () => ({
      setAgentOpen,
      sendAgentPrompt,
      submitClarification,
      clearChat,
      registerExecutor,
      unregisterExecutor,
    }),
    [setAgentOpen, sendAgentPrompt, submitClarification, clearChat, registerExecutor, unregisterExecutor],
  );

  const state = useMemo<AgentStateValue>(
    () => ({
      agentOpen,
      messages: activeAgent.messages,
      isProcessing: activeAgent.isProcessing,
      progress: activeAgent.progress,
      setCollapsed: activeAgent.setCollapsed,
      activeExecutor: executorRef.current,
      clarificationState,
    }),
    [agentOpen, activeAgent.messages, activeAgent.isProcessing, activeAgent.progress, activeAgent.setCollapsed, clarificationState],
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
