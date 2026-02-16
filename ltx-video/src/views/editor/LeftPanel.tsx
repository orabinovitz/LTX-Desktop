import React, { useState } from 'react'
import {
  FolderPlus, Folder, Upload, ChevronLeft, ChevronDown, ChevronRight,
  X, RefreshCw, Loader2, Trash2, Music, Layers, Video, Image,
  Plus, FileUp, Film, LayoutGrid, List, Clock,
} from 'lucide-react'
import type { Asset, TimelineClip, Timeline } from '../../types/project'
import { VideoThumbnailCard } from './VideoThumbnailCard'
import { getColorLabel } from './video-editor-utils'

export interface LeftPanelProps {
  leftPanelWidth: number
  assetsHeight: number
  takesViewAssetId: string | null
  setTakesViewAssetId: (id: string | null) => void
  creatingBin: boolean
  setCreatingBin: (v: boolean) => void
  newBinName: string
  setNewBinName: (v: string) => void
  newBinInputRef: React.RefObject<HTMLInputElement | null>
  selectedBin: string | null
  setSelectedBin: (v: string | null) => void
  bins: string[]
  filteredAssets: Asset[]
  assetFilter: 'all' | 'video' | 'image' | 'audio'
  setAssetFilter: (v: 'all' | 'video' | 'image' | 'audio') => void
  selectedAssetIds: Set<string>
  setSelectedAssetIds: React.Dispatch<React.SetStateAction<Set<string>>>
  assetLasso: { startX: number; startY: number; currentX: number; currentY: number } | null
  setAssetLasso: React.Dispatch<React.SetStateAction<{ startX: number; startY: number; currentX: number; currentY: number } | null>>
  assetGridRef: React.RefObject<HTMLDivElement | null>
  setAssetContextMenu: React.Dispatch<React.SetStateAction<{ assetId: string; x: number; y: number } | null>>
  setBinContextMenu: React.Dispatch<React.SetStateAction<{ bin: string; x: number; y: number } | null>>
  setTakeContextMenu: React.Dispatch<React.SetStateAction<{ assetId: string; takeIndex: number; x: number; y: number } | null>>
  assets: Asset[]
  thumbnailMap: Record<string, string>
  currentProjectId: string | null
  pushAssetUndoRef: React.MutableRefObject<() => void>
  updateAsset: (projectId: string, assetId: string, updates: Partial<Asset>) => void
  loadSourceAsset: (asset: Asset) => void
  handleImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  setAssetActiveTake: (projectId: string, assetId: string, takeIndex: number) => void
  addClipToTimeline: (asset: Asset, trackIndex?: number, startTime?: number) => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  deleteTakeFromAsset: (projectId: string, assetId: string, takeIndex: number) => void
  deleteAsset: (projectId: string, assetId: string) => void
  handleRegenerate: (assetId: string, clipId?: string) => void
  handleCancelRegeneration: () => void
  isRegenerating: boolean
  regeneratingAssetId: string | null
  regenProgress: number
  regenStatusMessage: string
  handleResizeDragStart: (type: 'left' | 'right' | 'timeline' | 'assets', e: React.MouseEvent) => void
  timelineAddMenuOpen: boolean
  setTimelineAddMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  handleAddTimeline: () => void
  setShowImportTimelineModal: (v: boolean) => void
  timelines: Timeline[]
  activeTimeline: Timeline | null
  handleSwitchTimeline: (id: string) => void
  handleDeleteTimeline: (id: string) => void
  handleTimelineTabContextMenu: (e: React.MouseEvent, timelineId: string) => void
  openTimelineIds: Set<string>
}

