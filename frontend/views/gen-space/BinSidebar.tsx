import { useState, useRef, useEffect } from 'react'
import { FolderOpen, Plus, Archive, Pencil, Trash2, Palette } from 'lucide-react'
import type { Asset, BinMetadata } from '@/types/project'
import { BIN_COLORS, BIN_COLOR_HEX } from './AssetContextMenu'

export type ActiveBinFilter = 'all' | 'archived' | string

interface BinSidebarProps {
  bins: Record<string, BinMetadata>
  assets: Asset[]
  activeBin: ActiveBinFilter
  onActiveBinChange: (bin: ActiveBinFilter) => void
  onCreateBin: () => void
  onRenameBin: (oldName: string) => void
  onDeleteBin: (name: string) => void
  onSetBinColor: (name: string, color: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function BinSidebar({
  bins,
  assets,
  activeBin,
  onActiveBinChange,
  onCreateBin,
  onRenameBin,
  onDeleteBin,
  onSetBinColor,
  collapsed,
  onToggleCollapse,
}: BinSidebarProps) {
  const [contextMenu, setContextMenu] = useState<{ binName: string; x: number; y: number } | null>(null)
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const generatedAssets = assets.filter(a => a.generationParams)
  const nonArchivedAssets = generatedAssets.filter(a => !a.archived)
  const archivedCount = generatedAssets.filter(a => a.archived).length
  const unorganizedCount = nonArchivedAssets.filter(a => !a.bin).length

  const binEntries = Object.entries(bins).sort((a, b) => a[1].createdAt - b[1].createdAt)

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
        setShowColorPicker(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  const getAssetCount = (binName: string) =>
    nonArchivedAssets.filter(a => a.bin === binName).length

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapse}
        className="w-8 h-full flex items-start pt-4 justify-center bg-zinc-900/50 border-r border-zinc-800 hover:bg-zinc-800/50 transition-colors"
        title="Show bins"
      >
        <FolderOpen className="h-4 w-4 text-zinc-500" />
      </button>
    )
  }

  return (
    <div className="w-48 h-full flex flex-col bg-zinc-900/50 border-r border-zinc-800 select-none">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Bins</span>
        <button
          onClick={onToggleCollapse}
          className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Collapse"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* All Assets */}
        <button
          onClick={() => onActiveBinChange('all')}
          className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
            activeBin === 'all'
              ? 'bg-zinc-800 text-white font-medium'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5" />
            All Assets
          </span>
          <span className="text-xs text-zinc-500">{nonArchivedAssets.length}</span>
        </button>

        {/* Unorganized indicator */}
        {unorganizedCount > 0 && unorganizedCount < nonArchivedAssets.length && (
          <button
            onClick={() => onActiveBinChange('all')}
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
          >
            <span className="pl-5.5 italic">Unorganized</span>
            <span>{unorganizedCount}</span>
          </button>
        )}

        {binEntries.length > 0 && <div className="h-px bg-zinc-800 my-1 mx-3" />}

        {/* User bins */}
        {binEntries.map(([name, meta]) => (
          <button
            key={name}
            onClick={() => onActiveBinChange(name)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ binName: name, x: e.clientX, y: e.clientY })
            }}
            title={name}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
              activeBin === name
                ? 'bg-zinc-800 text-white font-medium'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <span className="flex items-center gap-2 truncate">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${BIN_COLORS[meta.color || ''] || 'bg-zinc-500'}`} />
              <span className="truncate">{name}</span>
            </span>
            <span className="text-xs text-zinc-500 flex-shrink-0 ml-1">{getAssetCount(name)}</span>
          </button>
        ))}

        {archivedCount > 0 && <div className="h-px bg-zinc-800 my-1 mx-3" />}

        {/* Archived pseudo-bin */}
        {archivedCount > 0 && (
          <button
            onClick={() => onActiveBinChange('archived')}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
              activeBin === 'archived'
                ? 'bg-zinc-800 text-white font-medium'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <span className="flex items-center gap-2">
              <Archive className="h-3.5 w-3.5" />
              Archived
            </span>
            <span className="text-xs text-zinc-500">{archivedCount}</span>
          </button>
        )}
      </div>

      {/* New Bin button */}
      <div className="border-t border-zinc-800 p-2">
        <button
          onClick={onCreateBin}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New Bin
        </button>
      </div>

      {/* Bin context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl py-1.5 min-w-[160px] z-[9999]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { onRenameBin(contextMenu.binName); setContextMenu(null) }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 rounded-md transition-colors text-left"
          >
            <Pencil className="h-4 w-4" />
            Rename
          </button>

          <div className="relative">
            <button
              onClick={() => setShowColorPicker(showColorPicker ? null : contextMenu.binName)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 rounded-md transition-colors text-left"
            >
              <Palette className="h-4 w-4" />
              Color
            </button>
            {showColorPicker === contextMenu.binName && (
              <div className="absolute left-full top-0 ml-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl p-2 z-[10000]">
                <div className="grid grid-cols-4 gap-1.5">
                  {Object.entries(BIN_COLOR_HEX).map(([name, hex]) => (
                    <button
                      key={name}
                      onClick={() => {
                        onSetBinColor(contextMenu.binName, name)
                        setContextMenu(null)
                        setShowColorPicker(null)
                      }}
                      className="w-6 h-6 rounded-full border-2 border-transparent hover:border-white/50 transition-colors"
                      style={{ backgroundColor: hex }}
                      title={name}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="h-px bg-zinc-700 my-1" />
          <button
            onClick={() => { onDeleteBin(contextMenu.binName); setContextMenu(null) }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-md transition-colors text-left"
          >
            <Trash2 className="h-4 w-4" />
            Delete Bin
          </button>
        </div>
      )}
    </div>
  )
}
