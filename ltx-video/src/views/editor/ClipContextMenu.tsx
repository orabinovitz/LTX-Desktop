import React from 'react'
import {
  Clipboard, Copy, Scissors, Trash2, Layers, Type, X, RefreshCw,
  ZoomIn, Film, Eye, FolderOpen, RotateCcw, Volume2, VolumeX,
  FlipHorizontal2, FlipVertical2, Link2, Unlink2, ArrowUp, ArrowDown,
  ChevronLeft, ChevronRight, Sparkles,
} from 'lucide-react'
import type { Asset, TimelineClip, Track, TextOverlayStyle } from '../../types/project'
import { TEXT_PRESETS } from '../../types/project'

export interface ClipContextMenuProps {
  clipContextMenu: { clipId: string; x: number; y: number }
  contextClip: TimelineClip | null
  clipContextMenuRef: React.RefObject<HTMLDivElement>
  clips: TimelineClip[]
  tracks: Track[]
  selectedClipIds: Set<string>
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>
  currentTime: number
  hasClipboard: boolean
  isRegenerating: boolean
  i2vClipId: string | null
  upscalingClipIds: Set<string>
  assets: Asset[]
  isRetaking: boolean
  assetGridRef: React.RefObject<HTMLDivElement | null>
  handleCopy: () => void
  handleCut: () => void
  handlePaste: () => void
  setClipContextMenu: React.Dispatch<React.SetStateAction<{ clipId: string; x: number; y: number } | null>>
  addTextClip: (style?: Partial<TextOverlayStyle>, startTime?: number) => void
  pushUndo: () => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  handleRegenerate: (assetId: string, clipId: string) => void
  handleCancelRegeneration: () => void
  handleUpscaleClip: (clipId: string) => void
  handleClipTakeChange: (clipId: string, direction: 'prev' | 'next') => void
  handleDeleteTake: (clipId: string) => void
  duplicateClip: (clipId: string) => void
  splitClipAtPlayhead: (clipId: string) => void
  removeClip: (clipId: string) => void
  updateClip: (clipId: string, updates: Partial<TimelineClip>) => void
  getLiveAsset: (clip: TimelineClip) => Asset | null | undefined
  getMaxClipDuration: (clip: TimelineClip) => number
  setAssetFilter: (v: 'all' | 'video' | 'image' | 'audio') => void
  setSelectedBin: (v: string | null) => void
  setTakesViewAssetId: (v: string | null) => void
  setSelectedAssetIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setI2vClipId: (v: string | null) => void
  setI2vPrompt: (v: string) => void
  setRetakeClipId: (v: string | null) => void
  setIcLoraSourceClipId: (v: string | null) => void
  setShowICLoraPanel: (v: boolean) => void
}

