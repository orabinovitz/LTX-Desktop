import { useState, useRef, useEffect, useCallback, Fragment } from 'react'
import { X, Send, Loader2, Bot, Undo2, Mic, Phone } from 'lucide-react'
import type { LiveAgentStatus } from '../../hooks/use-live-agent'
import type { ToolCall } from '../../hooks/use-agent'

export interface ChatMessage {
  role: 'user' | 'agent'
  content: string
  toolCalls?: { tool_name: string; arguments: Record<string, unknown> }[]
  isExecuting?: boolean
}

interface AgentPromptBoxProps {
  isOpen: boolean
  onClose: () => void
  messages: ChatMessage[]
  isProcessing: boolean
  onSend: (prompt: string) => void
  onUndo: () => void
  canUndo: boolean
  voiceStatus: LiveAgentStatus
  voiceIsSpeaking: boolean
  voiceError: string | null
  voiceToolCalls: ToolCall[]
  onVoiceConnect: () => void
  onVoiceDisconnect: () => void
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g
  let lastIndex = 0
  let match
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1] !== undefined) {
      parts.push(
        <strong key={key++} className="font-semibold text-zinc-100">
          {match[1]}
        </strong>
      )
    } else if (match[2] !== undefined) {
      parts.push(<em key={key++}>{match[2]}</em>)
    }
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length <= 1 ? parts[0] ?? text : parts
}

