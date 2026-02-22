import { cn } from '@/lib/utils'

export type GenerationMode = 'text-to-video' | 'image-to-video' | 'text-to-image'

// Simplified tab modes shown in the UI
type TabMode = 'video' | 'text-to-image'

interface ModeTabsProps {
  mode: GenerationMode
  onModeChange: (mode: GenerationMode) => void
  disabled?: boolean
}

const tabs: { id: TabMode; label: string; genMode: GenerationMode }[] = [
  { id: 'video', label: 'Video', genMode: 'text-to-video' },
  { id: 'text-to-image', label: 'Image', genMode: 'text-to-image' },
]

export function ModeTabs({ mode, onModeChange, disabled }: ModeTabsProps) {
  const activeTab: TabMode = mode === 'text-to-image' ? 'text-to-image' : 'video'
  
  return (
    <div className="flex">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          onClick={() => !disabled && onModeChange(tab.genMode)}
          disabled={disabled}
          className={cn(
            'px-4 py-1.5 text-sm font-medium transition-all',
            activeTab === tab.id
              ? 'text-blue-400'
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