export function ClipContextMenu({
  clipContextMenu,
  contextClip,
  clipContextMenuRef,
  clips,
  tracks,
  selectedClipIds,
  setSelectedClipIds,
  currentTime,
  hasClipboard,
  isRegenerating,
  i2vClipId,
  upscalingClipIds,
  assets,
  isRetaking,
  assetGridRef,
  handleCopy,
  handleCut,
  handlePaste,
  setClipContextMenu,
  addTextClip,
  pushUndo,
  setClips,
  handleRegenerate,
  handleCancelRegeneration,
  handleUpscaleClip,
  handleClipTakeChange,
  handleDeleteTake,
  duplicateClip,
  splitClipAtPlayhead,
  removeClip,
  updateClip,
  getLiveAsset,
  getMaxClipDuration,
  setAssetFilter,
  setSelectedBin,
  setTakesViewAssetId,
  setSelectedAssetIds,
  setI2vClipId,
  setI2vPrompt,
  setRetakeClipId,
  setIcLoraSourceClipId,
  setShowICLoraPanel,
}: ClipContextMenuProps) {
  const isBackground = !contextClip
  const multiSelected = selectedClipIds.size > 1

  return (
    <div
      ref={clipContextMenuRef}
      className="fixed bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl py-1.5 z-[60] min-w-[200px] text-xs"
      style={{ left: clipContextMenu.x, top: clipContextMenu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {isBackground ? (
        <>
          {/* Background context menu: Paste + Select All */}
          <button
            onClick={() => {
              handlePaste()
              setClipContextMenu(null)
            }}
            disabled={!hasClipboard}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Clipboard className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">Paste</span>
            <span className="text-zinc-600 text-[10px]">Ctrl+V</span>
          </button>
          <div className="h-px bg-zinc-700 my-1" />
          <button
            onClick={() => {
              addTextClip(undefined, currentTime)
              setClipContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Type className="h-3.5 w-3.5 text-cyan-400" />
            <span className="flex-1">Add Text</span>
          </button>
          {TEXT_PRESETS.slice(0, 4).map(preset => (
            <button
              key={preset.id}
              onClick={() => {
                addTextClip(preset.style, currentTime)
                setClipContextMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 text-zinc-400 hover:bg-zinc-700 flex items-center gap-3 pl-8"
            >
              <span className="text-[10px] text-cyan-500/70">T</span>
              <span className="flex-1">{preset.name}</span>
            </button>
          ))}
          <div className="h-px bg-zinc-700 my-1" />
          <button
            onClick={() => {
              setSelectedClipIds(new Set(clips.map(c => c.id)))
              setClipContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Layers className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">Select All</span>
            <span className="text-zinc-600 text-[10px]">Ctrl+A</span>
          </button>
        </>
      ) : (
        <>
          {/* ---- Edit section ---- */}
          <button
            onClick={() => {
              handleCopy()
              setClipContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Copy className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">{multiSelected ? `Copy ${selectedClipIds.size} Clips` : 'Copy'}</span>
            <span className="text-zinc-600 text-[10px]">Ctrl+C</span>
          </button>
          <button
            onClick={() => {
              handleCut()
              setClipContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Scissors className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">{multiSelected ? `Cut ${selectedClipIds.size} Clips` : 'Cut'}</span>
            <span className="text-zinc-600 text-[10px]">Ctrl+X</span>
          </button>
          <button
            onClick={() => {
              handlePaste()
              setClipContextMenu(null)
            }}
            disabled={!hasClipboard}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Clipboard className="h-3.5 w-3.5 text-zinc-500" />
            <span className="flex-1">Paste</span>
            <span className="text-zinc-600 text-[10px]">Ctrl+V</span>
          </button>

          <div className="h-px bg-zinc-700 my-1" />

          {/* ---- Single clip actions ---- */}
          {!multiSelected && contextClip && (
            <>
              {/* Regenerate option */}
              {(() => {
                const liveAsset = getLiveAsset(contextClip)
                if (!liveAsset || contextClip.type === 'adjustment') return null
                return (
                  <>
                    {contextClip.isRegenerating ? (
                      <button
                        onClick={() => {
                          handleCancelRegeneration()
                          setClipContextMenu(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-3"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span className="flex-1">Cancel Regeneration</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          handleRegenerate(contextClip.assetId!, contextClip.id)
                          setClipContextMenu(null)
                        }}
                        disabled={isRegenerating}
                        className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span className="flex-1">Regenerate Shot</span>
                      </button>
                    )}
                    {/* Take navigation in context menu */}
                    {liveAsset.takes && liveAsset.takes.length > 1 && (
                      <div className="px-3 py-1.5 flex items-center gap-2">
                        <span className="text-[10px] text-zinc-500">Take:</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleClipTakeChange(contextClip.id, 'prev')
                          }}
                          className="p-0.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-white"
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </button>
                        <span className="text-[10px] text-zinc-300 min-w-[28px] text-center">
                          {(contextClip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes.length - 1)) + 1}/{liveAsset.takes.length}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleClipTakeChange(contextClip.id, 'next')
                          }}
                          className="p-0.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-white"
                        >
                          <ChevronRight className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Delete take ${(contextClip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes!.length - 1)) + 1}?`)) {
                              handleDeleteTake(contextClip.id)
                            }
                          }}
                          className="p-0.5 rounded hover:bg-red-900/50 text-zinc-500 hover:text-red-400 ml-1"
                          title="Delete this take"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    <div className="h-px bg-zinc-700 my-1" />
                  </>
                )
              })()}
              {/* Upscale option for video clips */}
              {contextClip.type === 'video' && contextClip.assetId && (
                <button
                  onClick={() => {
                    handleUpscaleClip(contextClip.id)
                    setClipContextMenu(null)
                  }}
                  disabled={upscalingClipIds.has(contextClip.id)}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ZoomIn className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">
                    {upscalingClipIds.has(contextClip.id) ? 'Upscaling...' : 'Upscale (2x)'}
                  </span>
                </button>
              )}
              {/* Image to Video option for image clips */}
              {contextClip.type === 'image' && (
                <button
                  onClick={() => {
                    setI2vClipId(contextClip.id)
                    setI2vPrompt(contextClip.asset?.prompt || '')
                    setClipContextMenu(null)
                  }}
                  disabled={isRegenerating && i2vClipId === contextClip.id}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Film className="h-3.5 w-3.5 text-blue-400" />
                  <span className="flex-1">Generate Video (I2V)</span>
                </button>
              )}
              {/* Reveal in Assets */}
              {contextClip.assetId && (
                <button
                  onClick={() => {
                    const asset = assets.find(a => a.id === contextClip.assetId)
                    if (asset) {
                      setAssetFilter('all')
                      setSelectedBin(asset.bin ?? null)
                      setTakesViewAssetId(null)
                      setSelectedAssetIds(new Set([asset.id]))
                      setTimeout(() => {
                        const card = assetGridRef.current?.querySelector(`[data-asset-id="${asset.id}"]`)
                        if (card) {
                          card.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        }
                      }, 100)
                    }
                    setClipContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <Eye className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">Reveal in Assets</span>
                </button>
              )}
              {/* Reveal in file explorer (Finder/Explorer) */}
              {(() => {
                const liveAsset = getLiveAsset(contextClip)
                if (!liveAsset) return null
                let filePath = liveAsset.path
                if (liveAsset.takes && liveAsset.takes.length > 0) {
                  const takeIdx = contextClip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes.length - 1)
                  const idx = Math.max(0, Math.min(takeIdx, liveAsset.takes.length - 1))
                  filePath = liveAsset.takes[idx].path
                }
                if (!filePath) return null
                const label = window.electronAPI?.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Explorer'
                return (
                  <button
                    onClick={() => {
                      window.electronAPI?.showItemInFolder(filePath)
                      setClipContextMenu(null)
                    }}
                    className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="flex-1">{label}</span>
                  </button>
                )
              })()}
              <button
                onClick={() => {
                  duplicateClip(contextClip.id)
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Copy className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1">Duplicate</span>
              </button>
              <button
                onClick={() => {
                  splitClipAtPlayhead(contextClip.id)
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Scissors className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1">Split at Playhead</span>
                <span className="text-zinc-600 text-[10px]">B</span>
              </button>

              <div className="h-px bg-zinc-700 my-1" />

              {/* ---- Speed submenu ---- */}
              <div className="px-3 py-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Speed</div>
              <div className="flex items-center gap-1 px-3 py-1">
                {[0.25, 0.5, 1, 1.5, 2, 4].map(speed => (
                  <button
                    key={speed}
                    onClick={() => {
                      const oldSpeed = contextClip.speed
                      let newDuration = contextClip.duration * (oldSpeed / speed)
                      const maxDur = getMaxClipDuration({ ...contextClip, speed })
                      newDuration = Math.min(newDuration, maxDur)
                      newDuration = Math.max(0.5, newDuration)
                      updateClip(contextClip.id, { speed, duration: newDuration })
                      setClipContextMenu(null)
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                      contextClip.speed === speed
                        ? 'bg-violet-600 text-white'
                        : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-white'
                    }`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              <div className="h-px bg-zinc-700 my-1" />

              {/* ---- Toggles ---- */}
              <button
                onClick={() => {
                  updateClip(contextClip.id, { reversed: !contextClip.reversed })
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <RotateCcw className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1">Reverse</span>
                {contextClip.reversed && <span className="text-[10px] text-blue-400 font-medium">ON</span>}
              </button>
              <button
                onClick={() => {
                  updateClip(contextClip.id, { muted: !contextClip.muted })
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                {contextClip.muted ? <VolumeX className="h-3.5 w-3.5 text-zinc-500" /> : <Volume2 className="h-3.5 w-3.5 text-zinc-500" />}
                <span className="flex-1">{contextClip.muted ? 'Unmute' : 'Mute'}</span>
                {contextClip.muted && <span className="text-[10px] text-red-400 font-medium">MUTED</span>}
              </button>
              <button
                onClick={() => {
                  updateClip(contextClip.id, { flipH: !contextClip.flipH })
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <FlipHorizontal2 className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1">Flip Horizontal</span>
                {contextClip.flipH && <span className="text-[10px] text-cyan-400 font-medium">ON</span>}
              </button>
              <button
                onClick={() => {
                  updateClip(contextClip.id, { flipV: !contextClip.flipV })
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <FlipVertical2 className="h-3.5 w-3.5 text-zinc-500" />
                <span className="flex-1">Flip Vertical</span>
                {contextClip.flipV && <span className="text-[10px] text-cyan-400 font-medium">ON</span>}
              </button>

              <div className="h-px bg-zinc-700 my-1" />

              {/* ---- Link / Unlink audio ---- */}
              {contextClip.linkedClipIds?.length ? (
                <button
                  onClick={() => {
                    pushUndo()
                    const allLinked = new Set(contextClip.linkedClipIds!)
                    setClips(prev => prev.map(c => {
                      if (c.id === contextClip.id) return { ...c, linkedClipIds: undefined }
                      if (allLinked.has(c.id)) {
                        const remaining = (c.linkedClipIds || []).filter(lid => lid !== contextClip.id)
                        return { ...c, linkedClipIds: remaining.length ? remaining : undefined }
                      }
                      return c
                    }))
                    setClipContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <Unlink2 className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">Unlink Audio</span>
                </button>
              ) : null}
              {!contextClip.linkedClipIds?.length && (contextClip.type === 'video' || contextClip.type === 'audio') && (() => {
                const oppositeType = contextClip.type === 'video' ? 'audio' : 'video'
                const candidates = clips.filter(c =>
                  c.type === oppositeType &&
                  !c.linkedClipIds?.length &&
                  c.assetId === contextClip.assetId &&
                  Math.abs(c.startTime - contextClip.startTime) < 0.05
                )
                if (!candidates.length) return null
                return (
                  <button
                    onClick={() => {
                      pushUndo()
                      const candidateIds = candidates.map(c => c.id)
                      setClips(prev => prev.map(c => {
                        if (c.id === contextClip.id) return { ...c, linkedClipIds: candidateIds }
                        if (candidateIds.includes(c.id)) return { ...c, linkedClipIds: [contextClip.id] }
                        return c
                      }))
                      setClipContextMenu(null)
                    }}
                    className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                  >
                    <Link2 className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="flex-1">Link Audio</span>
                  </button>
                )
              })()}

              <div className="h-px bg-zinc-700 my-1" />

              {/* ---- Move track ---- */}
              {contextClip.trackIndex > 0 && (
                <button
                  onClick={() => {
                    updateClip(contextClip.id, { trackIndex: contextClip.trackIndex - 1 })
                    setClipContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <ArrowUp className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">Move to Track Above</span>
                </button>
              )}
              {contextClip.trackIndex < tracks.length - 1 && (
                <button
                  onClick={() => {
                    updateClip(contextClip.id, { trackIndex: contextClip.trackIndex + 1 })
                    setClipContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <ArrowDown className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">Move to Track Below</span>
                </button>
              )}
            </>
          )}

          {/* Retake option — always visible for video clips, even with linked audio selected */}
          {contextClip && contextClip.type === 'video' && contextClip.assetId && (
            <>
              <div className="h-px bg-zinc-700 my-1" />
              <button
                onClick={() => {
                  setRetakeClipId(contextClip.id)
                  setClipContextMenu(null)
                }}
                disabled={isRetaking}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Film className="h-3.5 w-3.5 text-violet-400" />
                <span className="flex-1">Retake Section</span>
              </button>
              <button
                onClick={() => {
                  setIcLoraSourceClipId(contextClip.id)
                  setShowICLoraPanel(true)
                  setClipContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                <span className="flex-1">IC-LoRA / Style Transfer</span>
              </button>
            </>
          )}

          {/* ---- Multi-clip batch actions ---- */}
          {multiSelected && (() => {
            const selectedClips = clips.filter(c => selectedClipIds.has(c.id))
            const allMuted = selectedClips.every(c => c.muted)
            const allReversed = selectedClips.every(c => c.reversed)
            const allFlipH = selectedClips.every(c => c.flipH)
            const allFlipV = selectedClips.every(c => c.flipV)
            const minTrack = Math.min(...selectedClips.map(c => c.trackIndex))
            const maxTrack = Math.max(...selectedClips.map(c => c.trackIndex))

            const batchUpdate = (updates: Partial<TimelineClip>) => {
              pushUndo()
              setClips(prev => prev.map(c =>
                selectedClipIds.has(c.id) ? { ...c, ...updates } : c
              ))
              setClipContextMenu(null)
            }

            return (
              <>
                <div className="px-3 py-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                  {selectedClipIds.size} Clips Selected
                </div>

                {/* ---- Speed ---- */}
                <div className="px-3 py-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Speed</div>
                <div className="flex items-center gap-1 px-3 py-1">
                  {[0.25, 0.5, 1, 1.5, 2, 4].map(speed => (
                    <button
                      key={speed}
                      onClick={() => {
                        pushUndo()
                        setClips(prev => prev.map(c => {
                          if (!selectedClipIds.has(c.id)) return c
                          const oldSpeed = c.speed
                          let newDuration = c.duration * (oldSpeed / speed)
                          const maxDur = getMaxClipDuration({ ...c, speed })
                          newDuration = Math.min(newDuration, maxDur)
                          newDuration = Math.max(0.5, newDuration)
                          return { ...c, speed, duration: newDuration }
                        }))
                        setClipContextMenu(null)
                      }}
                      className="px-1.5 py-0.5 rounded text-[10px] transition-colors bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-white"
                    >
                      {speed}x
                    </button>
                  ))}
                </div>

                <div className="h-px bg-zinc-700 my-1" />

                {/* ---- Toggles ---- */}
                <button
                  onClick={() => batchUpdate({ muted: !allMuted })}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  {allMuted ? <VolumeX className="h-3.5 w-3.5 text-zinc-500" /> : <Volume2 className="h-3.5 w-3.5 text-zinc-500" />}
                  <span className="flex-1">{allMuted ? 'Unmute All' : 'Mute All'}</span>
                  {allMuted && <span className="text-[10px] text-red-400 font-medium">ALL MUTED</span>}
                </button>
                <button
                  onClick={() => batchUpdate({ reversed: !allReversed })}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">{allReversed ? 'Un-reverse All' : 'Reverse All'}</span>
                  {allReversed && <span className="text-[10px] text-blue-400 font-medium">ALL ON</span>}
                </button>
                <button
                  onClick={() => batchUpdate({ flipH: !allFlipH })}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <FlipHorizontal2 className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">{allFlipH ? 'Un-flip Horizontal' : 'Flip All Horizontal'}</span>
                  {allFlipH && <span className="text-[10px] text-cyan-400 font-medium">ALL ON</span>}
                </button>
                <button
                  onClick={() => batchUpdate({ flipV: !allFlipV })}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <FlipVertical2 className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="flex-1">{allFlipV ? 'Un-flip Vertical' : 'Flip All Vertical'}</span>
                  {allFlipV && <span className="text-[10px] text-cyan-400 font-medium">ALL ON</span>}
                </button>

                <div className="h-px bg-zinc-700 my-1" />

                {/* ---- Link / Unlink selected clips ---- */}
                {(() => {
                  const anyLinked = selectedClips.some(c => c.linkedClipIds?.length)
                  const hasVideoAndAudio = selectedClips.some(c => c.type === 'video') && selectedClips.some(c => c.type === 'audio')
                  return (
                    <>
                      {anyLinked && (
                        <button
                          onClick={() => {
                            pushUndo()
                            const selIds = new Set(selectedClipIds)
                            setClips(prev => prev.map(c => {
                              if (!selIds.has(c.id)) return c
                              const remaining = (c.linkedClipIds || []).filter(lid => !selIds.has(lid))
                              return { ...c, linkedClipIds: remaining.length ? remaining : undefined }
                            }))
                            setClipContextMenu(null)
                          }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                        >
                          <Unlink2 className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="flex-1">Unlink</span>
                        </button>
                      )}
                      {hasVideoAndAudio && !selectedClips.every(c => {
                        const others = [...selectedClipIds].filter(id => id !== c.id)
                        return others.every(oid => c.linkedClipIds?.includes(oid))
                      }) && (
                        <button
                          onClick={() => {
                            pushUndo()
                            const selIds = [...selectedClipIds]
                            setClips(prev => prev.map(c => {
                              if (!selectedClipIds.has(c.id)) return c
                              const otherIds = selIds.filter(id => id !== c.id)
                              const existingLinks = new Set(c.linkedClipIds || [])
                              otherIds.forEach(id => existingLinks.add(id))
                              return { ...c, linkedClipIds: [...existingLinks] }
                            }))
                            setClipContextMenu(null)
                          }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                        >
                          <Link2 className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="flex-1">Link</span>
                        </button>
                      )}
                    </>
                  )
                })()}

                <div className="h-px bg-zinc-700 my-1" />

                {/* ---- Link / Unlink selected clips ---- */}
                {(() => {
                  const anyLinked = selectedClips.some(c => c.linkedClipIds?.length)
                  const hasVideo = selectedClips.some(c => c.type === 'video')
                  const hasAudio = selectedClips.some(c => c.type === 'audio')
                  const canLink = !anyLinked && hasVideo && hasAudio

                  return (
                    <>
                      {anyLinked && (
                        <button
                          onClick={() => {
                            pushUndo()
                            const selIds = new Set(selectedClipIds)
                            setClips(prev => prev.map(c => {
                              if (selIds.has(c.id)) {
                                return { ...c, linkedClipIds: undefined }
                              }
                              if (c.linkedClipIds) {
                                const remaining = c.linkedClipIds.filter(lid => !selIds.has(lid))
                                return { ...c, linkedClipIds: remaining.length ? remaining : undefined }
                              }
                              return c
                            }))
                            setClipContextMenu(null)
                          }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                        >
                          <Unlink2 className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="flex-1">Unlink</span>
                        </button>
                      )}
                      {canLink && (
                        <button
                          onClick={() => {
                            pushUndo()
                            const allIds = Array.from(selectedClipIds)
                            setClips(prev => prev.map(c => {
                              if (selectedClipIds.has(c.id)) {
                                const others = allIds.filter(id => id !== c.id)
                                return { ...c, linkedClipIds: others }
                              }
                              return c
                            }))
                            setClipContextMenu(null)
                          }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                        >
                          <Link2 className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="flex-1">Link</span>
                        </button>
                      )}
                    </>
                  )
                })()}

                <div className="h-px bg-zinc-700 my-1" />

                {/* ---- Move tracks ---- */}
                {minTrack > 0 && (
                  <button
                    onClick={() => {
                      pushUndo()
                      setClips(prev => prev.map(c =>
                        selectedClipIds.has(c.id) ? { ...c, trackIndex: c.trackIndex - 1 } : c
                      ))
                      setClipContextMenu(null)
                    }}
                    className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                  >
                    <ArrowUp className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="flex-1">Move All to Track Above</span>
                  </button>
                )}
                {maxTrack < tracks.length - 1 && (
                  <button
                    onClick={() => {
                      pushUndo()
                      setClips(prev => prev.map(c =>
                        selectedClipIds.has(c.id) ? { ...c, trackIndex: c.trackIndex + 1 } : c
                      ))
                      setClipContextMenu(null)
                    }}
                    className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                  >
                    <ArrowDown className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="flex-1">Move All to Track Below</span>
                  </button>
                )}
              </>
            )
          })()}

          <div className="h-px bg-zinc-700 my-1" />

          {/* ---- Delete ---- */}
          <button
            onClick={() => {
              if (multiSelected) {
                pushUndo()
                setClips(prev => prev.filter(c => !selectedClipIds.has(c.id)))
                setSelectedClipIds(new Set())
              } else {
                removeClip(contextClip!.id)
              }
              setClipContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="flex-1">{multiSelected ? `Delete ${selectedClipIds.size} Clips` : 'Delete'}</span>
            <span className="text-zinc-600 text-[10px]">Del</span>
          </button>
        </>
      )}
    </div>
  )
}
