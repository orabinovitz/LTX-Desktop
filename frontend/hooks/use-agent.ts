import { useCallback, useRef, useState } from "react";
import { logger } from "../lib/logger";
import { backendFetch } from "../lib/backend";
import type { TimelineClip } from "../types/project";
import type {
  ToolCall,
  ToolResult,
} from "../views/editor/useAgentExecutor";
import { useAgentProgress } from "./useAgentProgress";
import {
  parsePlanToTasks,
  groupToolCalls,
  mapGroupsToTasks,
  resetTaskIdCounter,
} from "../lib/parse-plan";
import type { AgentProgress, AgentTask } from "../types/agent-progress";

export type { ToolCall };
export type { AgentProgress };

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
  linked_clip_ids: string[];
  volume: number;
  muted: boolean;
}

interface TimelineState {
  clips: TimelineClipInfo[];
  track_count: number;
  total_duration: number;
  playhead_time: number;
}

interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

interface AgentResponse {
  plan: string;
  tool_calls: ToolCall[];
  message: string;
  done: boolean;
  session_id: string;
}

export interface ChatMessage {
  role: "user" | "agent";
  content: string;
  toolCalls?: ToolCall[];
  isExecuting?: boolean;
}

export type OnToolProgress = (progress: number, detail?: string) => void;

interface ExecuteToolFn {
  (toolCall: ToolCall, onProgress?: OnToolProgress): Promise<ToolResult>;
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
    linked_clip_ids: c.linkedClipIds ?? [],
    volume: c.volume,
    muted: c.muted,
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
  const conversationRef = useRef<AgentMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const progressActions = useAgentProgress();
  const { progress } = progressActions;

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
    ) => {
      setIsProcessing(true);
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;

      resetTaskIdCounter();
      progressActions.startSession();

      setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      conversationRef.current.push({ role: "user", content: prompt });

      const t0 = performance.now();

      try {
        const timelineState = buildTimelineState(
          clips,
          trackCount,
          currentTime,
        );
        progressActions.setThinking("Sending request to AI...");

        const res = await backendFetch("/api/agent/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            ...(clips.length > 0 ? { timeline_state: timelineState } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            ...(viewContext ? { view_context: viewContext } : {}),
            ...(assetsContext ? { assets_context: assetsContext } : {}),
            ...(sessionIdRef.current
              ? { session_id: sessionIdRef.current }
              : { conversation_history: conversationRef.current }),
          }),
          signal,
        });

        if (!res.ok) throw new Error(`Agent API error: ${res.status}`);
        let response: AgentResponse = await res.json();

        if (response.session_id) {
          sessionIdRef.current = response.session_id;
        }

        if (response.done) {
          progressActions.endSession();
        }

        // Agentic loop
        let turns = 0;
        let currentTasks: AgentTask[] = [];
        while (!response.done && turns < 20) {
          turns++;
          progressActions.incrementTurn();

          // Parse plan into tasks + reasoning on the first turn that has one
          if (response.plan) {
            progressActions.setThinking("Planning your edit...");
            const parsed = parsePlanToTasks(response.plan);
            currentTasks = parsed.tasks;
            if (parsed.reasoning) {
              progressActions.setReasoning(parsed.reasoning);
            }
            progressActions.setPlan(currentTasks);

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
              progressActions.addAdHocTask(adHocTask);
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

            progressActions.startTask(
              taskId,
              count > 1 ? `0/${count} complete` : undefined,
            );

            let completedInGroup = 0;

            const executeOne = async (toolIdx: number) => {
              const tc = response.tool_calls[toolIdx];
              const onProgress: OnToolProgress = (p, detail) => {
                const groupDetail =
                  count > 1
                    ? `${completedInGroup}/${count} complete`
                    : detail;
                progressActions.updateTaskProgress(taskId, p, groupDetail);
              };
              const result = await executeTool(tc, onProgress);
              results[toolIdx] = result;
              completedInGroup++;
              if (count > 1) {
                const avgProgress = Math.round(
                  (completedInGroup / count) * 100,
                );
                progressActions.updateTaskProgress(
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
                progressActions.completeTask(taskId);
              } else {
                const firstErr = groupResults.find((r) => !r.success);
                progressActions.failTask(
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
                  progressActions.failTask(
                    taskId,
                    result.error ?? "Unknown error",
                  );
                }
              }
              if (!groupFailed) {
                progressActions.completeTask(taskId);
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

          progressActions.setThinking("Continuing conversation...");

          const MUTATION_TOOLS = new Set([
            "delete_asset", "batch_delete_assets", "organize_asset",
            "toggle_favorite", "create_subclip_assets", "import_media",
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
              const r = contextResult.result as { assetCount?: number; assets?: Array<{ id: string; type: string; prompt?: string }> };
              const assetSummary = (r.assets ?? [])
                .map((a) => `  - ${a.id}: ${a.type}${a.prompt ? `, "${a.prompt.slice(0, 60)}"` : ""}`)
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
          });

          if (!contRes.ok)
            throw new Error(`Agent continue error: ${contRes.status}`);
          response = await contRes.json();
        }

        const finalText = response.message || response.plan || "Done.";

        progressActions.endSession();

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
          progressActions.reset();
          return;
        }
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        logger.error(`[agent] error after ${((performance.now() - t0) / 1000).toFixed(1)}s: ${errorMsg}`);
        progressActions.endSession(errorMsg);
        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            content: "Something went wrong. Please try again.",
          },
        ]);
      } finally {
        setIsProcessing(false);
      }
    },
    [progressActions],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    conversationRef.current = [];
    sessionIdRef.current = null;
    progressActions.reset();
  }, [progressActions]);

  return {
    messages,
    isProcessing,
    sendPrompt,
    clearChat,
    progress,
    setCollapsed: progressActions.setCollapsed,
  };
}
