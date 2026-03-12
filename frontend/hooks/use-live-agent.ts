import { useCallback, useEffect, useRef, useState } from "react";
import {
  Behavior,
  FunctionResponseScheduling,
  GoogleGenAI,
  Modality,
  Session,
} from "@google/genai/web";
import { AudioPlaybackQueue } from "../lib/audio-playback";
import { logger } from "../lib/logger";
import type { ToolCall, ToolResult } from "../views/editor/useAgentExecutor";

// Worklet URL resolved by Vite at build time
const WORKLET_URL = new URL("../lib/pcm-capture-processor.js", import.meta.url)
  .href;

const READ_ONLY_TOOLS = new Set([
  "get_timeline_state",
  "get_project_assets",
  "get_video_metadata",
]);

interface LiveConfig {
  system_prompt: string;
  tools: Record<string, unknown>[];
  model: string;
}

interface LiveToken {
  token: string;
  expire_time: string;
  model: string;
}

interface GeminiFunctionCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiToolCall {
  functionCalls?: GeminiFunctionCall[];
}

interface GeminiLiveMessage {
  sessionResumptionUpdate?: {
    resumable?: boolean;
    newHandle?: string;
  };
  serverContent?: {
    interrupted?: boolean;
    modelTurn?: {
      parts?: Array<{ inlineData?: { data: string } }>;
    };
    turnComplete?: boolean;
  };
  toolCall?: GeminiToolCall;
}

export type LiveAgentStatus = "idle" | "connecting" | "connected" | "error";

interface UseLiveAgentReturn {
  status: LiveAgentStatus;
  isSpeaking: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  error: string | null;
  activeToolCalls: ToolCall[];
}

