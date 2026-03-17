import { useState, useRef, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TagInputProps {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  suggestions?: string[]
  placeholder?: string
  maxTagLength?: number
  className?: string
  compact?: boolean
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 30)
}

export function TagInput({
  tags,
  onTagsChange,
  suggestions = [],
  placeholder = 'Add tag...',
  maxTagLength = 30,
  className,
  compact = false,
}: TagInputProps) {
  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const filteredSuggestions = input.trim()
    ? suggestions
        .filter(s => s.includes(input.trim().toLowerCase()) && !tags.includes(s))
        .slice(0, 6)
    : []

  const addTag = useCallback((raw: string) => {
    const tag = normalizeTag(raw)
    if (!tag || tags.includes(tag)) return
    onTagsChange([...tags, tag])
    setInput('')
    setShowSuggestions(false)
    setSelectedSuggestionIndex(-1)
  }, [tags, onTagsChange])

  const removeTag = useCallback((tag: string) => {
    onTagsChange(tags.filter(t => t !== tag))
  }, [tags, onTagsChange])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedSuggestionIndex >= 0 && filteredSuggestions[selectedSuggestionIndex]) {
        addTag(filteredSuggestions[selectedSuggestionIndex])
      } else if (input.trim()) {
        addTag(input)
      }
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSelectedSuggestionIndex(-1)
      inputRef.current?.blur()
    } else if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
      e.preventDefault()
      setSelectedSuggestionIndex(prev =>
        prev < filteredSuggestions.length - 1 ? prev + 1 : 0
      )
    } else if (e.key === 'ArrowUp' && filteredSuggestions.length > 0) {
      e.preventDefault()
      setSelectedSuggestionIndex(prev => (prev > 0 ? prev - 1 : filteredSuggestions.length - 1))
    }
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className={cn(
        'flex flex-wrap items-center gap-1',
        compact ? 'gap-0.5' : 'gap-1'
      )}>
        {tags.map(tag => (
          <span
            key={tag}
            className={cn(
              'inline-flex items-center rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700/50',
              compact ? 'text-[10px] px-1.5 py-0 gap-0.5' : 'text-xs px-2 py-0.5 gap-1'
            )}
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag) }}
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <X className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => {
            setInput(e.target.value.slice(0, maxTagLength))
            setShowSuggestions(true)
            setSelectedSuggestionIndex(-1)
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ''}
          className={cn(
            'bg-transparent outline-none text-zinc-300 placeholder-zinc-600 min-w-[60px] flex-1',
            compact ? 'text-[10px] py-0' : 'text-xs py-0.5'
          )}
        />
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
          {filteredSuggestions.map((suggestion, i) => (
            <button
              key={suggestion}
              type="button"
              className={cn(
                'w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors',
                i === selectedSuggestionIndex && 'bg-zinc-800'
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                addTag(suggestion)
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface TagPillsProps {
  tags: string[]
  max?: number
  compact?: boolean
  onRemove?: (tag: string) => void
}

export function TagPills({ tags, max = 3, compact = false, onRemove }: TagPillsProps) {
  if (tags.length === 0) return null
  const visible = tags.slice(0, max)
  const overflow = tags.length - max

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {visible.map(tag => (
        <span
          key={tag}
          className={cn(
            'inline-flex items-center rounded-full bg-zinc-800/80 text-zinc-400 border border-zinc-700/30',
            compact ? 'text-[9px] px-1.5 py-0 gap-0.5' : 'text-[10px] px-1.5 py-0 gap-0.5'
          )}
        >
          {tag}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(tag) }}
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <X className="h-2 w-2" />
            </button>
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[9px] text-zinc-500 px-1">+{overflow}</span>
      )}
    </div>
  )
}
