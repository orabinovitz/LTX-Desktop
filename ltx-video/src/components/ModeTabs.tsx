import React from 'react'
import { cn } from '@/lib/utils'

export type GenerationMode = 'text-to-video' | 'image-to-video' | 'text-to-image'

interface ModeTabsProps {
  mode: GenerationMode
  onModeChange: (mode: GenerationMode) => void
  disabled?: boolean
}

const tabs: { id: GenerationMode; label: string }[] = [
  { id: 'text-to-video', label: 'Text-to-Video' },
  { id: 'image-to-video', label: 'Image-to-Video' },
  { id: 'text-to-image', label: 'Text-to-Image' },
]

export function ModeTabs({ mode, onModeChange, disabled }: ModeTabsProps) {
  return (
    <div className="flex">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          onClick={() => !disabled && onModeChange(tab.id)}
          disabled={disabled}
          className={cn(
            'px-4 py-1.5 text-sm font-medium transition-all',
            mode === tab.id
              ? 'text-violet-400'
              : 'text-zinc-500 hover:text-zinc-300',
            disabled && 'opacity-50 cursor-not-allowed',
            index > 0 && 'ml-1'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