function renderMarkdown(text: string): React.ReactNode {
  const blocks = text.split(/\n\n+/)
  const elements: React.ReactNode[] = []

  blocks.forEach((block, bi) => {
    const trimmed = block.trim()
    if (!trimmed) return

    const lines = trimmed.split('\n')
    let textLines: string[] = []
    let listItems: string[] = []

    const flushText = () => {
      if (textLines.length === 0) return
      elements.push(
        <p key={`${bi}-t-${elements.length}`} className={elements.length > 0 ? 'mt-2' : ''}>
          {textLines.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      )
      textLines = []
    }

    const flushList = () => {
      if (listItems.length === 0) return
      elements.push(
        <ul key={`${bi}-l-${elements.length}`} className="space-y-1 my-1.5">
          {listItems.map((item, j) => (
            <li key={j} className="flex gap-1.5 items-start">
              <span className="text-blue-400 mt-0.5 text-[8px] flex-shrink-0">●</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      )
      listItems = []
    }

    lines.forEach((line) => {
      const listMatch = line.match(/^\s*[*\-+]\s+(.*)/)
      if (listMatch) {
        flushText()
        listItems.push(listMatch[1])
      } else {
        flushList()
        textLines.push(line)
      }
    })

    flushText()
    flushList()
  })

  return elements
}

export function AgentPromptBox({
  isOpen,
  onClose,
  messages,
  isProcessing,
  onSend,
  onUndo,
  canUndo,
  voiceStatus,
  voiceIsSpeaking,
  voiceError,
  voiceToolCalls,
  onVoiceConnect,
  onVoiceDisconnect,
}: AgentPromptBoxProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const isVoiceActive = voiceStatus === 'connected' || voiceStatus === 'connecting'

  useEffect(() => {
    if (isOpen && !isVoiceActive) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isOpen, isVoiceActive])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isProcessing])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (isVoiceActive) {
          onVoiceDisconnect()
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isVoiceActive, onClose, onVoiceDisconnect])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = input.trim()
      if (!trimmed || isProcessing) return
      onSend(trimmed)
      setInput('')
    },
    [input, isProcessing, onSend]
  )

  if (!isOpen) return null

  const showThinking =
    isProcessing && messages.length > 0 && messages[messages.length - 1].role === 'user'

  return (
    <div
      className="fixed bottom-24 right-6 z-50 w-96 flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
      style={{ maxHeight: '60vh' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/95 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-blue-600/20 flex items-center justify-center">
            <Bot className="h-3.5 w-3.5 text-blue-400" />
          </div>
          <span className="text-sm font-semibold text-zinc-200">
            {isVoiceActive ? 'Voice Agent' : 'Agent'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {canUndo && !isVoiceActive && (
            <button
              onClick={onUndo}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              title="Undo last agent action"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              if (isVoiceActive) onVoiceDisconnect()
              onClose()
            }}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Voice mode active view */}
      {isVoiceActive ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-[200px]">
          {/* Pulsing indicator */}
          <div className="relative mb-6">
            <div
              className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${
                voiceStatus === 'connecting'
                  ? 'bg-amber-600/20'
                  : voiceIsSpeaking
                    ? 'bg-blue-600/30'
                    : 'bg-emerald-600/20'
              }`}
            >
              {voiceStatus === 'connecting' ? (
                <Loader2 className="h-8 w-8 text-amber-400 animate-spin" />
              ) : voiceIsSpeaking ? (
                <Bot className="h-8 w-8 text-blue-400" />
              ) : (
                <Mic className="h-8 w-8 text-emerald-400" />
              )}
            </div>
            {/* Animated ring for active states */}
            {voiceStatus === 'connected' && (
              <div
                className={`absolute inset-0 rounded-full border-2 animate-ping ${
                  voiceIsSpeaking ? 'border-blue-500/40' : 'border-emerald-500/30'
                }`}
                style={{ animationDuration: voiceIsSpeaking ? '1s' : '2s' }}
              />
            )}
          </div>

          <p className="text-sm text-zinc-300 mb-1">
            {voiceStatus === 'connecting'
              ? 'Connecting...'
              : voiceIsSpeaking
                ? 'Agent is speaking...'
                : 'Listening...'}
          </p>
          <p className="text-xs text-zinc-500 mb-6">
            {voiceStatus === 'connecting'
              ? 'Setting up voice connection'
              : voiceIsSpeaking
                ? 'The agent is responding'
                : 'Speak naturally to edit your video'}
          </p>

          {/* Voice tool call chips */}
          {voiceToolCalls.length > 0 && (
            <div className="w-full space-y-1 mb-4">
              {voiceToolCalls.map((tc, j) => (
                <div
                  key={j}
                  className="flex items-center gap-1.5 text-[10px] text-zinc-400 bg-zinc-800 rounded px-2 py-1"
                >
                  <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-400 flex-shrink-0" />
                  <span className="truncate">{tc.tool_name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Disconnect button */}
          <button
            onClick={onVoiceDisconnect}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors text-xs"
          >
            <Phone className="h-3.5 w-3.5 rotate-[135deg]" />
            <span>End voice session</span>
          </button>
        </div>
      ) : (
        <>
          {/* Messages (text mode) */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 && (
              <p className="text-xs text-zinc-500 text-center py-8">
                Describe what you'd like to do with your video...
              </p>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-200'
                  }`}
                >
                  <div className="space-y-0">
                    {msg.role === 'agent' ? renderMarkdown(msg.content) : (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    )}
                  </div>

                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {msg.toolCalls.map((tc, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-1.5 text-[10px] text-zinc-400 bg-zinc-700/50 rounded px-2 py-1"
                        >
                          {msg.isExecuting ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-400 flex-shrink-0" />
                          ) : (
                            <span className="text-emerald-400 flex-shrink-0">&#10003;</span>
                          )}
                          <span className="truncate">{tc.tool_name}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {msg.isExecuting && (!msg.toolCalls || msg.toolCalls.length === 0) && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-blue-400">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      <span>Executing...</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {showThinking && (
              <div className="flex justify-start">
                <div className="bg-zinc-800 text-zinc-400 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
          </div>

          {/* Input (text mode) */}
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 px-3 py-2.5 border-t border-zinc-800 bg-zinc-900/95 flex-shrink-0"
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Type your prompt here..."
              disabled={isProcessing}
              className="flex-1 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
            />
            <button
              type="button"
              onClick={onVoiceConnect}
              disabled={isProcessing}
              className="p-2 rounded-lg text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              title="Switch to voice mode"
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
            <button
              type="submit"
              disabled={isProcessing || !input.trim()}
              className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </>
      )}

      {/* Voice error banner */}
      {voiceError && (
        <div className="px-3 py-2 bg-red-900/30 border-t border-red-800/50 text-xs text-red-400">
          {voiceError}
        </div>
      )}
    </div>
  )
}
