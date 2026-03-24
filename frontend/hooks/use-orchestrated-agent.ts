import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { logger } from "@/lib/logger";
import { backendFetch } from "@/lib/backend";
import type { TimelineClip } from "@/types/project";
import type {
  ToolCall,
  ToolResult,
} from "@/types/agent-progress";
import { useAgentProgress } from "./use-agent-progress";
import type {
  AgentDiagnostics,
  AgentProgress,
  AgentTask,
  ChatMessage,
  OnToolProgress,
  OrchestrateResponse,
  OrchestrateTaskInfo,
  OrchestratorStatus,
} from "@/types/agent-progress";

export type { AgentProgress, ChatMessage, OnToolProgress };

interface ExecuteToolFn {
  (toolCall: ToolCall, onProgress?: OnToolProgress, signal?: AbortSignal): Promise<ToolResult>;
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

const MAX_PARALLEL_GENERATIONS = 10;

const MUTATION_TOOLS = new Set([
  "add_clip_to_timeline",
  "trim_clip",
  "split_clip",
  "delete_clip",
  "move_clip",
  "create_timeline",
  "duplicate_timeline",
  "add_track",
  "delete_track",
  "add_dissolve",
  "set_clip_speed",
  "set_clip_volume",
  "set_clip_opacity",
  "set_color_correction",
  "flip_clip",
  "reverse_clip",
  "duplicate_clip",
  "split_at_playhead",
  "create_subclip_assets",
  "delete_asset",
  "batch_delete_assets",
  "organize_asset",
  "create_bin",
  "rename_bin",
  "set_bin_color",
  "batch_organize_assets",
  "import_media",
  "add_subtitle",
  "edit_subtitle",
]);

function buildTimelineState(
  clips: TimelineClip[],
  trackCount: number,
  currentTime: number,
): TimelineState {
  return {
    clips: clips.map((c) => ({
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
    })),
    track_count: trackCount,
    total_duration: clips.reduce(
      (max, c) => Math.max(max, c.startTime + c.duration),
      0,
    ),
    playhead_time: currentTime,
  };
}

const TASK_STATUS_MAP: Record<string, AgentTask["status"]> = {
  pending: "pending",
  running: "in_progress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function humanizeTaskLabel(id: string, description: string): string {
  const shotMatch = id.match(/^(?:generate-shot-|task-\d+-shot-)(\d+)$/);
  if (shotMatch) {
    const shotNum = shotMatch[1];
    const afterDesc = description.match(/visual description:\s*"?\*{0,2}\s*(.+)/is);
    if (afterDesc) {
      const raw = afterDesc[1].replace(/[*"]/g, "").trim();
      const short = raw.slice(0, 55).replace(/\s+\S*$/, "");
      return `Shot ${shotNum}: ${short}...`;
    }
    const afterColon = description.match(/^Generate Shot \d+:\s*(.+)/i);
    if (afterColon) {
      const short = afterColon[1].slice(0, 55).replace(/\s+\S*$/, "");
      return `Shot ${shotNum}: ${short}...`;
    }
    return `Shot ${shotNum}`;
  }

  const firstSentence = description.match(/^(.+?\.)\s/);
  if (firstSentence && firstSentence[1].length <= 80) {
    return firstSentence[1];
  }

  if (description.length <= 80) return description;
  return description.slice(0, 77) + "...";
}

function taskInfoToAgentTask(info: OrchestrateTaskInfo): AgentTask {
  return {
    id: info.id,
    label: humanizeTaskLabel(info.id, info.description),
    status: TASK_STATUS_MAP[info.status] ?? "pending",
    skillId: info.skill_id ?? undefined,
    skillName: info.skill_name ?? undefined,
    dependsOn: info.depends_on,
    error: info.error ?? undefined,
  };
}

export function useOrchestratedAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

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
      displayPrompt?: string,
    ) => {
      setIsProcessing(true);
      stoppedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;

      const pa = progressActionsRef.current;
      pa.startSession();
      pa.update({
        isOrchestrated: true,
        orchestratorStatus: "planning" as OrchestratorStatus,
        thinkingLine: "Decomposing your request into tasks...",
      });

      setMessages((prev) => [...prev, { role: "user", content: displayPrompt ?? prompt }]);

      const t0 = performance.now();
      logger.info(`[orchestrated-agent] session start — prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);

      try {
        const timelineState = buildTimelineState(clips, trackCount, currentTime);

        const res = await backendFetch("/api/agent/orchestrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            ...(clips.length > 0 ? { timeline_state: timelineState } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            ...(viewContext ? { view_context: viewContext } : {}),
            ...(assetsContext ? { assets_context: assetsContext } : {}),
          }),
          signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Orchestrate API error: ${res.status}`);
        }
        let response: OrchestrateResponse = await res.json();
        logDiagnostics("orchestrated-agent", response.diagnostics);

        if (response.session_id) {
          sessionIdRef.current = response.session_id;
        }
        if (response.memory_updated) {
          window.dispatchEvent(new CustomEvent('memory-updated'));
        }

        const orchestratedTasks = response.tasks.map(taskInfoToAgentTask);
        logger.info(`[orchestrated-agent] plan received — ${orchestratedTasks.length} task(s), status=${response.status}`);
        pa.setPlan(orchestratedTasks);
        pa.update({
          isOrchestrated: true,
          orchestratorStatus: response.status as OrchestratorStatus,
        });

        let turns = 0;
        let lastMessageAdded = false;

        while (!response.done && turns < 50) {
          if (stoppedRef.current) {
            syncTaskStatuses(response.tasks, pa, pa.progressRef);
            cancelRemainingPendingTasks(pa);
            pa.endSession("Stopped by user");
            setMessages((prev) => [
              ...prev,
              { role: "agent", content: "Agent stopped. Completed tasks are preserved." },
            ]);
            return;
          }

          turns++;
          logger.info(
            `[orchestrated-agent] turn ${turns} — status=${response.status}, tool_calls=${response.tool_calls.length}, current_task=${response.current_task_id ?? "none"}`,
          );
          pa.incrementTurn();
          syncTaskStatuses(response.tasks, pa, pa.progressRef);
          lastMessageAdded = false;

          pa.update({
            orchestratorStatus: response.status as OrchestratorStatus,
          });

          if (response.tool_calls.length > 0) {
            pa.update({ thinkingLine: "" });

            if (response.current_task_id) {
              pa.startTask(response.current_task_id);
            }

            const results: ToolResult[] = [];
            const toolCalls = response.tool_calls;
            const toolNames = [...new Set(toolCalls.map((tc) => tc.tool_name))];

            if (response.current_task_id) {
              pa.updateTask(response.current_task_id, {
                activeToolCalls: toolNames,
              });
            }

            const groups = groupByToolName(toolCalls);
            for (const group of groups) {
              if (stoppedRef.current) break;

              const isParallel =
                PARALLEL_SAFE_TOOLS.has(group.toolName) && group.calls.length > 1;
              logger.info(
                `[orchestrated-agent] executing ${group.calls.length}x ${group.toolName} (${isParallel ? "parallel" : "sequential"})`,
              );

              if (isParallel) {
                const groupResults = await executeParallelWithLimit(
                  group.calls,
                  executeTool,
                  MAX_PARALLEL_GENERATIONS,
                  signal,
                );
                results.push(...groupResults);
              } else {
                for (const tc of group.calls) {
                  if (stoppedRef.current) break;
                  const toolT0 = performance.now();
                  const result = await executeTool(tc, undefined, signal);
                  const toolElapsed = Math.round(performance.now() - toolT0);
                  logger.info(
                    `[orchestrated-agent] tool ${tc.tool_name} ${result.success ? "completed" : "FAILED"} in ${toolElapsed}ms`,
                  );
                  results.push(result);
                }
              }
            }

            let updatedContext: string | undefined;
            const hadMutations = toolCalls.some((tc) =>
              MUTATION_TOOLS.has(tc.tool_name),
            );
            if (hadMutations) {
              const contextResult = await executeTool({
                tool_name: "get_project_assets",
                arguments: {},
              });
              if (contextResult.success && contextResult.result) {
                const r = contextResult.result as {
                  assetCount?: number;
                  assets?: Array<{
                    id: string;
                    type: string;
                    name?: string | null;
                    tags?: string[];
                    prompt?: string;
                  }>;
                };
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
                  `## Updated Project State\n` +
                  `Total assets: ${r.assetCount ?? 0}\n${assetSummary}`;
              }
            }

            if (response.current_task_id) {
              pa.updateTask(response.current_task_id, {
                activeToolCalls: undefined,
              });
            }

            pa.setThinking("Continuing orchestration...");

            const contRes = await backendFetch(
              "/api/agent/orchestrate/continue",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  session_id: sessionIdRef.current,
                  tool_results: results,
                  ...(updatedContext
                    ? { updated_context: updatedContext }
                    : {}),
                }),
                signal,
              },
            );

            if (!contRes.ok) {
              const contBody = await contRes.json().catch(() => ({})) as { error?: string };
              throw new Error(contBody.error ?? `Orchestrate continue error: ${contRes.status}`);
            }
            response = await contRes.json();
            logDiagnostics("orchestrated-agent", response.diagnostics);
            if (response.memory_updated) {
              window.dispatchEvent(new CustomEvent('memory-updated'));
            }
          } else if (!response.done) {
            if (response.message) {
              setMessages((prev) => [
                ...prev,
                { role: "agent", content: response.message },
              ]);
              lastMessageAdded = true;
            }

            pa.setThinking("Advancing to next task...");

            const contRes = await backendFetch(
              "/api/agent/orchestrate/continue",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  session_id: sessionIdRef.current,
                  tool_results: [],
                }),
                signal,
              },
            );

            if (!contRes.ok) {
              const contBody = await contRes.json().catch(() => ({})) as { error?: string };
              throw new Error(contBody.error ?? `Orchestrate continue error: ${contRes.status}`);
            }
            response = await contRes.json();
            logDiagnostics("orchestrated-agent", response.diagnostics);
            if (response.memory_updated) {
              window.dispatchEvent(new CustomEvent('memory-updated'));
            }
          } else {
            break;
          }
        }

        syncTaskStatuses(response.tasks, pa, pa.progressRef);
        const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
        logger.info(`[orchestrated-agent] session complete — ${turns} turn(s) in ${totalElapsed}s`);
        pa.endSession();

        const finalText = response.message || "All tasks completed.";
        if (!lastMessageAdded || finalText !== response.message) {
          setMessages((prev) => [
            ...prev,
            { role: "agent", content: finalText },
          ]);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          const pa = progressActionsRef.current;
          if (stoppedRef.current) {
            cancelRemainingPendingTasks(pa);
            pa.endSession("Stopped by user");
            setMessages((prev) => [
              ...prev,
              { role: "agent", content: "Agent stopped. Completed tasks are preserved." },
            ]);
          } else {
            pa.reset();
          }
          return;
        }
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          `[orchestrated-agent] error after ${((performance.now() - t0) / 1000).toFixed(1)}s: ${errorMsg}`,
        );
        progressActionsRef.current.endSession(errorMsg);
        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            content: errorMsg !== "Unknown error" ? errorMsg : "Something went wrong. Please try again.",
          },
        ]);
      } finally {
        setIsProcessing(false);
        window.dispatchEvent(new CustomEvent('agent-action-complete'));
      }
    },
    [],
  );

  const stop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
    backendFetch("/api/generate/cancel", { method: "POST" }).catch(() => {});
  }, []);

  const skipTask = useCallback(
    async (taskId: string) => {
      if (!sessionIdRef.current) return;
      const pa = progressActionsRef.current;
      pa.skipTask(taskId);
      try {
        const res = await backendFetch("/api/agent/orchestrate/skip-task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            task_id: taskId,
          }),
        });
        if (res.ok) {
          const data: OrchestrateResponse = await res.json();
          syncTaskStatuses(data.tasks, pa, pa.progressRef);
        }
      } catch {
        logger.warn("[orchestrated-agent] skip-task request failed");
      }
    },
    [],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    stoppedRef.current = false;
    setMessages([]);
    sessionIdRef.current = null;
    progressActionsRef.current.reset();
  }, []);

  return {
    messages,
    isProcessing,
    sendPrompt,
    clearChat,
    setMessages,
    progress,
    setCollapsed: progressActions.setCollapsed,
    stop,
    skipTask,
  };
}

