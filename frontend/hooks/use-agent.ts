import { useCallback, useRef, useState } from "react";

import {
  backendFetch,
  backendSSE,
  createBackendRequestContext,
  createTraceId,
} from "@/lib/backend";
import {
  clearRendererLogContext,
  logger,
  setRendererLogContext,
  updateRendererLogContext,
} from "@/lib/logger";
import {
  groupToolCalls,
  mapGroupsToTasks,
  parsePlanToTasks,
  resetTaskIdCounter,
} from "@/lib/parse-plan";
import type {
  AgentDiagnostics,
  ToolCall,
  ToolResult,
} from "@/types/agent-progress";
import type { AgentProgress, AgentTask, ChatMessage, OnToolProgress } from "@/types/agent-progress";
import type { TimelineClip } from "@/types/project";

import { useAgentProgress } from "./use-agent-progress";

export type { ToolCall };
export type { AgentProgress };
export type { ChatMessage, OnToolProgress };

const PARALLEL_SAFE_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "get_project_assets",
  "get_generation_status",
  "get_video_metadata",
  "cancel_generation",
  "delete_asset",
  "batch_delete_assets",
  "toggle_favorite",
]);

// --- Types matching backend Pydantic models ---

interface TimelineClipInfo {
  id: string;
  asset_id: string | null;
  type: string;
  start_time: number;
  duration: number;
  trim_start: number;
  trim_end: number;
  track_index: number;
  speed: number;
  reversed: boolean;
  linked_clip_ids: string[];
  volume: number;
  muted: boolean;
  flip_h: boolean;
  flip_v: boolean;
  opacity: number;
  color_correction: Record<string, number>;
  transition_in: { type: string; duration: number };
  transition_out: { type: string; duration: number };
  effect_count: number;
  has_text_overlay: boolean;
}

interface TimelineState {
  clips: TimelineClipInfo[];
  track_count: number;
  total_duration: number;
  playhead_time: number;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

interface AgentResponse {
  plan: string;
  tool_calls: ToolCall[];
  message: string;
  done: boolean;
  session_id: string;
  memory_updated?: boolean;
  diagnostics?: AgentDiagnostics | null;
}

interface ExecuteToolFn {
  (toolCall: ToolCall, onProgress?: OnToolProgress): Promise<ToolResult>;
}

function logDiagnostics(prefix: string, diagnostics?: AgentDiagnostics | null) {
  if (!diagnostics) return;
  const parts = [
    `stage=${diagnostics.stage_name || "unknown"}`,
    `model=${diagnostics.selected_model || "unknown"}`,
  ];
  if (typeof diagnostics.llm_ms === "number") parts.push(`llm_ms=${diagnostics.llm_ms}`);
  if (typeof diagnostics.planning_ms === "number") parts.push(`planning_ms=${diagnostics.planning_ms}`);
  if (diagnostics.used_fallback_model) parts.push("fallback=true");
  logger.info(`[${prefix}] diagnostics — ${parts.join(", ")}`);
}

// --- Helper to build timeline state from React state ---

function buildTimelineState(
  clips: TimelineClip[],
  trackCount: number,
  currentTime: number,
): TimelineState {
  const clipInfos: TimelineClipInfo[] = clips.map((c) => ({
    id: c.id,
    asset_id: c.assetId,
    type: c.type,
    start_time: c.startTime,
    duration: c.duration,
    trim_start: c.trimStart,
    trim_end: c.trimEnd,
    track_index: c.trackIndex,
    speed: c.speed,
    reversed: c.reversed,
    linked_clip_ids: c.linkedClipIds ?? [],
    volume: c.volume,
    muted: c.muted,
    flip_h: c.flipH,
    flip_v: c.flipV,
    opacity: c.opacity,
    color_correction: { ...c.colorCorrection },
    transition_in: { ...c.transitionIn },
    transition_out: { ...c.transitionOut },
    effect_count: c.effects?.length ?? 0,
    has_text_overlay: Boolean(c.textStyle),
  }));

  const totalDuration = clips.reduce(
    (max, c) => Math.max(max, c.startTime + c.duration),
    0,
  );

  return {
    clips: clipInfos,
    track_count: trackCount,
    total_duration: totalDuration,
    playhead_time: currentTime,
  };
}

// --- Standalone function: trigger background video analysis on import ---

export async function triggerVideoAnalysis(
  assetId: string,
  filePath: string,
  projectSavePath?: string,
  force?: boolean,
): Promise<boolean> {
  try {
    const res = await backendFetch("/api/agent/analyze-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_id: assetId,
        file_path: filePath,
        ...(projectSavePath ? { project_save_path: projectSavePath } : {}),
        ...(force ? { force: true } : {}),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.status === "analyzing";
    }
  } catch {
    // Analysis is best-effort; failure is non-fatal
  }
  return false;
}

// --- Main hook ---

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const traceIdRef = useRef<string | null>(null);
  const rendererLogContextIdRef = useRef<string | null>(null);
  const conversationRef = useRef<AgentMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const progressActions = useAgentProgress();
  const { progress } = progressActions;
  const progressActionsRef = useRef(progressActions);
  progressActionsRef.current = progressActions;

