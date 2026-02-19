import React from 'react'
import {
  Trash2, FileVideo, FileImage, FileAudio, Layers, Type,
  FlipHorizontal2, FlipVertical2, ChevronDown, ChevronRight,
  Palette, Eye, EyeOff, Sun, Contrast, Droplets, Thermometer,
  SunDim, Moon, Sparkles, Plus, X, RotateCcw, Film,
  AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react'
import type { Asset, TimelineClip, Track, ClipEffect, LetterboxSettings, TextOverlayStyle, TransitionType, EffectMask } from '../../types/project'
import { DEFAULT_COLOR_CORRECTION, EFFECT_DEFINITIONS, DEFAULT_LETTERBOX, TEXT_PRESETS, DEFAULT_EFFECT_MASK } from '../../types/project'
import { formatTime } from './video-editor-utils'

interface ClipPropertiesPanelProps {
  selectedClip: TimelineClip
  clips: TimelineClip[]
  tracks: Track[]
  propertiesTab: 'properties' | 'metadata'
  setPropertiesTab: (tab: 'properties' | 'metadata') => void
  showFlip: boolean
  setShowFlip: (v: boolean) => void
  showTransitions: boolean
  setShowTransitions: (v: boolean) => void
  showAppliedEffects: boolean
  setShowAppliedEffects: (v: boolean) => void
  showColorCorrection: boolean
  setShowColorCorrection: (v: boolean) => void
  resolutionCache: Record<string, { width: number; height: number }>
  rightPanelWidth: number
  updateClip: (clipId: string, updates: Partial<TimelineClip>) => void
  removeEffectFromClip: (clipId: string, effectId: string) => void
  updateEffectOnClip: (clipId: string, effectId: string, updates: Partial<ClipEffect>) => void
  handleDeleteTake: (clipId: string) => void
  setShowEffectsBrowser: (v: boolean) => void
  setI2vClipId: (v: string | null) => void
  setI2vPrompt: (v: string) => void
  i2vClipId: string | null
  isRegenerating: boolean
  getLiveAsset: (clip: TimelineClip) => Asset | null | undefined
  getClipUrl: (clip: TimelineClip) => string | null
  getClipResolution: (clip: TimelineClip) => { label: string; color: string; height: number } | null
  getMaxClipDuration: (clip: TimelineClip) => number
  handleRegenerate: (clipId: string) => void
  handleCancelRegeneration: () => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  pushUndo: (currentClips?: TimelineClip[]) => void
  handleClipTakeChange: (clipId: string, direction: 'prev' | 'next') => void
  handleRetakeSubmit?: (clipId: string, prompt: string, settings: any) => void
  retakeClipId: string | null
  setRetakeClipId: (v: string | null) => void
  setSubtitleTrackStyleIdx: (v: number | null) => void
  subtitleTrackStyleIdx: number | null
}

export function ClipPropertiesPanel(props: ClipPropertiesPanelProps) {
  const {
    selectedClip,
    tracks,
    propertiesTab,
    setPropertiesTab,
    showFlip,
    setShowFlip,
    showTransitions,
    setShowTransitions,
    showAppliedEffects,
    setShowAppliedEffects,
    showColorCorrection,
    setShowColorCorrection,
    resolutionCache,
    rightPanelWidth,
    updateClip,
    removeEffectFromClip,
    updateEffectOnClip,
    handleDeleteTake,
    setShowEffectsBrowser,
    setI2vClipId,
    setI2vPrompt,
    i2vClipId,
    isRegenerating,
    getLiveAsset,
    getClipUrl,
    getClipResolution,
    getMaxClipDuration,
  } = props

  return (
    <div className="flex-shrink-0 border-l border-zinc-800 bg-zinc-900 p-4 overflow-auto" style={{ width: rightPanelWidth }}>
      {/* Tab header */}
      <div className="flex items-center gap-0 mb-4 border-b border-zinc-700">
        <button
          className={`px-3 py-1.5 text-xs font-semibold transition-colors border-b-2 ${
            propertiesTab === 'properties'
              ? 'text-white border-violet-500'
              : 'text-zinc-500 border-transparent hover:text-zinc-300'
          }`}
          onClick={() => setPropertiesTab('properties')}
        >
          Properties
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-semibold transition-colors border-b-2 ${
            propertiesTab === 'metadata'
              ? 'text-white border-violet-500'
              : 'text-zinc-500 border-transparent hover:text-zinc-300'
          }`}
          onClick={() => setPropertiesTab('metadata')}
        >
          Metadata
        </button>
      </div>

      {/* Metadata Tab */}
      {propertiesTab === 'metadata' && (() => {
        const liveAsset = getLiveAsset(selectedClip)
        const clipUrl = getClipUrl(selectedClip) || selectedClip.asset?.url || selectedClip.importedUrl
        const dims = clipUrl ? resolutionCache[clipUrl] : null
        const resInfo = getClipResolution(selectedClip)
        const genParams = liveAsset?.generationParams

        // Current take info
        const totalTakes = liveAsset?.takes?.length || 1
        const currentTakeIdx = selectedClip.takeIndex ?? (liveAsset?.activeTakeIndex ?? (totalTakes - 1))
        const displayTakeNum = Math.min(currentTakeIdx, totalTakes - 1) + 1

        // Get the file path for the current take
        let filePath = liveAsset?.path || ''
        if (liveAsset?.takes && liveAsset.takes.length > 0 && selectedClip.takeIndex !== undefined) {
          const idx = Math.max(0, Math.min(selectedClip.takeIndex, liveAsset.takes.length - 1))
          filePath = liveAsset.takes[idx].path
        }

        // Determine if this is an upscaled take (take index > 0 and resolution is higher than original)
        const originalRes = liveAsset?.generationParams?.resolution
        const isUpscaled = resInfo && originalRes ? resInfo.height > parseInt(originalRes) : false

        return (
          <div className="space-y-3">
            {/* Currently Displayed */}
            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Currently Displayed</h4>
              <div className="bg-zinc-800/60 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Take</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white font-medium">{displayTakeNum} / {totalTakes}</span>
                    {totalTakes > 1 && (
                      <button
                        onClick={() => {
                          if (confirm(`Delete take ${displayTakeNum}?`)) {
                            handleDeleteTake(selectedClip.id)
                          }
                        }}
                        className="p-0.5 rounded hover:bg-red-900/50 text-zinc-500 hover:text-red-400 transition-colors"
                        title="Delete this take"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
                {resInfo ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-400">Resolution</span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: resInfo.color }} />
                        <span className="text-xs font-semibold" style={{ color: resInfo.color }}>{resInfo.label}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-400">Quality</span>
                      <span className="text-xs text-white">
                        {resInfo.height >= 2160 ? 'Ultra HD' : resInfo.height >= 1080 ? 'Full HD' : resInfo.height >= 720 ? 'HD' : 'SD'}
                        {isUpscaled && <span className="ml-1.5 text-green-400">(Upscaled)</span>}
                      </span>
                    </div>
                    {dims && dims.width > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-400">Dimensions</span>
                        <span className="text-xs text-white font-mono">{dims.width} × {dims.height}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-zinc-500 italic">Detecting resolution...</div>
                )}
                {originalRes && originalRes !== 'imported' && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Original Gen</span>
                    <span className="text-xs text-zinc-500">{originalRes}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Clip Info */}
            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Clip Info</h4>
              <div className="bg-zinc-800/60 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Type</span>
                  <div className="flex items-center gap-1">
                    {selectedClip.type === 'video' && <FileVideo className="h-3 w-3 text-zinc-400" />}
                    {selectedClip.type === 'image' && <FileImage className="h-3 w-3 text-zinc-400" />}
                    {selectedClip.type === 'audio' && <FileAudio className="h-3 w-3 text-zinc-400" />}
                    <span className="text-xs text-white capitalize">{selectedClip.type}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Duration</span>
                  <span className="text-xs text-white">{selectedClip.duration.toFixed(2)}s</span>
                </div>
                {liveAsset?.duration && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Source Duration</span>
                    <span className="text-xs text-white">{liveAsset.duration.toFixed(2)}s</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Speed</span>
                  <span className="text-xs text-white">{selectedClip.speed}x</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Track</span>
                  <span className="text-xs text-white">{tracks[selectedClip.trackIndex]?.name || `Track ${selectedClip.trackIndex + 1}`}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Start</span>
                  <span className="text-xs text-white">{formatTime(selectedClip.startTime)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">End</span>
                  <span className="text-xs text-white">{formatTime(selectedClip.startTime + selectedClip.duration)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Trim In</span>
                  <span className="text-xs text-white">{selectedClip.trimStart.toFixed(2)}s</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Trim Out</span>
                  <span className="text-xs text-white">{selectedClip.trimEnd.toFixed(2)}s</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Opacity</span>
                  <span className="text-xs text-white">{selectedClip.opacity}%</span>
                </div>
              </div>
            </div>

            {/* Takes */}
            {liveAsset?.takes && liveAsset.takes.length > 1 && (
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Takes</h4>
                <div className="bg-zinc-800/60 rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Total Takes</span>
                    <span className="text-xs text-white">{liveAsset.takes.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Active Take</span>
                    <span className="text-xs text-white">
                      #{(selectedClip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes.length - 1)) + 1}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Generation Parameters */}
            {genParams && (
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Generation</h4>
                <div className="bg-zinc-800/60 rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Mode</span>
                    <span className="text-xs text-white">{genParams.mode.replace(/-/g, ' ')}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Model</span>
                    <span className="text-xs text-white">{genParams.model}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Gen Resolution</span>
                    <span className="text-xs text-white">{genParams.resolution}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">FPS</span>
                    <span className="text-xs text-white">{genParams.fps}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Duration</span>
                    <span className="text-xs text-white">{genParams.duration}s</span>
                  </div>
                  {genParams.cameraMotion && genParams.cameraMotion !== 'none' && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-400">Camera</span>
                      <span className="text-xs text-white">{genParams.cameraMotion}</span>
                    </div>
                  )}
                  {genParams.prompt && (
                    <div className="mt-2">
                      <span className="text-xs text-zinc-400 block mb-1">Prompt</span>
                      <p className="text-xs text-zinc-300 bg-zinc-900/50 rounded p-2 break-words leading-relaxed">{genParams.prompt}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* File Path */}
            {filePath && (
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">File</h4>
                <div className="bg-zinc-800/60 rounded-lg p-3">
                  <p className="text-[10px] text-zinc-400 break-all font-mono leading-relaxed">{filePath}</p>
                </div>
              </div>
            )}

            {/* Asset Created At */}
            {liveAsset?.createdAt && (
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Created</h4>
                <div className="bg-zinc-800/60 rounded-lg p-3">
                  <span className="text-xs text-zinc-300">{new Date(liveAsset.createdAt).toLocaleString()}</span>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Properties Tab */}
      {propertiesTab === 'properties' && <div className="space-y-4">
        {/* Adjustment Layer properties */}
        {selectedClip.type === 'adjustment' && (() => {
          const lb = { ...DEFAULT_LETTERBOX, ...selectedClip.letterbox }
          const updateLetterbox = (patch: Partial<LetterboxSettings>) => {
            updateClip(selectedClip.id, { letterbox: { ...lb, ...patch } })
          }
          return (
            <div className="bg-violet-950/30 border border-violet-700/30 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Layers className="h-4 w-4 text-violet-400" />
                <h4 className="text-xs font-semibold text-violet-300">Adjustment Layer</h4>
              </div>

              {/* Letterbox toggle */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Letterbox</span>
                <button
                  onClick={() => updateLetterbox({ enabled: !lb.enabled })}
                  className={`px-2.5 py-0.5 rounded text-[10px] border transition-colors ${
                    lb.enabled
                      ? 'bg-violet-600/30 text-violet-300 border-violet-500/40'
                      : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                  }`}
                >
                  {lb.enabled ? 'On' : 'Off'}
                </button>
              </div>

              {lb.enabled && (
                <>
                  {/* Aspect ratio */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Aspect Ratio</span>
                    <select
                      value={lb.aspectRatio}
                      onChange={e => updateLetterbox({ aspectRatio: e.target.value as LetterboxSettings['aspectRatio'] })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-violet-500/50"
                    >
                      <option value="2.39:1">2.39:1 (Anamorphic)</option>
                      <option value="2.35:1">2.35:1 (Cinemascope)</option>
                      <option value="2.76:1">2.76:1 (Ultra Panavision)</option>
                      <option value="1.85:1">1.85:1 (Flat Widescreen)</option>
                      <option value="4:3">4:3 (Classic TV)</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  {/* Custom ratio input */}
                  {lb.aspectRatio === 'custom' && (
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-400">Custom Ratio</span>
                      <input
                        type="number"
                        step={0.01}
                        min={1}
                        max={4}
                        value={lb.customRatio || 2.35}
                        onChange={e => updateLetterbox({ customRatio: parseFloat(e.target.value) || 2.35 })}
                        onKeyDown={e => e.stopPropagation()}
                        className="w-20 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white text-center focus:outline-none focus:border-violet-500/50"
                      />
                    </div>
                  )}

                  {/* Bar color */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Bar Color</span>
                    <input
                      type="color"
                      value={lb.color}
                      onChange={e => updateLetterbox({ color: e.target.value })}
                      className="w-7 h-6 rounded cursor-pointer border border-zinc-700"
                    />
                  </div>

                  {/* Bar opacity */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Bar Opacity</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={0} max={100} value={lb.opacity}
                        onChange={e => updateLetterbox({ opacity: parseInt(e.target.value) })}
                        className="w-20 accent-violet-500"
                      />
                      <span className="text-[10px] text-zinc-300 w-8 text-right tabular-nums">{lb.opacity}%</span>
                    </div>
                  </div>
                </>
              )}

              {/* Color correction note */}
              <p className="text-[9px] text-zinc-600 pt-1 border-t border-zinc-800">
                Color correction on this layer affects all tracks below.
              </p>
            </div>
          )
        })()}

        {/* Text overlay properties */}
        {selectedClip.type === 'text' && selectedClip.textStyle && (() => {
          const ts = selectedClip.textStyle
          const updateText = (patch: Partial<TextOverlayStyle>) => {
            updateClip(selectedClip.id, { textStyle: { ...ts, ...patch } })
          }
          return (
            <div className="bg-cyan-950/30 border border-cyan-700/30 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Type className="h-4 w-4 text-cyan-400" />
                <h4 className="text-xs font-semibold text-cyan-300">Text Overlay</h4>
              </div>

              {/* Text content */}
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400">Content</span>
                <textarea
                  value={ts.text}
                  onChange={e => updateText({ text: e.target.value })}
                  rows={3}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white resize-none focus:outline-none focus:border-cyan-500/50"
                  placeholder="Enter text..."
                />
              </div>

              {/* Font family */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Font</span>
                <select
                  value={ts.fontFamily.split(',')[0].trim()}
                  onChange={e => updateText({ fontFamily: `${e.target.value}, sans-serif` })}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-cyan-500/50 max-w-[120px]"
                >
                  <option value="Inter">Inter</option>
                  <option value="Arial">Arial</option>
                  <option value="Helvetica">Helvetica</option>
                  <option value="Georgia">Georgia</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Courier New">Courier New</option>
                  <option value="Verdana">Verdana</option>
                  <option value="Impact">Impact</option>
                  <option value="Comic Sans MS">Comic Sans MS</option>
                </select>
              </div>

              {/* Font size */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Size</span>
                <div className="flex items-center gap-2">
                  <input type="range" min={12} max={200} value={ts.fontSize} onChange={e => updateText({ fontSize: parseInt(e.target.value) })} className="w-20 accent-cyan-500" />
                  <span className="text-[10px] text-zinc-300 w-8 text-right tabular-nums">{ts.fontSize}</span>
                </div>
              </div>

              {/* Font weight & style */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Weight</span>
                <select
                  value={ts.fontWeight}
                  onChange={e => updateText({ fontWeight: e.target.value as TextOverlayStyle['fontWeight'] })}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-cyan-500/50"
                >
                  <option value="100">Thin</option>
                  <option value="300">Light</option>
                  <option value="normal">Normal</option>
                  <option value="500">Medium</option>
                  <option value="600">Semibold</option>
                  <option value="bold">Bold</option>
                  <option value="800">Extra Bold</option>
                  <option value="900">Black</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => updateText({ fontStyle: ts.fontStyle === 'italic' ? 'normal' : 'italic' })}
                  className={`px-2 py-1 rounded text-[10px] border ${ts.fontStyle === 'italic' ? 'bg-cyan-600/30 text-cyan-300 border-cyan-500/40' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                >
                  <em>Italic</em>
                </button>
              </div>

              {/* Text color */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Color</span>
                <input type="color" value={ts.color} onChange={e => updateText({ color: e.target.value })} className="w-7 h-6 rounded cursor-pointer border border-zinc-700" />
              </div>

              {/* Background color */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Background</span>
                <div className="flex items-center gap-1.5">
                  <input type="color" value={ts.backgroundColor === 'transparent' ? '#000000' : ts.backgroundColor.slice(0, 7)} onChange={e => updateText({ backgroundColor: e.target.value + 'cc' })} className="w-7 h-6 rounded cursor-pointer border border-zinc-700" />
                  <button
                    onClick={() => updateText({ backgroundColor: ts.backgroundColor === 'transparent' ? 'rgba(0,0,0,0.7)' : 'transparent' })}
                    className={`px-1.5 py-0.5 rounded text-[9px] border ${ts.backgroundColor !== 'transparent' ? 'bg-cyan-600/20 text-cyan-300 border-cyan-500/30' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                  >
                    {ts.backgroundColor !== 'transparent' ? 'On' : 'Off'}
                  </button>
                </div>
              </div>

              {/* Text alignment */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Align</span>
                <div className="flex gap-0.5">
                  {(['left', 'center', 'right'] as const).map(align => (
                    <button
                      key={align}
                      onClick={() => updateText({ textAlign: align })}
                      className={`p-1.5 rounded ${ts.textAlign === align ? 'bg-cyan-600/30 text-cyan-300' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
                    >
                      {align === 'left' ? <AlignLeft className="h-3 w-3" /> : align === 'center' ? <AlignCenter className="h-3 w-3" /> : <AlignRight className="h-3 w-3" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Position */}
              <div className="space-y-1.5">
                <span className="text-[10px] text-zinc-400">Position</span>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <span className="text-[9px] text-zinc-500">X</span>
                    <input type="range" min={0} max={100} value={ts.positionX} onChange={e => updateText({ positionX: parseFloat(e.target.value) })} className="w-full accent-cyan-500" />
                  </div>
                  <div className="flex-1">
                    <span className="text-[9px] text-zinc-500">Y</span>
                    <input type="range" min={0} max={100} value={ts.positionY} onChange={e => updateText({ positionY: parseFloat(e.target.value) })} className="w-full accent-cyan-500" />
                  </div>
                </div>
              </div>

              {/* Opacity */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Opacity</span>
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={100} value={ts.opacity} onChange={e => updateText({ opacity: parseInt(e.target.value) })} className="w-20 accent-cyan-500" />
                  <span className="text-[10px] text-zinc-300 w-8 text-right tabular-nums">{ts.opacity}%</span>
                </div>
              </div>

              {/* Stroke */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Outline</span>
                <div className="flex items-center gap-1.5">
                  <input type="range" min={0} max={10} step={0.5} value={ts.strokeWidth} onChange={e => updateText({ strokeWidth: parseFloat(e.target.value) })} className="w-16 accent-cyan-500" />
                  <input type="color" value={ts.strokeColor === 'transparent' ? '#000000' : ts.strokeColor} onChange={e => updateText({ strokeColor: e.target.value, strokeWidth: Math.max(ts.strokeWidth, 1) })} className="w-5 h-5 rounded cursor-pointer border border-zinc-700" />
                </div>
              </div>

              {/* Shadow */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">Shadow</span>
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={20} value={ts.shadowBlur} onChange={e => updateText({ shadowBlur: parseInt(e.target.value) })} className="w-16 accent-cyan-500" />
                  <span className="text-[10px] text-zinc-300 w-4 text-right tabular-nums">{ts.shadowBlur}</span>
                </div>
              </div>

              {/* Presets */}
              <div className="pt-2 border-t border-zinc-800">
                <span className="text-[10px] text-zinc-400 block mb-1.5">Apply Preset</span>
                <div className="grid grid-cols-2 gap-1">
                  {TEXT_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      onClick={() => updateText({ ...preset.style })}
                      className="px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-[9px] text-zinc-300 hover:border-cyan-500/40 hover:bg-cyan-900/20 transition-colors truncate"
                      title={preset.name}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Image-to-Video quick action for image clips */}
        {selectedClip.type === 'image' && (
          <button
            onClick={() => {
              setI2vClipId(selectedClip.id)
              setI2vPrompt(selectedClip.asset?.prompt || '')
            }}
            disabled={isRegenerating && i2vClipId === selectedClip.id}
            className="w-full px-3 py-2 rounded-lg bg-blue-600/15 border border-blue-500/30 text-blue-400 text-xs hover:bg-blue-600/25 hover:border-blue-500/50 transition-colors font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Film className="h-3.5 w-3.5" />
            {isRegenerating && i2vClipId === selectedClip.id ? 'Generating Video...' : 'Generate Video (I2V)'}
          </button>
        )}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Start Time</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={selectedClip.startTime.toFixed(2)}
              onChange={(e) => updateClip(selectedClip.id, { startTime: Math.max(0, parseFloat(e.target.value) || 0) })}
              min={0}
              step={0.1}
              className="flex-1 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white text-sm"
            />
            <span className="text-xs text-zinc-500">sec</span>
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">Duration</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={selectedClip.duration.toFixed(2)}
              onChange={(e) => {
                let dur = Math.max(0.1, parseFloat(e.target.value) || 1)
                const maxDur = getMaxClipDuration(selectedClip)
                dur = Math.min(dur, maxDur)
                updateClip(selectedClip.id, { duration: dur })
              }}
              min={0.1}
              max={getMaxClipDuration(selectedClip)}
              step={0.1}
              className="flex-1 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white text-sm"
            />
            <span className="text-xs text-zinc-500">sec</span>
            {selectedClip.type === 'video' && selectedClip.asset?.duration && (
              <span className="text-[10px] text-zinc-600">max {getMaxClipDuration(selectedClip).toFixed(1)}s</span>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">Speed</label>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.25}
            value={selectedClip.speed}
            onChange={(e) => {
              const newSpeed = parseFloat(e.target.value)
              const oldSpeed = selectedClip.speed
              let newDuration = selectedClip.duration * (oldSpeed / newSpeed)
              const maxDur = getMaxClipDuration({ ...selectedClip, speed: newSpeed })
              newDuration = Math.min(newDuration, maxDur)
              newDuration = Math.max(0.5, newDuration)
              updateClip(selectedClip.id, { speed: newSpeed, duration: newDuration })
            }}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>0.25x</span>
            <span className="text-white">{selectedClip.speed}x</span>
            <span>4x</span>
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">Volume</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={selectedClip.muted ? 0 : selectedClip.volume}
            onChange={(e) => updateClip(selectedClip.id, { volume: parseFloat(e.target.value), muted: false })}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>0%</span>
            <span className="text-white">{selectedClip.muted ? '0' : Math.round(selectedClip.volume * 100)}%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedClip.reversed}
              onChange={(e) => updateClip(selectedClip.id, { reversed: e.target.checked })}
              className="rounded bg-zinc-800 border-zinc-600"
            />
            <span className="text-sm text-zinc-300">Reverse playback</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedClip.muted}
              onChange={(e) => updateClip(selectedClip.id, { muted: e.target.checked })}
              className="rounded bg-zinc-800 border-zinc-600"
            />
            <span className="text-sm text-zinc-300">Mute audio</span>
          </label>
        </div>

        {/* --- Opacity --- */}
        <div className="pt-3 border-t border-zinc-800">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-zinc-400">Opacity</label>
            <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.opacity ?? 100}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={selectedClip.opacity ?? 100}
            onChange={(e) => updateClip(selectedClip.id, { opacity: parseInt(e.target.value) })}
            className="w-full h-1.5 accent-violet-500"
          />
          <div className="flex justify-between text-[9px] text-zinc-600 mt-0.5">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>

        {/* --- Flip --- */}
        <div className="pt-3 border-t border-zinc-800">
          <button
            className="flex items-center gap-2 w-full text-left text-xs font-semibold text-zinc-400 hover:text-white transition-colors mb-2"
            onClick={() => setShowFlip(!showFlip)}
          >
            {showFlip ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <FlipHorizontal2 className="h-3.5 w-3.5" />
            Flip
          </button>
          {showFlip && (
            <div className="space-y-2 pl-5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedClip.flipH}
                  onChange={(e) => updateClip(selectedClip.id, { flipH: e.target.checked })}
                  className="rounded bg-zinc-800 border-zinc-600"
                />
                <FlipHorizontal2 className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-sm text-zinc-300">Horizontal</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedClip.flipV}
                  onChange={(e) => updateClip(selectedClip.id, { flipV: e.target.checked })}
                  className="rounded bg-zinc-800 border-zinc-600"
                />
                <FlipVertical2 className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-sm text-zinc-300">Vertical</span>
              </label>
            </div>
          )}
        </div>

        {/* --- Transitions --- */}
        <div className="pt-3 border-t border-zinc-800">
          <button
            className="flex items-center gap-2 w-full text-left text-xs font-semibold text-zinc-400 hover:text-white transition-colors mb-2"
            onClick={() => setShowTransitions(!showTransitions)}
          >
            {showTransitions ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Film className="h-3.5 w-3.5" />
            Transitions
          </button>
          {showTransitions && (
            <div className="space-y-3 pl-5">
              {/* Transition In */}
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1 uppercase tracking-wider">Transition In</label>
                <select
                  value={selectedClip.transitionIn?.type || 'none'}
                  onChange={(e) => updateClip(selectedClip.id, {
                    transitionIn: { ...selectedClip.transitionIn, type: e.target.value as TransitionType }
                  })}
                  className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white text-xs"
                >
                  <option value="none">None</option>
                  <option value="dissolve">Dissolve</option>
                  <option value="fade-to-black">Fade from Black</option>
                  <option value="fade-to-white">Fade from White</option>
                  <option value="wipe-left">Wipe Left</option>
                  <option value="wipe-right">Wipe Right</option>
                  <option value="wipe-up">Wipe Up</option>
                  <option value="wipe-down">Wipe Down</option>
                </select>
                {selectedClip.transitionIn?.type !== 'none' && (
                  <div className="mt-1.5">
                    <label className="block text-[10px] text-zinc-600 mb-0.5">Duration</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0.1}
                        max={Math.min(2, selectedClip.duration / 2)}
                        step={0.1}
                        value={selectedClip.transitionIn?.duration || 0.5}
                        onChange={(e) => updateClip(selectedClip.id, {
                          transitionIn: { ...selectedClip.transitionIn, duration: parseFloat(e.target.value) }
                        })}
                        className="flex-1"
                      />
                      <span className="text-[10px] text-zinc-400 w-6 text-right">{(selectedClip.transitionIn?.duration || 0.5).toFixed(1)}s</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Transition Out */}
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1 uppercase tracking-wider">Transition Out</label>
                <select
                  value={selectedClip.transitionOut?.type || 'none'}
                  onChange={(e) => updateClip(selectedClip.id, {
                    transitionOut: { ...selectedClip.transitionOut, type: e.target.value as TransitionType }
                  })}
                  className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white text-xs"
                >
                  <option value="none">None</option>
                  <option value="dissolve">Dissolve</option>
                  <option value="fade-to-black">Fade to Black</option>
                  <option value="fade-to-white">Fade to White</option>
                  <option value="wipe-left">Wipe Left</option>
                  <option value="wipe-right">Wipe Right</option>
                  <option value="wipe-up">Wipe Up</option>
                  <option value="wipe-down">Wipe Down</option>
                </select>
                {selectedClip.transitionOut?.type !== 'none' && (
                  <div className="mt-1.5">
                    <label className="block text-[10px] text-zinc-600 mb-0.5">Duration</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0.1}
                        max={Math.min(2, selectedClip.duration / 2)}
                        step={0.1}
                        value={selectedClip.transitionOut?.duration || 0.5}
                        onChange={(e) => updateClip(selectedClip.id, {
                          transitionOut: { ...selectedClip.transitionOut, duration: parseFloat(e.target.value) }
                        })}
                        className="flex-1"
                      />
                      <span className="text-[10px] text-zinc-400 w-6 text-right">{(selectedClip.transitionOut?.duration || 0.5).toFixed(1)}s</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* --- Applied Effects --- */}
        <div className="pt-3 border-t border-zinc-800/60">
          <button
            className="flex items-center gap-2 w-full text-left px-1 py-1 rounded-md hover:bg-zinc-800/40 transition-colors mb-1"
            onClick={() => setShowAppliedEffects(!showAppliedEffects)}
          >
            {showAppliedEffects ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
            <Sparkles className="h-3 w-3 text-violet-400" />
            <span className="text-[11px] font-semibold text-zinc-300 flex-1">Effects</span>
            {selectedClip.effects && selectedClip.effects.length > 0 && (
              <span className="text-[9px] font-bold text-violet-400 bg-violet-500/15 px-1.5 py-0.5 rounded-full">{selectedClip.effects.length}</span>
            )}
          </button>
          {showAppliedEffects && (
            <div className="space-y-1.5 mt-1">
              {(!selectedClip.effects || selectedClip.effects.length === 0) ? (
                <div className="flex flex-col items-center py-4 px-3">
                  <div className="w-10 h-10 rounded-full bg-zinc-800/80 flex items-center justify-center mb-2">
                    <Sparkles className="h-4 w-4 text-zinc-600" />
                  </div>
                  <p className="text-[11px] text-zinc-600 text-center leading-relaxed">No effects applied</p>
                  <p className="text-[10px] text-zinc-700 text-center mt-0.5">Drag from the FX browser or use the button below</p>
                </div>
              ) : (
                selectedClip.effects.map((fx, fxIdx) => {
                  const def = EFFECT_DEFINITIONS[fx.type]
                  if (!def) return null
                  // Color coding per effect category
                  const catColor = def.category === 'filter'
                    ? { dot: 'bg-blue-400', text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' }
                    : def.category === 'stylize'
                    ? { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' }
                    : { dot: 'bg-emerald-400', text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' }
                  return (
                    <div
                      key={fx.id}
                      className={`rounded-lg overflow-hidden transition-all ${
                        fx.enabled
                          ? `bg-zinc-800/60 border ${catColor.border}`
                          : 'bg-zinc-800/30 border border-zinc-800/50 opacity-60'
                      }`}
                    >
                      {/* Effect header */}
                      <div className="flex items-center gap-2 px-2.5 py-2">
                        <span className="text-[9px] font-mono text-zinc-600 w-3 text-center flex-shrink-0">{fxIdx + 1}</span>
                        <button
                          onClick={() => updateEffectOnClip(selectedClip.id, fx.id, { enabled: !fx.enabled })}
                          className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors ${
                            fx.enabled ? `${catColor.bg} ${catColor.text}` : 'bg-zinc-800 text-zinc-600'
                          }`}
                          title={fx.enabled ? 'Disable effect' : 'Enable effect'}
                        >
                          {fx.enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        </button>
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${fx.enabled ? catColor.dot : 'bg-zinc-600'}`} />
                          <span className={`text-[11px] font-medium truncate ${fx.enabled ? 'text-zinc-200' : 'text-zinc-500'}`}>{def.name}</span>
                        </div>
                        <button
                          onClick={() => removeEffectFromClip(selectedClip.id, fx.id)}
                          className="text-zinc-700 hover:text-red-400 flex-shrink-0 transition-colors"
                          title="Remove effect"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      {fx.enabled && (
                        <div className="px-2.5 pb-2.5 space-y-2 border-t border-zinc-700/30 pt-2">
                          {Object.entries(def.paramRanges).map(([paramKey, paramDef]) => {
                            const value = fx.params[paramKey] ?? paramDef.min
                            const pct = ((value - paramDef.min) / (paramDef.max - paramDef.min)) * 100
                            return (
                              <div key={paramKey}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] text-zinc-500 font-medium">{paramDef.label}</span>
                                  <input
                                    type="number"
                                    min={paramDef.min}
                                    max={paramDef.max}
                                    step={paramDef.step}
                                    value={parseFloat(value.toFixed(paramDef.step < 1 ? 1 : 0))}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      if (!isNaN(v)) updateEffectOnClip(selectedClip.id, fx.id, { params: { ...fx.params, [paramKey]: Math.max(paramDef.min, Math.min(paramDef.max, v)) } })
                                    }}
                                    className="w-12 text-[10px] text-zinc-300 font-mono text-right bg-zinc-800/80 border border-zinc-700/50 rounded px-1 py-0.5 outline-none focus:border-violet-500/50"
                                  />
                                </div>
                                <div className="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                  <div
                                    className={`absolute left-0 top-0 bottom-0 rounded-full transition-all ${
                                      def.category === 'filter' ? 'bg-blue-500/60' : def.category === 'stylize' ? 'bg-amber-500/60' : 'bg-emerald-500/60'
                                    }`}
                                    style={{ width: `${pct}%` }}
                                  />
                                  <input
                                    type="range"
                                    min={paramDef.min}
                                    max={paramDef.max}
                                    step={paramDef.step}
                                    value={value}
                                    onChange={(e) => {
                                      updateEffectOnClip(selectedClip.id, fx.id, {
                                        params: { ...fx.params, [paramKey]: parseFloat(e.target.value) },
                                      })
                                    }}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                  />
                                </div>
                              </div>
                            )
                          })}
                          <div className="flex items-center justify-between">
                            <button
                              onClick={() => updateEffectOnClip(selectedClip.id, fx.id, { params: { ...def.defaultParams } })}
                              className="text-[9px] text-zinc-600 hover:text-zinc-400 transition-colors"
                            >
                              Reset to defaults
                            </button>
                          </div>

                          {/* Mask controls */}
                          {(fx.type === 'blur' || fx.type === 'sharpen' || fx.type === 'glow' || fx.type.startsWith('lut-')) && (
                            <div className="border-t border-zinc-700/30 pt-2 mt-1">
                              <label className="flex items-center gap-2 cursor-pointer mb-1.5">
                                <input
                                  type="checkbox"
                                  checked={fx.mask?.enabled || false}
                                  onChange={e => {
                                    const mask: EffectMask = fx.mask ? { ...fx.mask, enabled: e.target.checked } : { ...DEFAULT_EFFECT_MASK, enabled: e.target.checked }
                                    updateEffectOnClip(selectedClip.id, fx.id, { mask })
                                  }}
                                  className="rounded bg-zinc-800 border-zinc-600 h-3 w-3"
                                />
                                <span className="text-[10px] text-zinc-400 font-medium">Mask</span>
                                {fx.mask?.enabled && (
                                  <span className="text-[9px] text-violet-400 ml-auto">{fx.mask.shape}</span>
                                )}
                              </label>
                              {fx.mask?.enabled && (() => {
                                const m = fx.mask
                                const updateMask = (updates: Partial<EffectMask>) => {
                                  updateEffectOnClip(selectedClip.id, fx.id, { mask: { ...m, ...updates } })
                                }
                                return (
                                  <div className="space-y-1.5 pl-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-zinc-500 w-10">Shape</span>
                                      <div className="flex gap-1 flex-1">
                                        {(['ellipse', 'rectangle'] as const).map(s => (
                                          <button
                                            key={s}
                                            onClick={() => updateMask({ shape: s })}
                                            className={`flex-1 py-0.5 rounded text-[9px] font-medium transition-colors ${
                                              m.shape === s ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40' : 'bg-zinc-800 text-zinc-500 border border-zinc-700/50 hover:text-zinc-300'
                                            }`}
                                          >
                                            {s === 'ellipse' ? 'Ellipse' : 'Rectangle'}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                    {([
                                      { key: 'x', label: 'X', min: 0, max: 100, step: 1 },
                                      { key: 'y', label: 'Y', min: 0, max: 100, step: 1 },
                                      { key: 'width', label: 'W', min: 1, max: 100, step: 1 },
                                      { key: 'height', label: 'H', min: 1, max: 100, step: 1 },
                                      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1 },
                                      { key: 'rotation', label: 'Rot', min: -180, max: 180, step: 1 },
                                    ] as const).map(({ key, label, min, max, step }) => (
                                      <div key={key} className="flex items-center gap-2">
                                        <span className="text-[10px] text-zinc-500 w-10">{label}</span>
                                        <input
                                          type="range"
                                          min={min} max={max} step={step}
                                          value={m[key]}
                                          onChange={e => updateMask({ [key]: parseFloat(e.target.value) })}
                                          className="flex-1 h-1 accent-violet-500 cursor-pointer"
                                        />
                                        <input
                                          type="number"
                                          min={min} max={max} step={step}
                                          value={m[key]}
                                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) updateMask({ [key]: Math.max(min, Math.min(max, v)) }) }}
                                          className="w-10 text-[9px] text-zinc-300 font-mono text-right bg-zinc-800/80 border border-zinc-700/50 rounded px-1 py-0.5 outline-none focus:border-violet-500/50"
                                        />
                                      </div>
                                    ))}
                                    <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                                      <input
                                        type="checkbox"
                                        checked={m.invert}
                                        onChange={e => updateMask({ invert: e.target.checked })}
                                        className="rounded bg-zinc-800 border-zinc-600 h-3 w-3"
                                      />
                                      <span className="text-[10px] text-zinc-400">Invert mask</span>
                                    </label>
                                  </div>
                                )
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
              <button
                onClick={() => setShowEffectsBrowser(true)}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] text-zinc-500 hover:text-violet-400 py-2 hover:bg-violet-500/5 border border-dashed border-zinc-700/50 hover:border-violet-500/30 rounded-lg transition-all"
              >
                <Plus className="h-3 w-3" />
                Add Effect
              </button>
            </div>
          )}
        </div>

        {/* --- Color Correction --- */}
        <div className="pt-3 border-t border-zinc-800">
          <button
            className="flex items-center gap-2 w-full text-left text-xs font-semibold text-zinc-400 hover:text-white transition-colors mb-2"
            onClick={() => setShowColorCorrection(!showColorCorrection)}
          >
            {showColorCorrection ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Palette className="h-3.5 w-3.5" />
            Color Correction
            {selectedClip.colorCorrection && Object.values(selectedClip.colorCorrection).some(v => v !== 0) && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
            )}
          </button>
          {showColorCorrection && (
            <div className="space-y-2.5 pl-1">
              <button
                className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-violet-400 transition-colors"
                onClick={() => updateClip(selectedClip.id, { colorCorrection: { ...DEFAULT_COLOR_CORRECTION } })}
              >
                <RotateCcw className="h-3 w-3" />
                Reset All
              </button>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Eye className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Exposure</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.exposure || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.exposure || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), exposure: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Sun className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Brightness</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.brightness || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.brightness || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), brightness: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Contrast className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Contrast</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.contrast || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.contrast || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), contrast: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Droplets className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Saturation</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.saturation || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.saturation || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), saturation: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Thermometer className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Temperature</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.temperature || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.temperature || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), temperature: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
                <div className="flex justify-between text-[9px] text-zinc-600 mt-0.5">
                  <span>Cool</span>
                  <span>Warm</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Palette className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Tint</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.tint || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.tint || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), tint: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
                <div className="flex justify-between text-[9px] text-zinc-600 mt-0.5">
                  <span>Green</span>
                  <span>Magenta</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <SunDim className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Highlights</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.highlights || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.highlights || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), highlights: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <Moon className="h-3 w-3 text-zinc-500" />
                    <span className="text-[11px] text-zinc-400">Shadows</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{selectedClip.colorCorrection?.shadows || 0}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedClip.colorCorrection?.shadows || 0}
                  onChange={(e) => updateClip(selectedClip.id, {
                    colorCorrection: { ...(selectedClip.colorCorrection || DEFAULT_COLOR_CORRECTION), shadows: parseInt(e.target.value) }
                  })}
                  className="w-full h-1.5 accent-violet-500"
                />
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  )
}
