import { useCallback, useEffect, useRef, useState } from 'react'
import { GoogleGenAI, Modality } from '@google/genai/web'
import { AudioPlaybackQueue } from '../lib/audio-playback'
import type { ToolCall, ToolResult } from '../views/editor/useAgentExecutor'

// Worklet URL resolved by Vite at build time
const WORKLET_URL = new URL('../lib/pcm-capture-processor.js', import.meta.url).href

interface LiveConfig {
  system_prompt: string
  tools: Record<string, unknown>[]
  model: string
}

interface LiveToken {
  token: string
  expire_time: string
  model: string
}

export type LiveAgentStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface UseLiveAgentReturn {
  status: LiveAgentStatus
  isSpeaking: boolean
  connect: () => Promise<void>
  disconnect: () => void
  error: string | null
  activeToolCalls: ToolCall[]
}

export function useLiveAgent(
  executeTool: (call: ToolCall) => Promise<ToolResult>,
  executeBackendTool: (call: ToolCall) => Promise<ToolResult>,
): UseLiveAgentReturn {
  const [status, setStatus] = useState<LiveAgentStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([])

  const sessionRef = useRef<any>(null)
  const playbackRef = useRef<AudioPlaybackQueue | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const configRef = useRef<LiveConfig | null>(null)
  const resumeHandleRef = useRef<string | null>(null)

  const executeToolRef = useRef(executeTool)
  executeToolRef.current = executeTool
  const executeBackendToolRef = useRef(executeBackendTool)
  executeBackendToolRef.current = executeBackendTool

  const cleanupAudio = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop())
      micStreamRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    if (playbackRef.current) {
      playbackRef.current.stop()
      playbackRef.current = null
    }
    if (speakingTimerRef.current) {
      clearTimeout(speakingTimerRef.current)
      speakingTimerRef.current = null
    }
  }, [])

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close() } catch { /* already closed */ }
      sessionRef.current = null
    }
    cleanupAudio()
    setStatus('idle')
    setIsSpeaking(false)
    setActiveToolCalls([])
    setError(null)
  }, [cleanupAudio])

  const connect = useCallback(async () => {
    if (status === 'connecting' || status === 'connected') return

    setStatus('connecting')
    setError(null)

    let step = 'init'
    try {
      step = 'getBackendUrl'
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Fetch config (system prompt + tools) if not cached
      if (!configRef.current) {
        step = 'fetchConfig'
        const configRes = await fetch(`${backendUrl}/api/agent/live-config`)
        if (!configRes.ok) throw new Error(`Config HTTP ${configRes.status}`)
        configRef.current = await configRes.json()
      }
      const config = configRef.current!

      // Fetch ephemeral token
      step = 'fetchToken'
      const tokenRes = await fetch(`${backendUrl}/api/agent/live-token`, { method: 'POST' })
      if (!tokenRes.ok) {
        const detail = await tokenRes.json().catch(() => ({}))
        throw new Error(detail.detail || `Token HTTP ${tokenRes.status}`)
      }
      const tokenData: LiveToken = await tokenRes.json()

      // Set up audio playback
      step = 'audioPlayback'
      const playback = new AudioPlaybackQueue()
      playback.start()
      playbackRef.current = playback

      // Set up mic capture
      step = 'micAccess'
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: 16000 }, channelCount: 1, echoCancellation: true },
      })
      micStreamRef.current = micStream

      step = 'audioWorklet'
      const audioCtx = new AudioContext({ sampleRate: micStream.getAudioTracks()[0].getSettings().sampleRate || 48000 })
      audioCtxRef.current = audioCtx

      await audioCtx.audioWorklet.addModule(WORKLET_URL)
      const source = audioCtx.createMediaStreamSource(micStream)
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor')
      source.connect(workletNode)

      // Connect to Gemini Live API (v1alpha required for ephemeral tokens)
      step = 'wsConnect'
      console.log('[live-agent] connecting with token len:', tokenData.token.length, 'model:', config.model)
      const ai = new GoogleGenAI({ apiKey: tokenData.token, httpOptions: { apiVersion: 'v1alpha' } })

      const session = await ai.live.connect({
        model: `models/${config.model}`,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: config.system_prompt,
          tools: [{ functionDeclarations: config.tools }],
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: resumeHandleRef.current
            ? { handle: resumeHandleRef.current }
            : {},
        },
        callbacks: {
          onopen: () => {
            console.log('[live-agent] connected')
            setStatus('connected')
          },
          onmessage: (message: any) => {
            handleMessage(message, playback)
          },
          onerror: (e: any) => {
            const detail = e?.message || (typeof e === 'string' ? e : JSON.stringify(e))
            console.error('[live-agent] onerror:', detail)
            setError(`[ws] ${detail}`)
            setStatus('error')
          },
          onclose: (e: any) => {
            console.log('[live-agent] onclose:', e?.code, e?.reason)
            cleanupAudio()
            setStatus('idle')
            setIsSpeaking(false)
          },
        },
      })

      sessionRef.current = session

      // Stream mic PCM to the session
      workletNode.port.onmessage = (e: MessageEvent) => {
        if (!sessionRef.current) return
        const pcmBuffer: ArrayBuffer = e.data
        const bytes = new Uint8Array(pcmBuffer)
        const base64 = arrayBufferToBase64(bytes)
        try {
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
          })
        } catch {
          // Session may have closed
        }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const full = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : msg
      console.error(`[live-agent] FAILED at step="${step}":`, err)
      setError(`[${step}] ${full}`)
      setStatus('error')
      cleanupAudio()
    }
  }, [status, cleanupAudio])

  const handleMessage = useCallback((message: any, playback: AudioPlaybackQueue) => {
    // Session resumption tokens
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate
      if (update.resumable && update.newHandle) {
        resumeHandleRef.current = update.newHandle
      }
    }

    // Audio content from model
    if (message.serverContent) {
      if (message.serverContent.interrupted) {
        playback.flush()
        setIsSpeaking(false)
        return
      }

      if (message.serverContent.modelTurn?.parts) {
        for (const part of message.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            playback.enqueue(part.inlineData.data)
            setIsSpeaking(true)
            if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
            speakingTimerRef.current = setTimeout(() => setIsSpeaking(false), 500)
          }
        }
      }

      if (message.serverContent.turnComplete) {
        if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
        speakingTimerRef.current = setTimeout(() => setIsSpeaking(false), 1000)
      }
    }

    // Tool calls from model
    if (message.toolCall) {
      handleToolCalls(message.toolCall)
    }
  }, [])

  const handleToolCalls = useCallback(async (toolCall: any) => {
    if (!toolCall.functionCalls || !sessionRef.current) return

    const calls: ToolCall[] = toolCall.functionCalls.map((fc: any) => ({
      tool_name: fc.name,
      arguments: fc.args || {},
    }))

    setActiveToolCalls(calls)

    const functionResponses: any[] = []
    for (const fc of toolCall.functionCalls) {
      const call: ToolCall = { tool_name: fc.name, arguments: fc.args || {} }

      let result: ToolResult
      if (fc.name === 'get_video_metadata') {
        result = await executeBackendToolRef.current(call)
      } else {
        result = await executeToolRef.current(call)
      }

      functionResponses.push({
        id: fc.id,
        name: fc.name,
        response: result.success
          ? { result: result.result }
          : { error: result.error || 'Unknown error' },
      })
    }

    setActiveToolCalls([])

    try {
      sessionRef.current.sendToolResponse({ functionResponses })
    } catch {
      console.error('[live-agent] failed to send tool response')
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        try { sessionRef.current.close() } catch { /* noop */ }
      }
      cleanupAudio()
    }
  }, [cleanupAudio])

  return { status, isSpeaking, connect, disconnect, error, activeToolCalls }
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
