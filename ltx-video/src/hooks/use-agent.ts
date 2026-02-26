import { useCallback, useRef, useState } from 'react'
import type { TimelineClip } from '../types/project'

// --- Types matching backend Pydantic models ---

interface TimelineClipInfo {
  id: string
  asset_id: string | null
  type: string
  start_time: number
  duration: number
  trim_start: number
  trim_end: number
  track_index: number
  speed: number
  linked_clip_ids: string[]
  volume: number
  muted: boolean
}

interface TimelineState {
  clips: TimelineClipInfo[]
  track_count: number
  total_duration: number
  playhead_time: number
}

interface AgentMessage {
  role: 'user' | 'agent'
  content: string
}

export interface ToolCall {
  tool_name: string
  arguments: Record<string, unknown>
}

interface ToolResult {
  tool_name: string
  success: boolean
  result: unknown
  error: string | null
}

interface AgentResponse {
  plan: string
  tool_calls: ToolCall[]
  message: string
  done: boolean
  session_id: string
}

export interface ChatMessage {
  role: 'user' | 'agent'
  content: string
  toolCalls?: ToolCall[]
  isExecuting?: boolean
}

// --- Helper to build timeline state from React state ---

function buildTimelineState(
  clips: TimelineClip[],
  trackCount: number,
  currentTime: number,
): TimelineState {
  const clipInfos: TimelineClipInfo[] = clips.map(c => ({
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
  }))

  const totalDuration = clips.reduce(
    (max, c) => Math.max(max, c.startTime + c.duration),
    0,
  )

  return {
    clips: clipInfos,
    track_count: trackCount,
    total_duration: totalDuration,
    playhead_time: currentTime,
  }
}

// --- Standalone function: trigger background video analysis on import ---

export async function triggerVideoAnalysis(assetId: string, filePath: string): Promise<boolean> {
  try {
    const backendUrl = await window.electronAPI.getBackendUrl()
    const res = await fetch(`${backendUrl}/api/agent/analyze-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: assetId, file_path: filePath }),
    })
    if (res.ok) {
      const data = await res.json()
      return data.status === 'analyzing'
    }
  } catch (err) {
    console.warn('Video analysis trigger failed:', err)
  }
  return false
}

// --- Main hook ---

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const conversationRef = useRef<AgentMessage[]>([])

  const sendPrompt = useCallback(async (
    prompt: string,
    clips: TimelineClip[],
    trackCount: number,
    currentTime: number,
    executeTool: (toolCall: ToolCall) => Promise<ToolResult>,
  ) => {
    setIsProcessing(true)

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: prompt }])
    conversationRef.current.push({ role: 'user', content: prompt })

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const timelineState = buildTimelineState(clips, trackCount, currentTime)

      // Initial request — send session_id if we have one so backend
      // reuses the full Gemini conversation (including tool call history)
      const res = await fetch(`${backendUrl}/api/agent/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          timeline_state: timelineState,
          conversation_history: conversationRef.current,
          session_id: sessionIdRef.current,
        }),
      })

      if (!res.ok) throw new Error(`Agent API error: ${res.status}`)
      let response: AgentResponse = await res.json()

      // Extract session ID from response
      if (response.session_id) {
        sessionIdRef.current = response.session_id
      }

      // Agentic loop
      let turns = 0
      while (!response.done && turns < 10) {
        turns++

        // Show plan if present
        if (response.plan) {
          setMessages(prev => [...prev, {
            role: 'agent',
            content: response.plan,
            toolCalls: response.tool_calls,
            isExecuting: true,
          }])
        }

        // Execute frontend tool calls
        const results: ToolResult[] = []
        for (const tc of response.tool_calls) {
          const result = await executeTool(tc)
          results.push(result)
        }

        // Show immediate feedback: tools executed, waiting for summary
        const allSucceeded = results.every(r => r.success)
        if (allSucceeded) {
          setMessages(prev => {
            const updated = [...prev]
            if (updated.length > 0 && updated[updated.length - 1].isExecuting) {
              updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                isExecuting: false,
              }
            }
            return updated
          })
        }

        // Continue the loop with results
        const contRes = await fetch(`${backendUrl}/api/agent/continue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_results: results,
            conversation_history: conversationRef.current,
            session_id: sessionIdRef.current,
          }),
        })

        if (!contRes.ok) throw new Error(`Agent continue error: ${contRes.status}`)
        response = await contRes.json()
      }

      // Final message
      const finalText = response.message || response.plan || 'Done.'
      setMessages(prev => {
        // Replace last "executing" message or add new
        const updated = [...prev]
        if (updated.length > 0 && updated[updated.length - 1].isExecuting) {
          updated[updated.length - 1] = {
            role: 'agent',
            content: finalText,
            isExecuting: false,
          }
        } else {
          updated.push({ role: 'agent', content: finalText })
        }
        return updated
      })
      conversationRef.current.push({ role: 'agent', content: finalText })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages(prev => [...prev, { role: 'agent', content: `Error: ${errorMsg}` }])
    } finally {
      setIsProcessing(false)
    }
  }, [])

  const clearChat = useCallback(() => {
    setMessages([])
    conversationRef.current = []
    sessionIdRef.current = null
  }, [])

  return { messages, isProcessing, sendPrompt, clearChat }
}