export function useLiveAgent(
  executeTool: (call: ToolCall) => Promise<ToolResult>,
  executeBackendTool: (call: ToolCall) => Promise<ToolResult>,
  getTimelineContext: () => string,
): UseLiveAgentReturn {
  const [status, setStatus] = useState<LiveAgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  const statusRef = useRef<LiveAgentStatus>("idle");
  statusRef.current = status;

  const sessionRef = useRef<Session | null>(null);
  const playbackRef = useRef<AudioPlaybackQueue | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef<LiveConfig | null>(null);
  const resumeHandleRef = useRef<string | null>(null);
  const toolCallQueueRef = useRef<GeminiToolCall[]>([]);
  const processingToolCallsRef = useRef(false);

  const executeToolRef = useRef(executeTool);
  executeToolRef.current = executeTool;
  const executeBackendToolRef = useRef(executeBackendTool);
  executeBackendToolRef.current = executeBackendTool;
  const getTimelineContextRef = useRef(getTimelineContext);
  getTimelineContextRef.current = getTimelineContext;

  const cleanupAudio = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
    }
    if (speakingTimerRef.current) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch {
        // Best-effort cleanup
      }
      sessionRef.current = null;
    }
    cleanupAudio();
    setStatus("idle");
    setIsSpeaking(false);
    setActiveToolCalls([]);
    setError(null);
  }, [cleanupAudio]);

  // Ordered so each callback is declared before the ones that depend on it
  const processToolCall = useCallback(async (toolCall: GeminiToolCall) => {
    if (!toolCall.functionCalls || !sessionRef.current) return;

    const calls: ToolCall[] = toolCall.functionCalls.map((fc) => ({
      tool_name: fc.name,
      arguments: fc.args || {},
    }));

    setActiveToolCalls(calls);

    const fcs = toolCall.functionCalls;
    const settled = await Promise.allSettled(
      fcs.map(async (fc) => {
        const call: ToolCall = { tool_name: fc.name, arguments: fc.args || {} };
        return fc.name === "get_video_metadata"
          ? await executeBackendToolRef.current(call)
          : await executeToolRef.current(call);
      }),
    );

    const functionResponses = fcs.map((fc, i) => {
      const outcome = settled[i];
      const result: ToolResult =
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              tool_name: fc.name,
              success: false,
              result: null,
              error: "Tool execution failed",
            };
      return {
        id: fc.id,
        name: fc.name,
        scheduling: FunctionResponseScheduling.WHEN_IDLE,
        response: result.success
          ? { result: result.result }
          : { error: result.error || "Unknown error" },
      };
    });

    setActiveToolCalls([]);

    try {
      sessionRef.current.sendToolResponse({ functionResponses });
    } catch (e) {
      logger.error(`[live-agent] failed to send tool response: ${e}`);
    }

    const anyMutating = fcs.some((fc) => !READ_ONLY_TOOLS.has(fc.name));
    if (anyMutating) {
      try {
        const updatedContext = getTimelineContextRef.current();
        sessionRef.current?.sendClientContent({
          turns: [{ role: "user", parts: [{ text: updatedContext }] }],
          turnComplete: true,
        });
      } catch {
        // Best-effort context update
      }
    }
  }, []);

  const drainToolCallQueue = useCallback(async () => {
    if (processingToolCallsRef.current) return;
    processingToolCallsRef.current = true;
    try {
      while (toolCallQueueRef.current.length > 0) {
        const next = toolCallQueueRef.current.shift()!;
        await processToolCall(next);
      }
    } finally {
      processingToolCallsRef.current = false;
    }
  }, [processToolCall]);

  const enqueueToolCall = useCallback(
    (toolCall: GeminiToolCall) => {
      toolCallQueueRef.current.push(toolCall);
      drainToolCallQueue();
    },
    [drainToolCallQueue],
  );

  const handleMessage = useCallback(
    (message: GeminiLiveMessage, playback: AudioPlaybackQueue) => {
      if (message.sessionResumptionUpdate) {
        const update = message.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          resumeHandleRef.current = update.newHandle;
        }
      }

      if (message.serverContent) {
        if (message.serverContent.interrupted) {
          playback.flush();
          setIsSpeaking(false);
          return;
        }

        if (message.serverContent.modelTurn?.parts) {
          for (const part of message.serverContent.modelTurn.parts) {
            if (part.inlineData?.data) {
              playback.enqueue(part.inlineData.data);
              setIsSpeaking(true);
              if (speakingTimerRef.current)
                clearTimeout(speakingTimerRef.current);
              speakingTimerRef.current = setTimeout(
                () => setIsSpeaking(false),
                500,
              );
            }
          }
        }

        if (message.serverContent.turnComplete) {
          if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
          speakingTimerRef.current = setTimeout(
            () => setIsSpeaking(false),
            1000,
          );
        }
      }

      if (message.toolCall) {
        enqueueToolCall(message.toolCall);
      }
    },
    [enqueueToolCall],
  );

  const connect = useCallback(async () => {
    if (statusRef.current === "connecting" || statusRef.current === "connected") return;

    setStatus("connecting");
    setError(null);

    let step = "init";
    try {
      step = "getBackendUrl";
      const backendUrl = await window.electronAPI.getBackendUrl();

      if (!configRef.current) {
        step = "fetchConfig";
        const configRes = await fetch(`${backendUrl}/api/agent/live-config`);
        if (!configRes.ok) throw new Error(`Config HTTP ${configRes.status}`);
        configRef.current = await configRes.json();
      }
      const config = configRef.current!;

      step = "fetchToken+micAccess";
      const tokenPromise = (async () => {
        const tokenRes = await fetch(`${backendUrl}/api/agent/live-token`, {
          method: "POST",
        });
        if (!tokenRes.ok) {
          const detail = await tokenRes.json().catch(() => ({}));
          throw new Error(detail.detail || `Token HTTP ${tokenRes.status}`);
        }
        return tokenRes.json() as Promise<LiveToken>;
      })();
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: 1,
          echoCancellation: true,
        },
      });

      const [tokenData, micStream] = await Promise.all([
        tokenPromise,
        micPromise,
      ]);

      const playback = new AudioPlaybackQueue();
      playback.start();
      playbackRef.current = playback;
      micStreamRef.current = micStream;

      step = "audioWorklet";
      const audioCtx = new AudioContext({
        sampleRate:
          micStream.getAudioTracks()[0].getSettings().sampleRate || 48000,
      });
      audioCtxRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule(WORKLET_URL);
      const source = audioCtx.createMediaStreamSource(micStream);
      const workletNode = new AudioWorkletNode(
        audioCtx,
        "pcm-capture-processor",
      );
      source.connect(workletNode);

      step = "wsConnect";
      const ai = new GoogleGenAI({
        apiKey: tokenData.token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      const session = await ai.live.connect({
        model: `models/${config.model}`,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: config.system_prompt,
          tools: [
            {
              functionDeclarations: config.tools.map((t) => ({
                ...t,
                behavior: Behavior.NON_BLOCKING,
              })),
            },
          ],
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: resumeHandleRef.current
            ? { handle: resumeHandleRef.current }
            : {},
        },
        callbacks: {
          onopen: () => {
            setStatus("connected");
          },
          onmessage: (message) => {
            handleMessage(message as GeminiLiveMessage, playback);
          },
          onerror: (e: unknown) => {
            const detail =
              e instanceof Error
                ? e.message
                : typeof e === "string"
                  ? e
                  : JSON.stringify(e);
            logger.error(`[live-agent] onerror: ${detail}`);
            setError(`[ws] ${detail}`);
            setStatus("error");
          },
          onclose: () => {
            cleanupAudio();
            setStatus("idle");
            setIsSpeaking(false);
          },
        },
      });

      sessionRef.current = session;

      step = "sendContext";
      const contextText = getTimelineContextRef.current();
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: contextText }] }],
        turnComplete: true,
      });

      workletNode.port.onmessage = (e: MessageEvent) => {
        if (!sessionRef.current) return;
        const pcmBuffer: ArrayBuffer = e.data;
        const bytes = new Uint8Array(pcmBuffer);
        const base64 = arrayBufferToBase64(bytes);
        try {
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64, mimeType: "audio/pcm;rate=16000" },
          });
        } catch {
          // Best-effort audio send
        }
      };
    } catch (err) {
      logger.error(`[live-agent] FAILED at step="${step}": ${err}`);
      setError(`Voice connection failed at ${step}. Please try again.`);
      setStatus("error");
      cleanupAudio();
    }
  }, [cleanupAudio, handleMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        try {
          sessionRef.current.close();
        } catch {
          // Best-effort cleanup
        }
      }
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return { status, isSpeaking, connect, disconnect, error, activeToolCalls };
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
