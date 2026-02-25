import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Loader2, Bot, Undo2 } from 'lucide-react'

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
}

export function AgentPromptBox({
  isOpen,
  onClose,
  messages,
  isProcessing,
  onSend,
  onUndo,
  canUndo,
}: AgentPromptBoxProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure the element is rendered before focusing
      const timer = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isProcessing])

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

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
          <span className="text-sm font-semibold text-zinc-200">Agent</span>
        </div>
        <div className="flex items-center gap-1">
          {canUndo && (
            <button
              onClick={onUndo}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              title="Undo last agent action"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
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
              <p className="whitespace-pre-wrap">{msg.content}</p>

              {/* Tool calls */}
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

              {/* Executing indicator */}
              {msg.isExecuting && (!msg.toolCalls || msg.toolCalls.length === 0) && (
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-blue-400">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  <span>Executing...</span>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Thinking indicator */}
        {showThinking && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 text-zinc-400 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Thinking...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
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
          type="submit"
          disabled={isProcessing || !input.trim()}
          className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  )
}
