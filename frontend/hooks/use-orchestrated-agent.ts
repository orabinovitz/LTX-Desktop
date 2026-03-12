import { useCallback, useRef, useState } from "react";
import { logger } from "../lib/logger";
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

/**
 * Hook for orchestrated multi-agent execution.
 *
 * Manages the lifecycle of complex requests that are decomposed into
 * a DAG of tasks by the backend orchestrator.
 */
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
        thinkingLine: "Decomposing your request into tasks...",
      });

      setMessages((prev) => [...prev, { role: "user", content: prompt }]);

      const t0 = performance.now();

      try {
        const backendUrl = await window.electronAPI.getBackendUrl();
        const timelineState = buildTimelineState(clips, trackCount, currentTime);

        const res = await fetch(`${backendUrl}/api/agent/orchestrate`, {
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
        progressActions.update({ isOrchestrated: true });

        let turns = 0;
        while (!response.done && turns < 30) {
          turns++;
          progressActions.incrementTurn();

          syncTaskStatuses(response.tasks, progressActions);

          if (response.tool_calls.length > 0) {
            progressActions.update({ thinkingLine: "" });

            if (response.current_task_id) {
              progressActions.startTask(response.current_task_id);
            }

            const results: ToolResult[] = [];
            const toolCalls = response.tool_calls;

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

            progressActions.setThinking("Continuing orchestration...");

            const contRes = await fetch(
              `${backendUrl}/api/agent/orchestrate/continue`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  session_id: sessionIdRef.current,
                  tool_results: results,
                }),
                signal,
              },
            );

            if (!contRes.ok)
              throw new Error(`Orchestrate continue error: ${contRes.status}`);
            response = await contRes.json();
          } else if (response.message && !response.done) {
            setMessages((prev) => [
              ...prev,
              { role: "agent", content: response.message },
            ]);
            break;
          } else {
            break;
          }
        }

        syncTaskStatuses(response.tasks, progressActions);
        progressActions.endSession();

        const finalText = response.message || "All tasks completed.";
        setMessages((prev) => [...prev, { role: "agent", content: finalText }]);
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
          { role: "agent", content: "Something went wrong. Please try again." },
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
