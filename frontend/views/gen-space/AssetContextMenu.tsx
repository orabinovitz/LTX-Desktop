import { useState, useEffect, useRef } from 'react'
import {
  Heart, FolderOpen, Archive, ArchiveRestore,
  Copy, Download, Trash2, Plus
} from 'lucide-react'
import type { BinMetadata } from '@/types/project'

export const BIN_COLORS: Record<string, string> = {
  violet: 'bg-violet-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
  rose: 'bg-rose-500',
  orange: 'bg-orange-500',
  mango: 'bg-amber-500',
}

export const BIN_COLOR_HEX: Record<string, string> = {
  violet: '#8b5cf6',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  rose: '#f43f5e',
  orange: '#f97316',
  mango: '#f59e0b',
}

export interface ContextMenuPosition {
  x: number
  y: number
}

export function AssetContextMenu({
  position,
  isFavorite,
  isArchived,
  bins,
  currentBin,
  onClose,
  onToggleFavorite,
  onArchive,
  onMoveToBin,
  onCreateBin,
  onCopyPrompt,
  onDownload,
  onDelete,
}: {
  position: ContextMenuPosition
  isFavorite: boolean
  isArchived: boolean
  bins: Record<string, BinMetadata>
  currentBin?: string
  onClose: () => void
  onToggleFavorite: () => void
  onArchive: () => void
  onMoveToBin: (bin: string | undefined) => void
  onCreateBin: () => void
  onCopyPrompt: () => void
  onDownload: () => void
  onDelete: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showBinSubmenu, setShowBinSubmenu] = useState(false)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: position.x,
    top: position.y,
    zIndex: 9999,
  }

  const binEntries = Object.entries(bins)

  const item = (label: string, icon: React.ReactNode, onClick: () => void, variant?: 'danger') => (
    <button
      key={label}
      onClick={() => { onClick(); onClose() }}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors text-left ${
        variant === 'danger'
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-zinc-300 hover:bg-zinc-700'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div ref={menuRef} style={menuStyle}>
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl py-1.5 min-w-[200px]">
        {item(
          isFavorite ? 'Unfavorite' : 'Favorite',
          <Heart className={`h-4 w-4 ${isFavorite ? 'fill-current text-red-400' : ''}`} />,
          onToggleFavorite,
        )}

        <div className="h-px bg-zinc-700 my-1" />

        <div
          className="relative"
          onMouseEnter={() => setShowBinSubmenu(true)}
          onMouseLeave={() => setShowBinSubmenu(false)}
        >
          <button
            className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 rounded-md transition-colors"
            onClick={() => setShowBinSubmenu(!showBinSubmenu)}
          >
            <span className="flex items-center gap-2.5">
              <FolderOpen className="h-4 w-4" />
              Move to Bin
            </span>
            <svg className="w-3 h-3 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {showBinSubmenu && (
            <div className="absolute left-full top-0 ml-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl py-1.5 min-w-[180px]">
              {currentBin && (
                <button
                  onClick={() => { onMoveToBin(undefined); onClose() }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-700 rounded-md transition-colors text-left"
                >
                  Remove from bin
                </button>
              )}
              {binEntries.map(([name, meta]) => (
                <button
                  key={name}
                  onClick={() => { onMoveToBin(name); onClose() }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors text-left ${
                    currentBin === name ? 'text-white bg-zinc-700' : 'text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full ${BIN_COLORS[meta.color || ''] || 'bg-zinc-500'}`} />
                  {name}
                </button>
              ))}
              {binEntries.length > 0 && <div className="h-px bg-zinc-700 my-1" />}
              <button
                onClick={() => { onCreateBin(); onClose() }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-700 rounded-md transition-colors text-left"
              >
                <Plus className="h-4 w-4" />
                New Bin...
              </button>
            </div>
          )}
        </div>

        <div className="h-px bg-zinc-700 my-1" />

        {item(
          isArchived ? 'Unarchive' : 'Archive',
          isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />,
          onArchive,
        )}

        <div className="h-px bg-zinc-700 my-1" />

        {item('Copy Prompt', <Copy className="h-4 w-4" />, onCopyPrompt)}
        {item('Download', <Download className="h-4 w-4" />, onDownload)}
        {item('Delete', <Trash2 className="h-4 w-4" />, onDelete, 'danger')}
      </div>
    </div>
  )
}
