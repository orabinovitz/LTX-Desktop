import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent, type ChatMessage, type OnToolProgress, type AgentMessage } from "@/hooks/use-agent";
import { useOrchestratedAgent } from "@/hooks/use-orchestrated-agent";
import type { AgentProgress } from "@/types/agent-progress";
import type { ToolCall, ToolResult } from "@/types/agent-progress";
import type { TimelineClip, ProjectTab } from "@/types/project";
import type {
  ClarificationAnswer,
  ClarificationState,
  ClarifyResponse,
} from "@/types/clarification";
import { useProjects } from "./ProjectContext";
import { logger } from "@/lib/logger";
import { backendFetch } from "@/lib/backend";

type ViewContext = "editor" | "genspace" | "playground";

export interface AgentViewExecutor {
  viewContext: ViewContext;
  executeTool: (toolCall: ToolCall, onProgress?: OnToolProgress, signal?: AbortSignal) => Promise<ToolResult>;
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
  stopAgent: () => void;
  skipTask: (taskId: string) => void;
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

interface IntentResolution {
  grounded_prompt: string;
  complexity: "simple" | "orchestrated";
  relevant_memory_ids: string[];
  intent_summary: string;
  requires_generation: boolean;
}

async function resolveIntent(
  prompt: string,
  projectId: string | null,
  viewContext?: string,
  conversationHistory?: AgentMessage[],
  assetsContext?: Record<string, unknown> | null,
): Promise<IntentResolution> {
  try {
    const body: Record<string, unknown> = { prompt };
    if (projectId) body.project_id = projectId;
    if (viewContext) body.view_context = viewContext;
    if (assetsContext) body.assets_context = assetsContext;
    if (conversationHistory && conversationHistory.length > 0) {
      body.conversation_history = conversationHistory.slice(-10);
    }

    const res = await backendFetch("/api/agent/resolve-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data: IntentResolution = await res.json();
      return {
        grounded_prompt: data.grounded_prompt || prompt,
        complexity: data.complexity === "orchestrated" ? "orchestrated" : "simple",
        relevant_memory_ids: data.relevant_memory_ids ?? [],
        intent_summary: data.intent_summary ?? "",
        requires_generation: data.requires_generation ?? false,
      };
    }
  } catch {
    logger.warn("[agent-context] intent resolution failed, using raw prompt");
  }
  return {
    grounded_prompt: prompt,
    complexity: "simple",
    relevant_memory_ids: [],
    intent_summary: "",
    requires_generation: false,
  };
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
      signal?: AbortSignal,
    ): Promise<ToolResult> => {
      if (tc.tool_name === "switch_view") {
        return handleSwitchView(tc);
      }
      const currentExecutor = executorRef.current;
      if (currentExecutor) {
        return currentExecutor.executeTool(tc, onProgress, signal);
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
      originalPrompt?: string,
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
          originalPrompt,
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
          originalPrompt,
        );
      }
    },
    [simpleAgent, orchestratedAgent],
  );

  const sendAgentPrompt = useCallback(
    async (prompt: string) => {
      setClarificationState(null);
      const ctx = getExecutorContext();

      // Show the user message immediately so the UI feels responsive.
      // The active agent is "simple" by default; we add a placeholder
      // message and a processing indicator while intent resolution runs.
      simpleAgent.setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      simpleAgent.setIsProcessing(true);

      const allMessages = [
        ...simpleAgent.messages,
        ...orchestratedAgent.messages,
      ];
      const conversationHistory = chatMessagesToConversationHistory(allMessages);

      const intent = await resolveIntent(
        prompt,
        ctx.executor?.projectId ?? null,
        ctx.executor?.viewContext,
        conversationHistory,
        ctx.viewCtx as Record<string, unknown> | null,
      );

      logger.info(
        `[agent-context] intent resolved: complexity=${intent.complexity}, summary="${intent.intent_summary}"`,
      );

      const groundedPrompt = intent.grounded_prompt;

      // Remove the optimistic user message before handing off to the
      // actual agent hook, which adds its own copy.
      simpleAgent.setMessages((prev) => prev.slice(0, -1));
      simpleAgent.setIsProcessing(false);

      if (intent.complexity === "orchestrated") {
        logger.info("[agent-context] orchestrated request — checking if clarification needed");

        orchestratedAgent.setMessages((prev) => [...prev, { role: "user", content: prompt }]);
        setActiveMode("orchestrated");

        const clarification = await fetchClarification(
          groundedPrompt,
          ctx.timelineState ?? null,
          ctx.executor?.projectId ?? null,
          ctx.executor?.viewContext,
          ctx.viewCtx as Record<string, unknown> | null,
        );

        if (clarification) {
          logger.info(`[agent-context] clarification needed — ${clarification.questions.length} questions`);
          setClarificationState({
            questions: clarification.questions,
            originalPrompt: groundedPrompt,
            displayPrompt: prompt,
          });
          return;
        }

        logger.info("[agent-context] no clarification needed — executing directly");
        orchestratedAgent.setMessages([]);
        executePrompt(groundedPrompt, intent.complexity, ctx, prompt);
      } else {
        executePrompt(groundedPrompt, intent.complexity, ctx, prompt);
      }
    },
    [getExecutorContext, executePrompt, simpleAgent, orchestratedAgent],
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

      const displayPrompt = clarificationState.displayPrompt;
      setClarificationState(null);
      orchestratedAgent.setMessages([]);
      executePrompt(enrichedPrompt, "orchestrated", ctx, displayPrompt);
    },
    [clarificationState, getExecutorContext, executePrompt, orchestratedAgent],
  );

  const clearChat = useCallback(() => {
    simpleAgent.clearChat();
    orchestratedAgent.clearChat();
    setClarificationState(null);
    setActiveMode("simple");
  }, [simpleAgent, orchestratedAgent]);

  const stopAgent = useCallback(() => {
    orchestratedAgent.stop();
  }, [orchestratedAgent]);

  const skipTask = useCallback(
    (taskId: string) => {
      orchestratedAgent.skipTask(taskId);
    },
    [orchestratedAgent],
  );

  const dispatch = useMemo<AgentDispatchValue>(
    () => ({
      setAgentOpen,
      sendAgentPrompt,
      submitClarification,
      clearChat,
      registerExecutor,
      unregisterExecutor,
      stopAgent,
      skipTask,
    }),
    [setAgentOpen, sendAgentPrompt, submitClarification, clearChat, registerExecutor, unregisterExecutor, stopAgent, skipTask],
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