  const sendPrompt = useCallback(
    async (
      prompt: string,
      clips: TimelineClip[],
      trackCount: number,
      currentTime: number,
      executeTool: ExecuteToolFn,
      projectId?: string | null,
      viewContext?: "editor" | "genspace" | "playground",
      assetsContext?: Record<string, unknown> | null,
      externalConversationHistory?: AgentMessage[],
      displayPrompt?: string,
      providedTraceId?: string,
    ) => {
      setIsProcessing(true);
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;
      const activeTraceId = providedTraceId ?? createTraceId();
      traceIdRef.current = activeTraceId;
      const rendererLogContextId = setRendererLogContext({ traceId: activeTraceId });
      rendererLogContextIdRef.current = rendererLogContextId;

      resetTaskIdCounter();
      const pa = progressActionsRef.current;
      pa.startSession();

      setMessages((prev) => [...prev, { role: "user", content: displayPrompt ?? prompt }]);
      conversationRef.current.push({ role: "user", content: prompt });

      const t0 = performance.now();
      logger.info(
        `[agent] session start (prompt_chars=${prompt.length})`,
        {
          category: "agent.session",
          traceId: activeTraceId,
        },
      );

      try {
        const timelineState = buildTimelineState(
          clips,
          trackCount,
          currentTime,
        );
        pa.setThinking("Sending request to AI...");

        const effectiveHistory = externalConversationHistory
          ? [...externalConversationHistory, ...conversationRef.current]
          : conversationRef.current;

        const requestBody = JSON.stringify({
          prompt,
          ...(clips.length > 0 ? { timeline_state: timelineState } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(viewContext ? { view_context: viewContext } : {}),
          ...(assetsContext ? { assets_context: assetsContext } : {}),
          ...(sessionIdRef.current
            ? { session_id: sessionIdRef.current }
            : { conversation_history: effectiveHistory }),
        });

        let response: AgentResponse;
        try {
          // Use SSE streaming for real-time status during the Gemini call
          let sseResult: AgentResponse | null = null;
          const executeRequest = createBackendRequestContext(activeTraceId);
          for await (const event of backendSSE("/api/agent/execute/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal,
          }, executeRequest)) {
            if (event.event === "thinking") {
              logger.debug("[agent] SSE: thinking event received", {
                category: "agent.api",
                traceId: activeTraceId,
              });
              pa.setThinking("AI is thinking...");
            } else if (event.event === "result") {
              sseResult = event.data as AgentResponse;
              logger.debug(`[agent] SSE: result received — done=${sseResult.done}, tools=${sseResult.tool_calls.length}`, {
                category: "agent.api",
                traceId: activeTraceId,
              });
            } else if (event.event === "error") {
              const err = event.data as { message?: string };
              throw new Error(err.message ?? "Agent streaming error");
            }
          }
          if (!sseResult) throw new Error("No result from SSE stream");
          response = sseResult;
        } catch (sseErr) {
          if (sseErr instanceof DOMException && sseErr.name === "AbortError") throw sseErr;
          // Fallback to regular endpoint if SSE fails
          logger.warn(`[agent] SSE failed, falling back to regular endpoint: ${sseErr instanceof Error ? sseErr.message : sseErr}`, {
            category: "agent.api",
            traceId: activeTraceId,
          });
          const executeRequest = createBackendRequestContext(activeTraceId);
          const res = await backendFetch("/api/agent/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal,
          }, executeRequest);
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Agent API error: ${res.status}`);
          }
          response = await res.json();
        }

        logDiagnostics("agent", response.diagnostics);
        if (response.session_id) {
          sessionIdRef.current = response.session_id;
          updateRendererLogContext(rendererLogContextId, {
            traceId: activeTraceId,
            agentSessionId: response.session_id,
          });
        }
        if (response.memory_updated) {
          window.dispatchEvent(new CustomEvent('memory-updated'));
        }

        if (response.done) {
          pa.endSession();
        }

        // Agentic loop
        let turns = 0;
        let currentTasks: AgentTask[] = [];
        while (!response.done && turns < 20) {
          turns++;
          logger.debug(`[agent] turn ${turns} — tool_calls=${response.tool_calls.length}, has_plan=${!!response.plan}`, {
            category: "agent.turn",
            traceId: activeTraceId,
            agentSessionId: sessionIdRef.current ?? response.session_id,
          });
          pa.incrementTurn();

          // Parse plan into tasks + reasoning on the first turn that has one
          if (response.plan) {
            pa.setThinking("Planning your edit...");
            const parsed = parsePlanToTasks(response.plan);
            currentTasks = parsed.tasks;
            if (parsed.reasoning) {
              pa.setReasoning(parsed.reasoning);
            }
            pa.setPlan(currentTasks);

            setMessages((prev) => [
              ...prev,
              {
                role: "agent",
                content: response.plan,
                toolCalls: response.tool_calls,
                isExecuting: true,
              },
            ]);
          }

          // Group tool calls by name
          const groups = groupToolCalls(response.tool_calls);
          const groupTaskMap = mapGroupsToTasks(groups, currentTasks);

          // Resolve task IDs for each group (match or create ad-hoc)
          for (let gi = 0; gi < groups.length; gi++) {
            if (!groupTaskMap.has(gi)) {
              const adHocTask: AgentTask = {
                id: `adhoc-${gi}-t${turns}`,
                label: groups[gi].label,
                status: "pending",
              };
              pa.addAdHocTask(adHocTask);
              groupTaskMap.set(gi, adHocTask.id);
            }
          }

          const results: ToolResult[] = new Array(
            response.tool_calls.length,
          );

          for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            const taskId = groupTaskMap.get(gi)!;
            const count = group.indices.length;
            const isParallel =
              PARALLEL_SAFE_TOOLS.has(group.toolName) && count > 1;

            pa.startTask(
              taskId,
              count > 1 ? `0/${count} complete` : undefined,
            );

            let completedInGroup = 0;

            const executeOne = async (toolIdx: number) => {
              const tc = response.tool_calls[toolIdx];
              const toolT0 = performance.now();
              logger.debug(`[agent] executing tool: ${tc.tool_name}`, {
                category: "agent.tool",
                traceId: activeTraceId,
                agentSessionId: sessionIdRef.current ?? response.session_id,
                taskId,
                toolCallId: tc.call_id,
              });
              const onProgress: OnToolProgress = (p, detail) => {
                const groupDetail =
                  count > 1
                    ? `${completedInGroup}/${count} complete`
                    : detail;
                pa.updateTaskProgress(taskId, p, groupDetail);
              };
              const result = await executeTool(tc, onProgress);
              const toolElapsed = ((performance.now() - toolT0) / 1000).toFixed(1);
              logger.debug(`[agent] tool ${tc.tool_name} ${result.success ? "completed" : "FAILED"} in ${toolElapsed}s`, {
                category: "agent.tool",
                traceId: activeTraceId,
                agentSessionId: sessionIdRef.current ?? response.session_id,
                taskId,
                toolCallId: tc.call_id,
              });
              results[toolIdx] = result;
              completedInGroup++;
              if (count > 1) {
                const avgProgress = Math.round(
                  (completedInGroup / count) * 100,
                );
                pa.updateTaskProgress(
                  taskId,
                  avgProgress,
                  `${completedInGroup}/${count} complete`,
                );
              }
              return result;
            };

            if (isParallel) {
              const groupResults = await Promise.all(
                group.indices.map(executeOne),
              );
              const allOk = groupResults.every((r) => r.success);
              if (allOk) {
                pa.completeTask(taskId);
              } else {
                const firstErr = groupResults.find((r) => !r.success);
                pa.failTask(
                  taskId,
                  firstErr?.error ?? "Unknown error",
                );
              }
            } else {
              let groupFailed = false;
              for (const idx of group.indices) {
                const result = await executeOne(idx);
                if (!result.success && !groupFailed) {
                  groupFailed = true;
                  pa.failTask(
                    taskId,
                    result.error ?? "Unknown error",
                  );
                }
              }
              if (!groupFailed) {
                pa.completeTask(taskId);
              }
            }
          }

          const allSucceeded = results.every((r) => r?.success);
          if (allSucceeded) {
            setMessages((prev) => {
              const updated = [...prev];
              if (
                updated.length > 0 &&
                updated[updated.length - 1].isExecuting
              ) {
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  isExecuting: false,
                };
              }
              return updated;
            });
          }

          pa.setThinking("Continuing conversation...");

          const MUTATION_TOOLS = new Set([
            "delete_asset", "batch_delete_assets", "organize_asset",
            "toggle_favorite", "create_subclip_assets", "import_media",
            "create_bin", "rename_bin", "set_bin_color", "batch_organize_assets",
          ]);
          const hadMutations = response.tool_calls.some(
            (tc) => MUTATION_TOOLS.has(tc.tool_name),
          );

          let updatedContext: string | undefined;
          if (hadMutations) {
            const contextResult = await executeTool({
              tool_name: "get_project_assets",
              arguments: {},
            });
            if (contextResult.success && contextResult.result) {
              const r = contextResult.result as { assetCount?: number; assets?: Array<{ id: string; type: string; name?: string | null; tags?: string[]; prompt?: string }> };
              const assetSummary = (r.assets ?? [])
                .map((a) => {
                  let label = `  - ${a.id}: ${a.type}`;
                  if (a.name) label += `, name="${a.name}"`;
                  if (a.tags && a.tags.length > 0) label += `, tags=[${a.tags.join(', ')}]`;
                  if (a.prompt) label += `, "${a.prompt.slice(0, 60)}"`;
                  return label;
                })
                .join("\n");
              updatedContext =
                `## Updated Project State (after tool execution)\n` +
                `Total assets remaining: ${r.assetCount ?? 0}\n${assetSummary}`;
            }
          }

          const contRes = await backendFetch("/api/agent/continue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool_results: results.filter(Boolean),
              session_id: sessionIdRef.current,
              ...(updatedContext ? { updated_context: updatedContext } : {}),
            }),
            signal,
          }, createBackendRequestContext(activeTraceId));

          if (!contRes.ok) {
            const contBody = await contRes.json().catch(() => ({})) as { error?: string };
            throw new Error(contBody.error ?? `Agent continue error: ${contRes.status}`);
          }
          response = await contRes.json();
          logDiagnostics("agent", response.diagnostics);
          if (response.memory_updated) {
            window.dispatchEvent(new CustomEvent('memory-updated'));
          }
        }

        const finalText = response.message || response.plan || "Done.";
        const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
        logger.info(
          `[agent] session complete — ${turns} turn(s) in ${totalElapsed}s`,
          {
            category: "agent.session",
            traceId: activeTraceId,
            agentSessionId: sessionIdRef.current ?? response.session_id,
          },
        );

        pa.endSession();

        setMessages((prev) => {
          const updated = [...prev];
          if (
            updated.length > 0 &&
            updated[updated.length - 1].isExecuting
          ) {
            updated[updated.length - 1] = {
              role: "agent",
              content: finalText,
              isExecuting: false,
            };
          } else {
            updated.push({ role: "agent", content: finalText });
          }
          return updated;
        });
        conversationRef.current.push({ role: "assistant", content: finalText });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          progressActionsRef.current.reset();
          return;
        }
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          `[agent] error after ${((performance.now() - t0) / 1000).toFixed(1)}s: ${errorMsg}`,
          {
            category: "agent.error",
            traceId: activeTraceId,
            agentSessionId: sessionIdRef.current ?? undefined,
          },
        );
        progressActionsRef.current.endSession(errorMsg);
        const userFacingError = errorMsg !== "Unknown error"
          ? `${errorMsg} (Trace ID: ${activeTraceId})`
          : `Something went wrong. Please try again. Trace ID: ${activeTraceId}`;
        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            content: userFacingError,
          },
        ]);
      } finally {
        clearRendererLogContext(rendererLogContextId);
        if (rendererLogContextIdRef.current === rendererLogContextId) {
          rendererLogContextIdRef.current = null;
        }
        setIsProcessing(false);
        window.dispatchEvent(new CustomEvent('agent-action-complete'));
      }
    },
    [],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setIsProcessing(false);
    setMessages([]);
    conversationRef.current = [];
    sessionIdRef.current = null;
    traceIdRef.current = null;
    clearRendererLogContext(rendererLogContextIdRef.current ?? undefined);
    rendererLogContextIdRef.current = null;
    progressActionsRef.current.reset();
  }, []);

  return {
    messages,
    isProcessing,
    sendPrompt,
    clearChat,
    progress,
    setCollapsed: progressActions.setCollapsed,
    setMessages,
    setIsProcessing,
  };
}
