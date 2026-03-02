import { useCallback, useRef, useState } from "react";
import type { TimelineClip } from "../types/project";
import type {
  ToolCall,
  ToolResult,
} from "../views/editor/useAgentExecutor";

export type { ToolCall };

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
  role: "user" | "agent";
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
    const backendUrl = await window.electronAPI.getBackendUrl();
    const res = await fetch(`${backendUrl}/api/agent/analyze-video`, {
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
  } catch (err) {
    console.warn("Video analysis trigger failed:", err);
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

  const sendPrompt = useCallback(
    async (
      prompt: string,
      clips: TimelineClip[],
      trackCount: number,
      currentTime: number,
      executeTool: (toolCall: ToolCall) => Promise<ToolResult>,
      projectId?: string | null,
    ) => {
      setIsProcessing(true);
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;

      setMessages((prev) => [...prev, { role: "user", content: prompt }]);
      conversationRef.current.push({ role: "user", content: prompt });

      const t0 = performance.now();
      console.log("[agent] sending prompt:", prompt.slice(0, 120));

      try {
        const backendUrl = await window.electronAPI.getBackendUrl();
        const timelineState = buildTimelineState(
          clips,
          trackCount,
          currentTime,
        );
        console.log(
          "[agent] timeline context: %d clips, %d tracks, playhead=%.1fs",
          clips.length,
          trackCount,
          currentTime,
        );

        const res = await fetch(`${backendUrl}/api/agent/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            timeline_state: timelineState,
            ...(projectId ? { project_id: projectId } : {}),
            ...(sessionIdRef.current
              ? { session_id: sessionIdRef.current }
              : { conversation_history: conversationRef.current }),
          }),
          signal,
        });

        if (!res.ok) throw new Error(`Agent API error: ${res.status}`);
        let response: AgentResponse = await res.json();

        console.log(
          "[agent] initial response in %.1fs — done=%s, tools=%d",
          (performance.now() - t0) / 1000,
          response.done,
          response.tool_calls?.length ?? 0,
        );

        if (response.session_id) {
          sessionIdRef.current = response.session_id;
        }

        // Agentic loop
        let turns = 0;
        while (!response.done && turns < 10) {
          turns++;
          const turnStart = performance.now();
          console.log(
            "[agent] turn %d — %d tool call(s): %s",
            turns,
            response.tool_calls.length,
            response.tool_calls.map((tc) => tc.tool_name).join(", "),
          );

          if (response.plan) {
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

          // Execute frontend tool calls
          const results: ToolResult[] = [];
          for (const tc of response.tool_calls) {
            const toolStart = performance.now();
            const result = await executeTool(tc);
            console.log(
              "[agent]   tool %s → %s (%.0fms)",
              tc.tool_name,
              result.success ? "ok" : `FAIL: ${result.error}`,
              performance.now() - toolStart,
            );
            results.push(result);
          }

          const allSucceeded = results.every((r) => r.success);
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

          console.log(
            "[agent] turn %d tools done, sending results back...",
            turns,
          );
          const contRes = await fetch(`${backendUrl}/api/agent/continue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool_results: results,
              session_id: sessionIdRef.current,
            }),
            signal,
          });

          if (!contRes.ok)
            throw new Error(`Agent continue error: ${contRes.status}`);
          response = await contRes.json();
          console.log(
            "[agent] turn %d complete in %.1fs — done=%s, next_tools=%d",
            turns,
            (performance.now() - turnStart) / 1000,
            response.done,
            response.tool_calls?.length ?? 0,
          );
        }

        const totalElapsed = (performance.now() - t0) / 1000;
        const finalText = response.message || response.plan || "Done.";
        console.log(
          "[agent] finished in %.1fs after %d turn(s)",
          totalElapsed,
          turns,
        );

        setMessages((prev) => {
          const updated = [...prev];
          if (updated.length > 0 && updated[updated.length - 1].isExecuting) {
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
        conversationRef.current.push({ role: "agent", content: finalText });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(
          "[agent] error after %.1fs:",
          (performance.now() - t0) / 1000,
          errorMsg,
        );
        setMessages((prev) => [
          ...prev,
          { role: "agent", content: "Something went wrong. Please try again." },
        ]);
      } finally {
        setIsProcessing(false);
      }
    },
    [],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    conversationRef.current = [];
    sessionIdRef.current = null;
  }, []);

  return { messages, isProcessing, sendPrompt, clearChat };
}
