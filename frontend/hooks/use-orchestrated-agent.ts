import { useCallback, useRef, useState } from "react";
import { logger } from "../lib/logger";
import { backendFetch } from "../lib/backend";
import type { TimelineClip } from "../types/project";
import type {
  ToolCall,
  ToolResult,
} from "../views/editor/useAgentExecutor";
import { useAgentProgress } from "./useAgentProgress";
import type {
  AgentProgress,
  AgentTask,
  OrchestrateResponse,
  OrchestrateTaskInfo,
  OrchestratorStatus,
} from "../types/agent-progress";

export type { AgentProgress };

export type OnToolProgress = (progress: number, detail?: string) => void;

interface ExecuteToolFn {
  (toolCall: ToolCall, onProgress?: OnToolProgress): Promise<ToolResult>;
}

export interface ChatMessage {
  role: "user" | "agent";
  content: string;
  toolCalls?: ToolCall[];
  isExecuting?: boolean;
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
      linked_clip_ids: c.linkedClipIds ?? [],
      volume: c.volume,
      muted: c.muted,
    })),
    track_count: trackCount,
    total_duration: clips.reduce(
      (max, c) => Math.max(max, c.startTime + c.duration),
      0,
    ),
    playhead_time: currentTime,
  };
}

function taskInfoToAgentTask(info: OrchestrateTaskInfo): AgentTask {
  const statusMap: Record<string, AgentTask["status"]> = {
    pending: "pending",
    running: "in_progress",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };

  return {
    id: info.id,
    label: info.description,
    status: statusMap[info.status] ?? "pending",
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

      progressActions.startSession();
      progressActions.update({
        isOrchestrated: true,
        orchestratorStatus: "planning" as OrchestratorStatus,
        thinkingLine: "Decomposing your request into tasks...",
      });

      setMessages((prev) => [...prev, { role: "user", content: prompt }]);

      const t0 = performance.now();

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

        if (!res.ok) throw new Error(`Orchestrate API error: ${res.status}`);
        let response: OrchestrateResponse = await res.json();

        if (response.session_id) {
          sessionIdRef.current = response.session_id;
        }

        const orchestratedTasks = response.tasks.map(taskInfoToAgentTask);
        progressActions.setPlan(orchestratedTasks);
        progressActions.update({
          isOrchestrated: true,
          orchestratorStatus: response.status as OrchestratorStatus,
        });

        let turns = 0;
        let lastMessageAdded = false;

        while (!response.done && turns < 50) {
          turns++;
          progressActions.incrementTurn();
          syncTaskStatuses(response.tasks, progressActions);
          lastMessageAdded = false;

          progressActions.update({
            orchestratorStatus: response.status as OrchestratorStatus,
          });

          if (response.tool_calls.length > 0) {
            progressActions.update({ thinkingLine: "" });

            if (response.current_task_id) {
              progressActions.startTask(response.current_task_id);
            }

            const results: ToolResult[] = [];
            const toolCalls = response.tool_calls;
            const toolNames = [...new Set(toolCalls.map((tc) => tc.tool_name))];

            if (response.current_task_id) {
              progressActions.updateTask(response.current_task_id, {
                activeToolCalls: toolNames,
              });
            }

            const groups = groupByToolName(toolCalls);
            for (const group of groups) {
              const isParallel =
                PARALLEL_SAFE_TOOLS.has(group.toolName) && group.calls.length > 1;

              if (isParallel) {
                const groupResults = await Promise.all(
                  group.calls.map((tc) => executeTool(tc)),
                );
                results.push(...groupResults);
              } else {
                for (const tc of group.calls) {
                  const result = await executeTool(tc);
                  results.push(result);
                }
              }
            }

            // BUG-4 fix: send updated context after mutation tools
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
                    prompt?: string;
                  }>;
                };
                const assetSummary = (r.assets ?? [])
                  .map(
                    (a) =>
                      `  - ${a.id}: ${a.type}${a.prompt ? `, "${a.prompt.slice(0, 60)}"` : ""}`,
                  )
                  .join("\n");
                updatedContext =
                  `## Updated Project State\n` +
                  `Total assets: ${r.assetCount ?? 0}\n${assetSummary}`;
              }
            }

            if (response.current_task_id) {
              progressActions.updateTask(response.current_task_id, {
                activeToolCalls: undefined,
              });
            }

            progressActions.setThinking("Continuing orchestration...");

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

            if (!contRes.ok)
              throw new Error(`Orchestrate continue error: ${contRes.status}`);
            response = await contRes.json();
          } else if (!response.done) {
            // BUG-1 fix: when no tool calls but not done, call continue
            // to let the orchestrator advance to the next task.
            if (response.message) {
              setMessages((prev) => [
                ...prev,
                { role: "agent", content: response.message },
              ]);
              lastMessageAdded = true;
            }

            progressActions.setThinking("Advancing to next task...");

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

            if (!contRes.ok)
              throw new Error(`Orchestrate continue error: ${contRes.status}`);
            response = await contRes.json();
          } else {
            break;
          }
        }

        syncTaskStatuses(response.tasks, progressActions);
        progressActions.endSession();

        // BUG-9 fix: only add final message if we didn't already add it
        const finalText = response.message || "All tasks completed.";
        if (!lastMessageAdded || finalText !== response.message) {
          setMessages((prev) => [
            ...prev,
            { role: "agent", content: finalText },
          ]);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          progressActions.reset();
          return;
        }
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          `[orchestrated-agent] error after ${((performance.now() - t0) / 1000).toFixed(1)}s: ${errorMsg}`,
        );
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
        window.dispatchEvent(new CustomEvent('agent-action-complete'));
      }
    },
    [progressActions],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
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

// --- Helpers ---

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

function syncTaskStatuses(
  tasks: OrchestrateTaskInfo[],
  actions: ReturnType<typeof useAgentProgress>,
) {
  for (const taskInfo of tasks) {
    const agentTask = taskInfoToAgentTask(taskInfo);
    if (agentTask.status === "completed") {
      actions.completeTask(agentTask.id);
    } else if (agentTask.status === "failed") {
      actions.failTask(agentTask.id, agentTask.error ?? "Unknown error");
    } else if (agentTask.status === "in_progress") {
      actions.startTask(agentTask.id);
    }
  }
}