// --- Helpers ---

async function executeParallelWithLimit(
  calls: ToolCall[],
  executeTool: ExecuteToolFn,
  limit: number,
  signal?: AbortSignal,
): Promise<ToolResult[]> {
  const results: ToolResult[] = new Array(calls.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < calls.length) {
      const idx = nextIndex++;
      try {
        const toolT0 = performance.now();
        results[idx] = await executeTool(calls[idx], undefined, signal);
        const toolElapsed = Math.round(performance.now() - toolT0);
        logger.info(
          `[orchestrated-agent] tool ${calls[idx].tool_name} ${results[idx].success ? "completed" : "FAILED"} in ${toolElapsed}ms`,
        );
      } catch (e) {
        results[idx] = {
          tool_name: calls[idx].tool_name,
          success: false,
          result: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, calls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

interface ToolCallGroup {
  toolName: string;
  calls: ToolCall[];
}

function groupByToolName(toolCalls: ToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  let current: ToolCallGroup | null = null;

  for (const tc of toolCalls) {
    if (current && current.toolName === tc.tool_name) {
      current.calls.push(tc);
    } else {
      current = { toolName: tc.tool_name, calls: [tc] };
      groups.push(current);
    }
  }
  return groups;
}

function cancelRemainingPendingTasks(
  actions: ReturnType<typeof useAgentProgress>,
) {
  const tasks = actions.progressRef.current.tasks;
  for (const task of tasks) {
    if (task.status === "pending") {
      actions.skipTask(task.id);
    }
  }
}

function syncTaskStatuses(
  tasks: OrchestrateTaskInfo[],
  actions: ReturnType<typeof useAgentProgress>,
  progressRef: MutableRefObject<AgentProgress>,
) {
  const knownIds = new Set(progressRef.current.tasks.map((t) => t.id));

  for (const taskInfo of tasks) {
    const agentTask = taskInfoToAgentTask(taskInfo);

    if (!knownIds.has(agentTask.id)) {
      actions.addAdHocTask(agentTask);
      knownIds.add(agentTask.id);
    }

    if (agentTask.status === "completed") {
      actions.completeTask(agentTask.id);
    } else if (agentTask.status === "failed" || agentTask.status === "cancelled") {
      actions.failTask(agentTask.id, agentTask.error ?? "Unknown error");
    } else if (agentTask.status === "in_progress") {
      actions.startTask(agentTask.id);
    }
  }
}