export function LeftPanel(props: LeftPanelProps) {
  const {
    leftPanelWidth,
    assetsHeight,
    takesViewAssetId,
    setTakesViewAssetId,
    creatingBin,
    setCreatingBin,
    newBinName,
    setNewBinName,
    newBinInputRef,
    selectedBin,
    setSelectedBin,
    bins,
    filteredAssets,
    assetFilter,
    setAssetFilter,
    selectedAssetIds,
    setSelectedAssetIds,
    assetLasso,
    setAssetLasso,
    assetGridRef,
    setAssetContextMenu,
    setBinContextMenu,
    setTakeContextMenu,
    assets,
    thumbnailMap,
    currentProjectId,
    pushAssetUndoRef,
    updateAsset,
    loadSourceAsset,
    handleImportFile,
    fileInputRef,
    setAssetActiveTake,
    addClipToTimeline,
    setClips,
    deleteTakeFromAsset,
    deleteAsset,
    handleRegenerate,
    handleCancelRegeneration,
    isRegenerating,
    regeneratingAssetId,
    regenProgress,
    regenStatusMessage,
    handleResizeDragStart,
    timelineAddMenuOpen,
    setTimelineAddMenuOpen,
    handleAddTimeline,
    setShowImportTimelineModal,
    timelines,
    activeTimeline,
    handleSwitchTimeline,
    handleDeleteTimeline,
    handleTimelineTabContextMenu,
    openTimelineIds,
  } = props

  const [assetViewMode, setAssetViewMode] = useState<'grid' | 'list'>('grid')

  return (
    <div className="flex-shrink-0 border-r border-zinc-800 flex flex-col" style={{ width: leftPanelWidth }}>
      {/* Assets Section */}
      <div className="flex flex-col min-h-0" style={assetsHeight > 0 ? { height: assetsHeight } : { flex: '1 1 60%' }}>
        <div className="p-4 pb-2 space-y-2 flex-shrink-0">
          {!takesViewAssetId ? (<>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Assets</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCreatingBin(true)}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                title="Create bin"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                title="Import media"
              >
                <Upload className="h-4 w-4" />
              </button>
            </div>
          </div>
          
          {/* Type filter + view toggle */}
          <div className="flex items-center gap-1.5">
            <div className="flex gap-1 bg-zinc-900 rounded-lg p-0.5 flex-1">
              {(['all', 'video', 'image', 'audio'] as const).map(filter => (
                <button
                  key={filter}
                  onClick={() => setAssetFilter(filter)}
                  className={`flex-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    assetFilter === filter 
                      ? 'bg-zinc-800 text-white' 
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {filter.charAt(0).toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
            <div className="flex bg-zinc-900 rounded-lg p-0.5">
              <button
                onClick={() => setAssetViewMode('grid')}
                className={`p-1 rounded transition-colors ${assetViewMode === 'grid' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                title="Grid view"
              >
                <LayoutGrid className="h-3 w-3" />
              </button>
              <button
                onClick={() => setAssetViewMode('list')}
                className={`p-1 rounded transition-colors ${assetViewMode === 'list' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                title="List view"
              >
                <List className="h-3 w-3" />
              </button>
            </div>
          </div>
          
          {/* Bins row */}
          {(bins.length > 0 || creatingBin) && (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setSelectedBin(null)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 ${
                  selectedBin === null
                    ? 'bg-violet-600/30 text-violet-300 border border-violet-500/40'
                    : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                All
              </button>
              {bins.map(bin => (
                <button
                  key={bin}
                  onClick={() => setSelectedBin(selectedBin === bin ? null : bin)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setBinContextMenu({ bin, x: e.clientX, y: e.clientY })
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.currentTarget.classList.add('ring-2', 'ring-violet-400')
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.classList.remove('ring-2', 'ring-violet-400')
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.currentTarget.classList.remove('ring-2', 'ring-violet-400')
                    if (!currentProjectId) return
                    pushAssetUndoRef.current()
                    // Handle multi-asset drag
                    const assetIdsJson = e.dataTransfer.getData('assetIds')
                    if (assetIdsJson) {
                      try {
                        const ids: string[] = JSON.parse(assetIdsJson)
                        ids.forEach(id => updateAsset(currentProjectId, id, { bin }))
                        setSelectedAssetIds(new Set())
                      } catch { /* ignore parse errors */ }
                    } else {
                      const assetId = e.dataTransfer.getData('assetId')
                      if (assetId) updateAsset(currentProjectId, assetId, { bin })
                    }
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 group/bin ${
                    selectedBin === bin
                      ? 'bg-violet-600/30 text-violet-300 border border-violet-500/40'
                      : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300 border border-transparent'
                  }`}
                >
                  <Folder className="h-3 w-3" />
                  {bin}
                  <span className="text-zinc-600 text-[9px]">
                    {assets.filter(a => a.bin === bin).length}
                  </span>
                </button>
              ))}
              {creatingBin && (
                <div className="flex items-center gap-1">
                  <input
                    ref={newBinInputRef as React.RefObject<HTMLInputElement>}
                    type="text"
                    value={newBinName}
                    onChange={(e) => setNewBinName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newBinName.trim()) {
                        if (selectedAssetIds.size > 0 && currentProjectId) {
                          pushAssetUndoRef.current()
                          const binName = newBinName.trim()
                          selectedAssetIds.forEach(id => updateAsset(currentProjectId, id, { bin: binName }))
                          setSelectedAssetIds(new Set())
                        }
                        setCreatingBin(false)
                        setNewBinName('')
                      }
                      if (e.key === 'Escape') {
                        setCreatingBin(false)
                        setNewBinName('')
                      }
                    }}
                    onBlur={() => {
                      if (newBinName.trim() && selectedAssetIds.size > 0 && currentProjectId) {
                        pushAssetUndoRef.current()
                        const binName = newBinName.trim()
                        selectedAssetIds.forEach(id => updateAsset(currentProjectId, id, { bin: binName }))
                        setSelectedAssetIds(new Set())
                      }
                      setCreatingBin(false)
                      setNewBinName('')
                    }}
                    placeholder="Bin name..."
                    className="w-20 px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 border border-zinc-600 text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                  />
                </div>
              )}
            </div>
          )}
          
          <input
            ref={fileInputRef as React.RefObject<HTMLInputElement>}
            type="file"
            accept="video/*,audio/*,image/*"
            multiple
            onChange={handleImportFile}
            className="hidden"
          />
          </>) : (
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Takes</h3>
            </div>
          )}
        </div>
        
        {/* Takes drill-in view */}
        {takesViewAssetId && (() => {
          const takesAsset = assets.find(a => a.id === takesViewAssetId)
          if (!takesAsset || !takesAsset.takes || takesAsset.takes.length <= 1) {
            // Asset no longer has takes, exit view
            setTakesViewAssetId(null)
            return null
          }
          return (
            <div className="flex-1 overflow-auto p-3 pt-0">
              {/* Header with back button */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setTakesViewAssetId(null)}
                  className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                  title="Back to assets"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">
                    {takesAsset.prompt?.slice(0, 40) || 'Asset'}{(takesAsset.prompt?.length ?? 0) > 40 ? '...' : ''}
                  </p>
                  <p className="text-[10px] text-zinc-500">
                    {takesAsset.takes.length} takes
                  </p>
                </div>
                {/* Regenerate to create another take / Cancel */}
                {takesAsset.generationParams && (
                  isRegenerating && regeneratingAssetId === takesAsset.id ? (
                    <button
                      onClick={() => handleCancelRegeneration()}
                      className="px-2 py-1 rounded-lg bg-red-900/20 text-red-400 hover:bg-red-900/40 transition-colors text-[10px] font-medium flex items-center gap-1 border border-red-500/30"
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={() => handleRegenerate(takesAsset.id)}
                      disabled={isRegenerating}
                      className="px-2 py-1 rounded-lg bg-violet-600/20 text-violet-300 hover:bg-violet-600/40 transition-colors text-[10px] font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" />
                      New Take
                    </button>
                  )
                )}
              </div>
              
              {/* Takes grid */}
              <div className="grid grid-cols-2 gap-2">
                {takesAsset.takes.map((take, idx) => {
                  const isActive = (takesAsset.activeTakeIndex ?? 0) === idx
                  return (
                    <div
                      key={idx}
                      className={`relative group rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                        isActive
                          ? 'border-violet-500 ring-2 ring-violet-500/40 shadow-lg shadow-violet-500/20'
                          : 'border-zinc-800 hover:border-zinc-600'
                      }`}
                      onClick={() => {
                        if (currentProjectId) {
                          pushAssetUndoRef.current()
                          setAssetActiveTake(currentProjectId, takesAsset.id, idx)
                        }
                      }}
                      onDoubleClick={() => {
                        if (currentProjectId) {
                          pushAssetUndoRef.current()
                          setAssetActiveTake(currentProjectId, takesAsset.id, idx)
                        }
                        addClipToTimeline({ ...takesAsset, url: take.url, path: take.path }, 0)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setTakeContextMenu({ assetId: takesAsset.id, takeIndex: idx, x: e.clientX, y: e.clientY })
                      }}
                    >
                      {takesAsset.type === 'video' ? (
                        <VideoThumbnailCard
                          url={take.url}
                          thumbnailUrl={thumbnailMap[take.url]}
                        />
                      ) : (
                        <img src={take.url} alt="" className="w-full aspect-video object-cover" />
                      )}
                      
                      {/* Active overlay */}
                      {isActive && (
                        <div className="absolute inset-0 bg-violet-600/15 pointer-events-none" />
                      )}
                      
                      {/* Take label */}
                      <div className="absolute bottom-1 left-1 flex items-center gap-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          isActive
                            ? 'bg-violet-500 text-white'
                            : 'bg-black/70 text-zinc-300'
                        }`}>
                          Take {idx + 1}
                        </span>
                      </div>
                      
                      {/* Active badge */}
                      {isActive && (
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-violet-500 text-white text-[9px] font-semibold">
                          Active
                        </div>
                      )}
                      
                      {/* Timestamp */}
                      <div className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-[9px] text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        {new Date(take.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      
                      {/* Delete take button (visible on hover, only if more than 1 take) */}
                      {takesAsset.takes!.length > 1 && (
                        <button
                          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/70 text-zinc-400 hover:text-red-400 hover:bg-red-900/60 opacity-0 group-hover:opacity-100 transition-all z-10"
                          title="Delete take"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Delete take ${idx + 1}?`)) {
                              if (currentProjectId) {
                                pushAssetUndoRef.current()
                                // Update any clips referencing this asset
                                setClips(prev => prev.map(c => {
                                  if (c.assetId !== takesAsset.id) return c
                                  const cIdx = c.takeIndex ?? (takesAsset.activeTakeIndex ?? takesAsset.takes!.length - 1)
                                  if (cIdx === idx) {
                                    return { ...c, takeIndex: Math.max(0, idx - 1) }
                                  } else if (cIdx > idx) {
                                    return { ...c, takeIndex: cIdx - 1 }
                                  }
                                  return c
                                }))
                                deleteTakeFromAsset(currentProjectId, takesAsset.id, idx)
                              }
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                      
                      {/* Regenerating overlay */}
                      {isRegenerating && regeneratingAssetId === takesAsset.id && idx === takesAsset.takes!.length - 1 && (
                        <div className="absolute inset-0 bg-violet-900/40 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                          <Loader2 className="h-5 w-5 text-violet-300 animate-spin mb-1" />
                          <span className="text-[9px] text-violet-200 font-medium">{regenProgress}%</span>
                          <span className="text-[8px] text-violet-300/70 mb-1.5">{regenStatusMessage}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCancelRegeneration() }}
                            className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-600/60 text-[9px] text-zinc-300 hover:text-red-400 hover:border-red-500/50 hover:bg-red-900/30 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}
        
        {/* Normal asset grid (hidden when in takes view) */}
        {!takesViewAssetId && <div
          className="flex-1 overflow-auto p-3 pt-0 relative select-none"
          ref={assetGridRef as React.RefObject<HTMLDivElement>}
          onMouseDown={(e) => {
            // Only start lasso if clicking on the background (not on an asset card)
            if ((e.target as HTMLElement).closest('[data-asset-card]')) return
            if (e.button !== 0) return
            const rect = assetGridRef.current?.getBoundingClientRect()
            if (!rect) return
            const scrollTop = assetGridRef.current?.scrollTop || 0
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top + scrollTop
            setAssetLasso({ startX: x, startY: y, currentX: x, currentY: y })
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              setSelectedAssetIds(new Set())
            }
          }}
          onMouseMove={(e) => {
            if (!assetLasso || !assetGridRef.current) return
            const rect = assetGridRef.current.getBoundingClientRect()
            const scrollTop = assetGridRef.current.scrollTop || 0
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top + scrollTop
            setAssetLasso(prev => prev ? { ...prev, currentX: x, currentY: y } : null)
            
            // Determine which asset cards intersect with the lasso rect
            const lassoLeft = Math.min(assetLasso.startX, x)
            const lassoRight = Math.max(assetLasso.startX, x)
            const lassoTop = Math.min(assetLasso.startY, y)
            const lassoBottom = Math.max(assetLasso.startY, y)
            
            const newSelected = new Set<string>(e.ctrlKey || e.metaKey || e.shiftKey ? selectedAssetIds : [])
            const cards = assetGridRef.current.querySelectorAll('[data-asset-card]')
            cards.forEach(card => {
              const cardRect = card.getBoundingClientRect()
              const cardLeft = cardRect.left - rect.left
              const cardRight = cardRect.right - rect.left
              const cardTop = cardRect.top - rect.top + scrollTop
              const cardBottom = cardRect.bottom - rect.top + scrollTop
              
              // Check intersection
              if (cardLeft < lassoRight && cardRight > lassoLeft && cardTop < lassoBottom && cardBottom > lassoTop) {
                const id = (card as HTMLElement).dataset.assetId
                if (id) newSelected.add(id)
              }
            })
            setSelectedAssetIds(newSelected)
          }}
          onMouseUp={() => {
            setAssetLasso(null)
          }}
          onMouseLeave={() => {
            setAssetLasso(null)
          }}
        >
          {/* Lasso rectangle overlay */}
          {assetLasso && (() => {
            const left = Math.min(assetLasso.startX, assetLasso.currentX)
            const top = Math.min(assetLasso.startY, assetLasso.currentY)
            const width = Math.abs(assetLasso.currentX - assetLasso.startX)
            const height = Math.abs(assetLasso.currentY - assetLasso.startY)
            if (width < 3 && height < 3) return null
            return (
              <div
                className="absolute border border-violet-400 bg-violet-500/15 rounded-sm pointer-events-none z-30"
                style={{ left, top, width, height }}
              />
            )
          })()}
          
          {/* Selection count indicator (minimal) */}
          {filteredAssets.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-zinc-500">No assets yet</p>
              <p className="text-xs text-zinc-600 mt-1">Generate in Gen Space or import</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
              >
                Import Media
              </button>
            </div>
          ) : assetViewMode === 'grid' ? (
            <div className="grid grid-cols-2 gap-2">
              {filteredAssets.map(asset => {
                const cl = getColorLabel(asset.colorLabel)
                return (
                <div
                  key={asset.id}
                  data-asset-card
                  data-asset-id={asset.id}
                  className={`relative group cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                    selectedAssetIds.has(asset.id)
                      ? 'border-violet-500 ring-2 ring-violet-500/40 shadow-lg shadow-violet-500/20'
                      : 'border-zinc-800 hover:border-zinc-600'
                  }`}
                  draggable
                  onDragStart={(e) => {
                    if (selectedAssetIds.size > 0 && selectedAssetIds.has(asset.id)) {
                      e.dataTransfer.setData('assetIds', JSON.stringify([...selectedAssetIds]))
                    } else {
                      e.dataTransfer.setData('assetId', asset.id)
                    }
                    e.dataTransfer.setData('asset', JSON.stringify(asset))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.ctrlKey || e.metaKey) {
                      setSelectedAssetIds(prev => {
                        const next = new Set(prev)
                        if (next.has(asset.id)) next.delete(asset.id)
                        else next.add(asset.id)
                        return next
                      })
                    } else if (e.shiftKey && selectedAssetIds.size > 0) {
                      const lastId = [...selectedAssetIds].pop()
                      const lastIdx = filteredAssets.findIndex(a => a.id === lastId)
                      const thisIdx = filteredAssets.findIndex(a => a.id === asset.id)
                      if (lastIdx >= 0 && thisIdx >= 0) {
                        const start = Math.min(lastIdx, thisIdx)
                        const end = Math.max(lastIdx, thisIdx)
                        const next = new Set(selectedAssetIds)
                        for (let i = start; i <= end; i++) next.add(filteredAssets[i].id)
                        setSelectedAssetIds(next)
                      }
                    } else {
                      if (selectedAssetIds.has(asset.id) && selectedAssetIds.size === 1) {
                        setSelectedAssetIds(new Set())
                      } else {
                        setSelectedAssetIds(new Set([asset.id]))
                      }
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (asset.takes && asset.takes.length > 1) {
                      setTakesViewAssetId(asset.id)
                      setSelectedAssetIds(new Set())
                    } else {
                      loadSourceAsset(asset)
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (!selectedAssetIds.has(asset.id)) {
                      setSelectedAssetIds(new Set([asset.id]))
                    }
                    setAssetContextMenu({ assetId: asset.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  {/* Color label strip */}
                  {cl && (
                    <>
                      <div className="absolute top-0 left-0 right-0 h-[3px] z-10" style={{ backgroundColor: cl.color }} />
                      <div className="absolute top-0 left-0 bottom-0 w-[3px] z-10" style={{ backgroundColor: cl.color }} />
                    </>
                  )}
                  {asset.type === 'video' ? (
                    <VideoThumbnailCard
                      url={asset.url}
                      thumbnailUrl={thumbnailMap[asset.url]}
                    />
                  ) : asset.type === 'audio' ? (
                    <div className="w-full aspect-video bg-gradient-to-br from-emerald-900/60 to-zinc-900 flex flex-col items-center justify-center gap-1.5">
                      <Music className="h-6 w-6 text-emerald-400" />
                      <div className="flex items-center gap-0.5">
                        {[3, 5, 8, 6, 9, 4, 7, 5, 3, 6, 8, 4].map((h, i) => (
                          <div
                            key={i}
                            className="w-0.5 rounded-full bg-emerald-500/60"
                            style={{ height: `${h * 1.5}px` }}
                          />
                        ))}
                      </div>
                      <p className="text-[9px] text-emerald-300/70 truncate max-w-[90%] px-1">
                        {asset.path || 'Audio'}
                      </p>
                    </div>
                  ) : asset.type === 'adjustment' ? (
                    <div className="w-full aspect-video bg-gradient-to-br from-violet-900/40 to-zinc-900 flex flex-col items-center justify-center gap-1.5 border border-dashed border-violet-500/30">
                      <Layers className="h-6 w-6 text-violet-400" />
                      <p className="text-[9px] text-violet-300/70 font-medium">Adjustment Layer</p>
                    </div>
                  ) : (
                    <img src={asset.url} alt="" className="w-full aspect-video object-cover" />
                  )}
                  {selectedAssetIds.has(asset.id) && (
                    <div className="absolute inset-0 bg-violet-600/25 pointer-events-none z-[1]" />
                  )}
                  {!selectedAssetIds.has(asset.id) && (
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none" />
                  )}
                  <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all z-10">
                    {asset.generationParams && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRegenerate(asset.id)
                        }}
                        disabled={isRegenerating}
                        className={`p-1 rounded bg-black/70 transition-colors ${
                          isRegenerating && regeneratingAssetId === asset.id
                            ? 'text-violet-400 animate-spin'
                            : 'text-zinc-400 hover:text-violet-400 hover:bg-violet-900/50'
                        }`}
                        title="Regenerate"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (currentProjectId) { pushAssetUndoRef.current(); deleteAsset(currentProjectId, asset.id) }
                      }}
                      className="p-1 rounded bg-black/70 text-zinc-500 hover:text-red-400 hover:bg-red-900/50 transition-colors"
                      title="Delete asset"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  {isRegenerating && regeneratingAssetId === asset.id && (
                    <div className="absolute inset-0 bg-violet-900/40 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                      <Loader2 className="h-5 w-5 text-violet-300 animate-spin mb-1" />
                      <span className="text-[9px] text-violet-200 font-medium">{regenProgress}%</span>
                      <span className="text-[8px] text-violet-300/70 mb-1.5">{regenStatusMessage}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancelRegeneration() }}
                        className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-600/60 text-[9px] text-zinc-300 hover:text-red-400 hover:border-red-500/50 hover:bg-red-900/30 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {asset.takes && asset.takes.length > 1 && (
                    <div className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/80 z-10">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (currentProjectId) {
                            pushAssetUndoRef.current()
                            const idx = Math.max(0, (asset.activeTakeIndex ?? 0) - 1)
                            setAssetActiveTake(currentProjectId, asset.id, idx)
                          }
                        }}
                        disabled={(asset.activeTakeIndex ?? 0) === 0}
                        className="p-0.5 text-violet-300 hover:text-white disabled:text-zinc-600 transition-colors"
                        title="Previous take"
                      >
                        <ChevronLeft className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setTakesViewAssetId(asset.id)
                          setSelectedAssetIds(new Set())
                        }}
                        className="px-0.5 cursor-pointer hover:text-white transition-colors flex items-center gap-1"
                        title="View all takes"
                      >
                        <Layers className="h-2.5 w-2.5 text-violet-400" />
                        <span className="text-[9px] text-violet-300 font-medium">
                          {(asset.activeTakeIndex ?? 0) + 1}/{asset.takes.length}
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (currentProjectId && asset.takes) {
                            pushAssetUndoRef.current()
                            const idx = Math.min(asset.takes.length - 1, (asset.activeTakeIndex ?? 0) + 1)
                            setAssetActiveTake(currentProjectId, asset.id, idx)
                          }
                        }}
                        disabled={asset.takes && (asset.activeTakeIndex ?? 0) >= asset.takes.length - 1}
                        className="p-0.5 text-violet-300 hover:text-white disabled:text-zinc-600 transition-colors"
                        title="Next take"
                      >
                        <ChevronRight className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  {asset.bin && (
                    <div className="absolute top-1.5 left-8 flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/70 text-[9px] text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                      <Folder className="h-2.5 w-2.5" />
                      {asset.bin}
                    </div>
                  )}
                  <div className="absolute bottom-1 left-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white">
                    {asset.type === 'video' ? <Video className="h-3 w-3" /> : asset.type === 'audio' ? <Music className="h-3 w-3" /> : asset.type === 'adjustment' ? <Layers className="h-3 w-3" /> : <Image className="h-3 w-3" />}
                    {asset.type === 'adjustment' ? 'Adj' : asset.duration ? `${asset.duration.toFixed(1)}s` : ''}
                  </div>
                </div>
              )})}
            </div>
          ) : (
            /* ── List View ── */
            <div className="flex flex-col gap-0.5">
              {filteredAssets.map(asset => {
                const cl = getColorLabel(asset.colorLabel)
                const name = asset.path ? asset.path.split(/[/\\]/).pop() || asset.path : asset.type === 'adjustment' ? 'Adjustment Layer' : asset.type.charAt(0).toUpperCase() + asset.type.slice(1)
                return (
                  <div
                    key={asset.id}
                    data-asset-card
                    data-asset-id={asset.id}
                    className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-all ${
                      selectedAssetIds.has(asset.id)
                        ? 'bg-violet-600/20 ring-1 ring-violet-500/50'
                        : 'hover:bg-zinc-800/60'
                    }`}
                    draggable
                    onDragStart={(e) => {
                      if (selectedAssetIds.size > 0 && selectedAssetIds.has(asset.id)) {
                        e.dataTransfer.setData('assetIds', JSON.stringify([...selectedAssetIds]))
                      } else {
                        e.dataTransfer.setData('assetId', asset.id)
                      }
                      e.dataTransfer.setData('asset', JSON.stringify(asset))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (e.ctrlKey || e.metaKey) {
                        setSelectedAssetIds(prev => {
                          const next = new Set(prev)
                          if (next.has(asset.id)) next.delete(asset.id)
                          else next.add(asset.id)
                          return next
                        })
                      } else if (e.shiftKey && selectedAssetIds.size > 0) {
                        const lastId = [...selectedAssetIds].pop()
                        const lastIdx = filteredAssets.findIndex(a => a.id === lastId)
                        const thisIdx = filteredAssets.findIndex(a => a.id === asset.id)
                        if (lastIdx >= 0 && thisIdx >= 0) {
                          const start = Math.min(lastIdx, thisIdx)
                          const end = Math.max(lastIdx, thisIdx)
                          const next = new Set(selectedAssetIds)
                          for (let i = start; i <= end; i++) next.add(filteredAssets[i].id)
                          setSelectedAssetIds(next)
                        }
                      } else {
                        if (selectedAssetIds.has(asset.id) && selectedAssetIds.size === 1) {
                          setSelectedAssetIds(new Set())
                        } else {
                          setSelectedAssetIds(new Set([asset.id]))
                        }
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (asset.takes && asset.takes.length > 1) {
                        setTakesViewAssetId(asset.id)
                        setSelectedAssetIds(new Set())
                      } else {
                        loadSourceAsset(asset)
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!selectedAssetIds.has(asset.id)) {
                        setSelectedAssetIds(new Set([asset.id]))
                      }
                      setAssetContextMenu({ assetId: asset.id, x: e.clientX, y: e.clientY })
                    }}
                  >
                    {/* Color label dot */}
                    {cl ? (
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cl.color }} />
                    ) : (
                      <div className="w-2 flex-shrink-0" />
                    )}
                    {/* Thumbnail */}
                    <div className="w-10 h-7 flex-shrink-0 rounded overflow-hidden bg-zinc-800">
                      {asset.type === 'video' ? (
                        thumbnailMap[asset.url] ? (
                          <img src={thumbnailMap[asset.url]} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><Film className="h-3 w-3 text-zinc-500" /></div>
                        )
                      ) : asset.type === 'audio' ? (
                        <div className="w-full h-full flex items-center justify-center bg-emerald-900/40"><Music className="h-3 w-3 text-emerald-400" /></div>
                      ) : asset.type === 'adjustment' ? (
                        <div className="w-full h-full flex items-center justify-center bg-violet-900/30"><Layers className="h-3 w-3 text-violet-400" /></div>
                      ) : (
                        <img src={asset.url} alt="" className="w-full h-full object-cover" />
                      )}
                    </div>
                    {/* Name + metadata */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-zinc-200 truncate leading-tight">{name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[9px] text-zinc-500 uppercase font-medium">{asset.type}</span>
                        {asset.duration != null && (
                          <span className="text-[9px] text-zinc-500 flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {asset.duration.toFixed(1)}s
                          </span>
                        )}
                        {asset.resolution && (
                          <span className="text-[9px] text-zinc-500">{asset.resolution}</span>
                        )}
                        {asset.takes && asset.takes.length > 1 && (
                          <span className="text-[9px] text-violet-400">{asset.takes.length} takes</span>
                        )}
                      </div>
                    </div>
                    {/* Delete button on hover */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (currentProjectId) { pushAssetUndoRef.current(); deleteAsset(currentProjectId, asset.id) }
                      }}
                      className="p-1 rounded text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Delete asset"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>}
      </div>
      
      {/* Resize handle between Assets and Timelines */}
      <div
        className="h-1 flex-shrink-0 cursor-row-resize bg-transparent hover:bg-violet-500/40 active:bg-violet-500/60 transition-colors relative group z-10"
        onMouseDown={(e) => handleResizeDragStart('assets', e)}
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>
      
      {/* Timelines Section */}
      <div className="flex flex-col min-h-0" style={assetsHeight > 0 ? { flex: '1 1 0%' } : { flex: '0 1 40%', minHeight: 100 }}>
        <div className="p-3 pb-2 flex items-center justify-between flex-shrink-0">
          <h3 className="text-sm font-semibold text-white">Timelines</h3>
          <div className="relative">
            <button
              onClick={() => setTimelineAddMenuOpen(prev => !prev)}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
              title="Add timeline"
            >
              <Plus className="h-4 w-4" />
            </button>
            {timelineAddMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 py-1 overflow-hidden">
                <button
                  onClick={() => { handleAddTimeline(); setTimelineAddMenuOpen(false) }}
                  className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Timeline
                </button>
                <button
                  onClick={() => { setShowImportTimelineModal(true); setTimelineAddMenuOpen(false) }}
                  className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  Import from XML
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto px-3 pb-3 space-y-1">
          {timelines.map(tl => {
            const isActive = tl.id === activeTimeline?.id
            const clipCount = tl.clips?.length || 0
            const tlDuration = tl.clips?.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0) || 0
            const formatDur = (s: number) => {
              const m = Math.floor(s / 60)
              const sec = Math.floor(s % 60)
              return m > 0 ? `${m}m ${sec}s` : `${sec}s`
            }
            
            return (
              <div
                key={tl.id}
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  isActive 
                    ? 'bg-violet-600/20 border border-violet-500/40' 
                    : 'hover:bg-zinc-800 border border-transparent'
                }`}
                draggable={!isActive}
                onDragStart={(e) => {
                  if (isActive) { e.preventDefault(); return }
                  e.dataTransfer.setData('timeline', JSON.stringify({ id: tl.id, name: tl.name }))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => handleSwitchTimeline(tl.id)}
                onContextMenu={(e) => handleTimelineTabContextMenu(e, tl.id)}
              >
                <Film className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-violet-400' : 'text-zinc-500'}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium truncate ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                    {tl.name}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span>{clipCount} clip{clipCount !== 1 ? 's' : ''}</span>
                    {clipCount > 0 && (
                      <>
                        <span>·</span>
                        <span>{formatDur(tlDuration)}</span>
                      </>
                    )}
                  </div>
                </div>
                {isActive ? (
                  <span className="text-[9px] text-violet-400 font-medium uppercase tracking-wider flex-shrink-0">Active</span>
                ) : openTimelineIds.has(tl.id) ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 flex-shrink-0" title="Open in tabs" />
                ) : null}
                {/* Delete button (visible on hover, not for last timeline) */}
                {timelines.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteTimeline(tl.id)
                    }}
                    className="p-1 rounded hover:bg-red-500/20 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    title="Delete timeline"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
