import React from 'react'
import {
  Layers, Video, Image, ZoomIn, ZoomOut, Maximize2, ChevronDown,
  SkipBack, SkipForward, ChevronLeft, ChevronRight, Pause, Play, Square, Repeat,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { AudioWaveform } from '../../components/AudioWaveform'
import { DEFAULT_SUBTITLE_STYLE } from '../../types/project'
import type { TimelineClip, Track, SubtitleClip } from '../../types/project'
import { getClipEffectStyles, getTransitionBgColor, formatTime, getShortcutLabel } from './video-editor-utils'
import type { KeyboardLayout } from '../../lib/keyboard-shortcuts'

export interface ProgramMonitorProps {
  // Layout
  showSourceMonitor: boolean
  activePanel: 'source' | 'timeline'
  sourceSplitPercent: number
  setActivePanel: (panel: 'source' | 'timeline') => void

  // Refs (parent owns these for playback/effects logic)
  previewContainerRef: React.RefObject<HTMLDivElement | null>
  previewVideoRef: React.RefObject<HTMLVideoElement | null>
  previewImageRef: React.RefObject<HTMLImageElement | null>
  dissolveOutVideoRef: React.RefObject<HTMLVideoElement | null>
  previewPanRef: React.MutableRefObject<{ dragging: boolean; startX: number; startY: number; startPanX: number; startPanY: number }>

  // Playback state
  currentTime: number
  totalDuration: number
  isPlaying: boolean
  setIsPlaying: (v: boolean) => void
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>

  // Clips & effects data
  clips: TimelineClip[]
  tracks: Track[]
  activeClip: TimelineClip | undefined
  monitorClip: TimelineClip | undefined
  clipPlaybackOffset: number
  crossDissolveState: { outgoing: TimelineClip; incoming: TimelineClip; progress: number } | null
  activeSubtitles: SubtitleClip[]
  activeTextClips: TimelineClip[]
  activeLetterbox: { ratio: number; color: string; opacity: number } | null
  activeAdjustmentEffects: Array<{
    clip: TimelineClip
    filterStyle: React.CSSProperties
    hasVignette: boolean
    vignetteAmount: number
    hasGrain: boolean
    grainAmount: number
  }>

  // Helpers
  getClipUrl: (clip: TimelineClip) => string | null

  // Text overlay interaction
  selectedClipIds: Set<string>
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>

  // In/Out & transport
  inPoint: number | null
  outPoint: number | null
  setInPoint: (updater: (prev: number | null) => number | null) => void
  setOutPoint: (updater: (prev: number | null) => number | null) => void
  setDraggingMarker: React.Dispatch<React.SetStateAction<'timelineIn' | 'timelineOut' | 'sourceIn' | 'sourceOut' | null>>
  playingInOut: boolean
  setPlayingInOut: (v: boolean) => void
  setShuttleSpeed: (v: number | ((prev: number) => number)) => void

  // Preview zoom/pan
  previewZoom: number | 'fit'
  setPreviewZoom: React.Dispatch<React.SetStateAction<number | 'fit'>>
  previewPan: { x: number; y: number }
  setPreviewPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  previewZoomOpen: boolean
  setPreviewZoomOpen: React.Dispatch<React.SetStateAction<boolean>>
  videoFrameSize: { width: number; height: number }
  playbackResolution: 1 | 0.5 | 0.25
  setPlaybackResolution: (v: 1 | 0.5 | 0.25) => void
  playbackResOpen: boolean
  setPlaybackResOpen: React.Dispatch<React.SetStateAction<boolean>>
  isFullscreen: boolean
  toggleFullscreen: () => void

  // Keyboard shortcuts
  kbLayout: KeyboardLayout
}

export function ProgramMonitor({
  showSourceMonitor,
  activePanel,
  sourceSplitPercent,
  setActivePanel,
  previewContainerRef,
  previewVideoRef,
  previewImageRef,
  dissolveOutVideoRef,
  previewPanRef,
  currentTime,
  totalDuration,
  isPlaying,
  setIsPlaying,
  setCurrentTime,
  clips,
  tracks,
  activeClip,
  monitorClip,
  clipPlaybackOffset,
  crossDissolveState,
  activeSubtitles,
  activeTextClips,
  activeLetterbox,
  activeAdjustmentEffects,
  getClipUrl,
  selectedClipIds,
  setSelectedClipIds,
  setClips,
  inPoint,
  outPoint,
  setInPoint,
  setOutPoint,
  setDraggingMarker,
  playingInOut,
  setPlayingInOut,
  setShuttleSpeed,
  previewZoom,
  setPreviewZoom,
  previewPan,
  setPreviewPan,
  previewZoomOpen,
  setPreviewZoomOpen,
  videoFrameSize,
  playbackResolution,
  setPlaybackResolution,
  playbackResOpen,
  setPlaybackResOpen,
  isFullscreen,
  toggleFullscreen,
  kbLayout,
}: ProgramMonitorProps) {
  return (
    <div
        className={`flex flex-col ${showSourceMonitor ? '' : 'flex-1'} min-w-0 min-h-0 ${showSourceMonitor && activePanel === 'timeline' ? 'ring-2 ring-violet-500 ring-inset' : ''}`}
        style={showSourceMonitor ? { width: `${100 - sourceSplitPercent}%` } : undefined}
        onMouseDown={() => setActivePanel('timeline')}
      >
        {/* Header (only when split view) */}
        {showSourceMonitor && (
          <div className="h-7 bg-zinc-900 border-b border-zinc-800 flex items-center px-3 flex-shrink-0">
            <span className="text-[11px] font-semibold text-zinc-400 tracking-wide">Timeline Viewer</span>
          </div>
        )}
        {/* Preview (existing) */}
        <div
          ref={previewContainerRef as React.RefObject<HTMLDivElement>}
          className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${isFullscreen ? 'bg-black' : ''}`}
          style={{ backgroundColor: isFullscreen ? '#000' : '#333', ...(previewZoom !== 'fit' ? { cursor: 'grab' } : {}) }}
          onMouseDown={(e) => {
            if (previewZoom === 'fit') return
            if (e.button !== 0 && e.button !== 1) return
            previewPanRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, startPanX: previewPan.x, startPanY: previewPan.y }
          }}
          onMouseMove={(e) => {
            if (!previewPanRef.current.dragging) return
            setPreviewPan({
              x: previewPanRef.current.startPanX + (e.clientX - previewPanRef.current.startX),
              y: previewPanRef.current.startPanY + (e.clientY - previewPanRef.current.startY),
            })
          }}
          onMouseUp={() => { previewPanRef.current.dragging = false }}
          onMouseLeave={() => { previewPanRef.current.dragging = false }}
        >
          {clips.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-48 h-28 border-2 border-dashed border-zinc-700 rounded-lg flex flex-col items-center justify-center mb-4 mx-auto">
                  <Layers className="h-8 w-8 text-zinc-600 mb-2" />
                  <p className="text-zinc-500 text-xs">Drop clips here</p>
                </div>
                <p className="text-zinc-600 text-xs">Click assets or drag them to the timeline</p>
              </div>
            </div>
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={previewZoom !== 'fit' ? {
                transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${(previewZoom as number) / 100})`,
                transformOrigin: 'center center',
              } : undefined}
            >
              {/* Video frame wrapper — black bg with exact 16:9 dimensions */}
              <div
                className="relative bg-black overflow-hidden"
                style={videoFrameSize.width > 0 ? { width: videoFrameSize.width, height: videoFrameSize.height } : { width: '100%', aspectRatio: '16/9' }}
              >
              {/* Cross-dissolve: render BOTH clips with blended opacity */}
              {crossDissolveState ? (() => {
                const { outgoing, incoming, progress } = crossDissolveState
                const outOffset = currentTime - outgoing.startTime
                const inOffset = currentTime - incoming.startTime
                const outOpacity = (1 - progress) * ((outgoing.opacity ?? 100) / 100)
                const inOpacity = progress * ((incoming.opacity ?? 100) / 100)
                const outStyle = { ...getClipEffectStyles(outgoing, outOffset), opacity: outOpacity }
                const inStyle = { ...getClipEffectStyles(incoming, inOffset), opacity: inOpacity }

                return (
                  <>
                    {outgoing.asset?.type === 'video' ? (
                      <video
                        ref={dissolveOutVideoRef as React.RefObject<HTMLVideoElement>}
                        key={`dissolve-out-${outgoing.id}`}
                        src={getClipUrl(outgoing) || outgoing.asset.url}
                        className="absolute inset-0 w-full h-full object-contain"
                        style={outStyle}
                        playsInline
                        muted
                      />
                    ) : outgoing.asset?.type === 'image' ? (
                      <img
                        key={`dissolve-out-${outgoing.id}`}
                        src={getClipUrl(outgoing) || outgoing.asset.url}
                        alt=""
                        className="absolute inset-0 w-full h-full object-contain"
                        style={outStyle}
                      />
                    ) : null}

                    {incoming.asset?.type === 'video' ? (
                      <video
                        ref={previewVideoRef as React.RefObject<HTMLVideoElement>}
                        key={`dissolve-in-${incoming.id}`}
                        src={getClipUrl(incoming) || incoming.asset.url}
                        className="absolute inset-0 w-full h-full object-contain"
                        style={inStyle}
                        playsInline
                      />
                    ) : incoming.asset?.type === 'image' ? (
                      <img
                        ref={previewImageRef as React.RefObject<HTMLImageElement>}
                        key={`dissolve-in-${incoming.id}`}
                        src={getClipUrl(incoming) || incoming.asset.url}
                        alt=""
                        className="absolute inset-0 w-full h-full object-contain"
                        style={inStyle}
                      />
                    ) : null}
                  </>
                )
              })() : (
                <>
                  {/* Transition background overlay */}
                  {activeClip && (() => {
                    const tInBg = activeClip.transitionIn?.type !== 'none' ? getTransitionBgColor(activeClip.transitionIn.type) : null
                    const tOutBg = activeClip.transitionOut?.type !== 'none' ? getTransitionBgColor(activeClip.transitionOut.type) : null
                    const bg = tInBg || tOutBg
                    if (!bg) return null
                    const effectStyles = getClipEffectStyles(activeClip, clipPlaybackOffset)
                    const overlayOpacity = effectStyles.opacity !== undefined ? 1 - (effectStyles.opacity as number) : 0
                    return overlayOpacity > 0 ? (
                      <div className="absolute inset-0 z-10 pointer-events-none" style={{ backgroundColor: bg, opacity: overlayOpacity }} />
                    ) : null
                  })()}
                  {/* Video pool container */}
                  <div
                    id="video-pool-container"
                    className={`w-full h-full relative pointer-events-none ${!isPlaying && monitorClip?.asset?.type !== 'video' ? 'hidden' : ''}`}
                    style={monitorClip?.asset?.type === 'video' ? getClipEffectStyles(monitorClip, clipPlaybackOffset) : undefined}
                  />

                  {activeClip?.asset?.type === 'image' && (
                    <img
                      ref={previewImageRef as React.RefObject<HTMLImageElement>}
                      src={getClipUrl(activeClip) || activeClip.asset.url}
                      alt=""
                      className="w-full h-full object-contain"
                      style={getClipEffectStyles(activeClip, clipPlaybackOffset)}
                    />
                  )}

                  {/* Vignette overlay (from effects) */}
                  {activeClip?.effects?.some(fx => fx.enabled && fx.type === 'vignette' && fx.params.amount > 0) && (
                    <div
                      className="absolute inset-0 z-20 pointer-events-none"
                      style={{
                        background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${
                          (activeClip.effects!.find(fx => fx.type === 'vignette' && fx.enabled)!.params.amount / 100) * 0.85
                        }) 100%)`,
                      }}
                    />
                  )}

                  {/* Film grain overlay (from effects) */}
                  {activeClip?.effects?.some(fx => fx.enabled && fx.type === 'grain' && fx.params.amount > 0) && (
                    <canvas
                      ref={(canvas) => {
                        if (!canvas) return
                        const amount = activeClip.effects!.find(fx => fx.type === 'grain' && fx.enabled)!.params.amount
                        const ctx = canvas.getContext('2d')
                        if (!ctx) return
                        const w = canvas.width = 256
                        const h = canvas.height = 256
                        const imageData = ctx.createImageData(w, h)
                        for (let i = 0; i < imageData.data.length; i += 4) {
                          const v = Math.random() * 255
                          imageData.data[i] = v
                          imageData.data[i + 1] = v
                          imageData.data[i + 2] = v
                          imageData.data[i + 3] = (amount / 100) * 80
                        }
                        ctx.putImageData(imageData, 0, 0)
                      }}
                      className="absolute inset-0 z-20 pointer-events-none w-full h-full"
                      style={{ mixBlendMode: 'overlay', imageRendering: 'pixelated' }}
                    />
                  )}

                  {/* Audio waveform or empty state when no video/image clip is visible */}
                  {!monitorClip && (() => {
                    const audioAtPlayhead = clips.filter(c =>
                      c.type === 'audio' &&
                      currentTime >= c.startTime &&
                      currentTime < c.startTime + c.duration
                    )
                    return audioAtPlayhead.length > 0 ? (
                      <div className="absolute inset-0">
                        <AudioWaveform
                          audioClips={audioAtPlayhead.map(c => ({
                            url: getClipUrl(c) || c.asset?.url || c.importedUrl || '',
                            name: c.asset?.path || c.importedName || 'Audio',
                            startTime: c.startTime,
                            duration: c.duration,
                          }))}
                          currentTime={currentTime}
                          isPlaying={isPlaying}
                        />
                      </div>
                    ) : !isPlaying ? (
                      <div className="text-center">
                        <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                          <Video className="h-8 w-8 text-zinc-600" />
                        </div>
                        <p className="text-zinc-500 text-sm">No clip at playhead</p>
                        <p className="text-zinc-600 text-xs mt-1">Move playhead over a clip to preview</p>
                      </div>
                    ) : null
                  })()}
                </>
              )}

              {/* Adjustment layer effects */}
              {activeAdjustmentEffects.map(({ clip: adjClip, filterStyle, hasVignette, vignetteAmount, hasGrain, grainAmount }) => {
                const backdropFilter = filterStyle.filter && filterStyle.filter !== 'none' ? String(filterStyle.filter) : undefined
                return (
                  <React.Fragment key={`adj-fx-${adjClip.id}`}>
                    {backdropFilter && (
                      <div
                        className="absolute inset-0 z-[22] pointer-events-none"
                        style={{ backdropFilter, WebkitBackdropFilter: backdropFilter }}
                      />
                    )}
                    {hasVignette && (
                      <div
                        className="absolute inset-0 z-[22] pointer-events-none"
                        style={{
                          background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${vignetteAmount}) 100%)`,
                        }}
                      />
                    )}
                    {hasGrain && (
                      <canvas
                        ref={(canvas) => {
                          if (!canvas) return
                          const ctx = canvas.getContext('2d')
                          if (!ctx) return
                          const w = canvas.width = 256
                          const h = canvas.height = 256
                          const imageData = ctx.createImageData(w, h)
                          for (let i = 0; i < imageData.data.length; i += 4) {
                            const v = Math.random() * 255
                            imageData.data[i] = v
                            imageData.data[i + 1] = v
                            imageData.data[i + 2] = v
                            imageData.data[i + 3] = (grainAmount / 100) * 80
                          }
                          ctx.putImageData(imageData, 0, 0)
                        }}
                        className="absolute inset-0 z-[22] pointer-events-none w-full h-full"
                        style={{ mixBlendMode: 'overlay', imageRendering: 'pixelated' }}
                      />
                    )}
                  </React.Fragment>
                )
              })}

              {/* Text overlay clips */}
              {activeTextClips.map(tc => {
                const ts = tc.textStyle!
                const isSelected = selectedClipIds.has(tc.id)
                return (
                  <div
                    key={`text-${tc.id}`}
                    className={`absolute z-[24] ${isSelected ? 'ring-2 ring-cyan-400/60 ring-offset-1 ring-offset-transparent' : ''}`}
                    style={{
                      left: `${ts.positionX}%`,
                      top: `${ts.positionY}%`,
                      transform: 'translate(-50%, -50%)',
                      maxWidth: ts.maxWidth > 0 ? `${ts.maxWidth}%` : undefined,
                      opacity: ts.opacity / 100,
                      pointerEvents: 'auto',
                      cursor: 'move',
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setSelectedClipIds(new Set([tc.id]))
                      const container = (e.currentTarget.parentElement as HTMLElement)
                      if (!container) return
                      const rect = container.getBoundingClientRect()
                      const onMove = (ev: MouseEvent) => {
                        const px = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100))
                        const py = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100))
                        setClips(prev => prev.map(c =>
                          c.id === tc.id && c.textStyle
                            ? { ...c, textStyle: { ...c.textStyle, positionX: Math.round(px * 10) / 10, positionY: Math.round(py * 10) / 10 } }
                            : c
                        ))
                      }
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove)
                        window.removeEventListener('mouseup', onUp)
                      }
                      window.addEventListener('mousemove', onMove)
                      window.addEventListener('mouseup', onUp)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                    }}
                  >
                    <div
                      style={{
                        fontFamily: ts.fontFamily,
                        fontSize: `${ts.fontSize * 0.05}vh`,
                        fontWeight: ts.fontWeight,
                        fontStyle: ts.fontStyle,
                        color: ts.color,
                        backgroundColor: ts.backgroundColor,
                        textAlign: ts.textAlign,
                        padding: ts.padding > 0 ? `${ts.padding * 0.04}vh` : undefined,
                        borderRadius: ts.borderRadius > 0 ? `${ts.borderRadius}px` : undefined,
                        letterSpacing: ts.letterSpacing !== 0 ? `${ts.letterSpacing}px` : undefined,
                        lineHeight: ts.lineHeight,
                        textShadow: ts.shadowBlur > 0 || ts.shadowOffsetX !== 0 || ts.shadowOffsetY !== 0
                          ? `${ts.shadowOffsetX}px ${ts.shadowOffsetY}px ${ts.shadowBlur}px ${ts.shadowColor}`
                          : undefined,
                        WebkitTextStroke: ts.strokeWidth > 0 && ts.strokeColor !== 'transparent'
                          ? `${ts.strokeWidth}px ${ts.strokeColor}`
                          : undefined,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {ts.text}
                    </div>
                  </div>
                )
              })}

              {/* Subtitle overlay */}
              {activeSubtitles.length > 0 && (
                <div className="absolute inset-0 z-[25] pointer-events-none flex flex-col justify-end">
                  {activeSubtitles.map(sub => {
                    const track = tracks[sub.trackIndex]
                    const style = { ...DEFAULT_SUBTITLE_STYLE, ...(track?.subtitleStyle || {}), ...sub.style }
                    return (
                      <div
                        key={sub.id}
                        className={`w-full flex ${
                          style.position === 'top' ? 'self-start' : style.position === 'center' ? 'self-center absolute inset-0 items-center justify-center' : 'self-end'
                        }`}
                        style={style.position !== 'center' ? { padding: style.position === 'top' ? '12px 16px 0' : '0 16px 12px' } : undefined}
                      >
                        <span
                          className="inline-block max-w-[90%] text-center mx-auto rounded px-3 py-1.5 leading-snug whitespace-pre-wrap"
                          style={{
                            fontSize: `${style.fontSize}px`,
                            fontFamily: style.fontFamily,
                            fontWeight: style.fontWeight,
                            fontStyle: style.italic ? 'italic' : 'normal',
                            color: style.color,
                            backgroundColor: style.backgroundColor,
                            textShadow: '1px 1px 3px rgba(0,0,0,0.8)',
                          }}
                        >
                          {sub.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Letterbox overlay from adjustment layers */}
              {activeLetterbox && (() => {
                const containerRatio = 16 / 9
                const targetRatio = activeLetterbox.ratio
                if (targetRatio >= containerRatio) {
                  const barPct = ((1 - containerRatio / targetRatio) / 2) * 100
                  return barPct > 0 ? (
                    <>
                      <div
                        className="absolute left-0 right-0 top-0 z-[18] pointer-events-none"
                        style={{ height: `${barPct}%`, backgroundColor: activeLetterbox.color, opacity: activeLetterbox.opacity }}
                      />
                      <div
                        className="absolute left-0 right-0 bottom-0 z-[18] pointer-events-none"
                        style={{ height: `${barPct}%`, backgroundColor: activeLetterbox.color, opacity: activeLetterbox.opacity }}
                      />
                    </>
                  ) : null
                } else {
                  const barPct = ((1 - targetRatio / containerRatio) / 2) * 100
                  return barPct > 0 ? (
                    <>
                      <div
                        className="absolute top-0 bottom-0 left-0 z-[18] pointer-events-none"
                        style={{ width: `${barPct}%`, backgroundColor: activeLetterbox.color, opacity: activeLetterbox.opacity }}
                      />
                      <div
                        className="absolute top-0 bottom-0 right-0 z-[18] pointer-events-none"
                        style={{ width: `${barPct}%`, backgroundColor: activeLetterbox.color, opacity: activeLetterbox.opacity }}
                      />
                    </>
                  ) : null
                }
              })()}
              </div>{/* end video frame wrapper */}

              {/* Transparent overlay to prevent video element default interactions */}
              <div
                className="absolute inset-0 z-20 pointer-events-none"
              />
            </div>
          )}

          <div className="absolute bottom-4 left-4 px-2 py-1 rounded bg-black/70 text-white text-sm font-mono z-10">
            {formatTime(currentTime)}
          </div>

          {activeClip && (
            <div className="absolute top-4 left-4 px-2 py-1 rounded bg-black/70 text-white text-xs flex items-center gap-2 z-10">
              {activeClip.asset?.type === 'video' ? <Video className="h-3 w-3" /> : <Image className="h-3 w-3" />}
              <span className="max-w-[200px] truncate">{activeClip.asset?.prompt || 'Clip'}</span>
              {activeClip.speed !== 1 && <span className="text-yellow-400">{activeClip.speed}x</span>}
              {activeClip.reversed && <span className="text-blue-400">REV</span>}
            </div>
          )}

          {/* Zoom controls */}
          <div className="absolute top-3 right-3 flex items-center gap-1 z-20">
            <button
              onClick={() => setPreviewZoom(prev => {
                const cur = prev === 'fit' ? 100 : prev
                return Math.max(10, Math.round(cur / 1.25))
              })}
              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5 text-zinc-300" />
            </button>
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setPreviewZoomOpen(prev => !prev) }}
                className={`h-7 px-2 rounded-md text-[11px] font-medium tabular-nums flex items-center gap-1 transition-colors ${
                  previewZoomOpen ? 'bg-zinc-700 text-white' : 'bg-black/60 hover:bg-black/80 text-zinc-300'
                }`}
              >
                {previewZoom === 'fit' ? 'Fit' : `${previewZoom}%`}
                <ChevronDown className="h-3 w-3" />
              </button>
              {previewZoomOpen && (
                <div className="absolute top-full right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1 min-w-[100px] z-50">
                  {[
                    { label: 'Fit', value: 'fit' as const },
                    { label: '10%', value: 10 },
                    { label: '25%', value: 25 },
                    { label: '50%', value: 50 },
                    { label: '75%', value: 75 },
                    { label: '100%', value: 100 },
                    { label: '150%', value: 150 },
                    { label: '200%', value: 200 },
                    { label: '400%', value: 400 },
                    { label: '800%', value: 800 },
                  ].map(opt => (
                    <button
                      key={opt.label}
                      onClick={() => { setPreviewZoom(opt.value); setPreviewZoomOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${
                        previewZoom === opt.value
                          ? 'text-violet-300 bg-violet-600/20'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {previewZoom === opt.value && <span className="text-violet-400">&#10003;</span>}
                      <span className={previewZoom === opt.value ? '' : 'ml-5'}>{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setPreviewZoom(prev => {
                const cur = prev === 'fit' ? 100 : prev
                return Math.min(1600, Math.round(cur * 1.25))
              })}
              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5 text-zinc-300" />
            </button>
            <button
              onClick={() => { setPreviewZoom('fit'); setPreviewPan({ x: 0, y: 0 }) }}
              className={`p-1.5 rounded-md transition-colors ${
                previewZoom === 'fit' ? 'bg-violet-600/30 text-violet-300' : 'bg-black/60 hover:bg-black/80 text-zinc-300'
              }`}
              title="Fit to view"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            {/* Playback resolution dropdown */}
            <div className="w-px h-4 bg-zinc-600/50 mx-0.5" />
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setPlaybackResOpen(prev => !prev) }}
                className={`h-7 px-2 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors ${
                  playbackResolution === 1
                    ? 'bg-green-700/40 text-green-300'
                    : playbackResolution === 0.5
                    ? 'bg-yellow-700/40 text-yellow-300'
                    : 'bg-orange-700/40 text-orange-300'
                }`}
                title="Playback resolution — lower is smoother"
              >
                {playbackResolution === 1 ? 'Full' : playbackResolution === 0.5 ? '1/2' : '1/4'}
                <ChevronDown className="h-3 w-3" />
              </button>
              {playbackResOpen && (
                <div className="absolute top-full right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1 min-w-[120px] z-50">
                  {([
                    { label: 'Full (1:1)', value: 1 as const, desc: 'Highest quality' },
                    { label: 'Half (1/2)', value: 0.5 as const, desc: 'Balanced' },
                    { label: 'Quarter (1/4)', value: 0.25 as const, desc: 'Smoothest' },
                  ] as const).map(opt => (
                    <button
                      key={opt.label}
                      onClick={() => { setPlaybackResolution(opt.value); setPlaybackResOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-[11px] flex flex-col gap-0 transition-colors ${
                        playbackResolution === opt.value
                          ? 'text-violet-300 bg-violet-600/20'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {playbackResolution === opt.value && <span className="text-violet-400">&#10003;</span>}
                        <span className={playbackResolution === opt.value ? '' : 'ml-5'}>{opt.label}</span>
                      </div>
                      <span className={`text-[10px] ${playbackResolution === opt.value ? 'text-violet-400/60' : 'text-zinc-500'} ml-5`}>{opt.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Fullscreen toggle */}
            <div className="w-px h-4 bg-zinc-600/50 mx-0.5" />
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 transition-colors"
              title={`${isFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'} (${getShortcutLabel(kbLayout, 'view.fullscreen')})`}
            >
              <Maximize2 className="h-3.5 w-3.5 text-zinc-300" style={isFullscreen ? { transform: 'rotate(180deg)' } : undefined} />
            </button>
          </div>
        </div>

        {/* Program monitor mini scrub bar with IN/OUT markers */}
        {clips.length > 0 && (
          <div className="bg-zinc-900 border-t border-zinc-800 flex-shrink-0 relative px-2 py-1">
            <div
              id="program-scrub-bar"
              className="relative h-5 cursor-pointer group"
              onMouseDown={(e) => {
                const bar = e.currentTarget
                const rect = bar.getBoundingClientRect()
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                const t = pct * totalDuration
                setIsPlaying(false)
                setCurrentTime(t)
                const onMove = (ev: MouseEvent) => {
                  const p = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
                  setCurrentTime(p * totalDuration)
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            >
              {/* Base track */}
              <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 bg-zinc-700 rounded-full" />
              {/* Progress fill */}
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-1 bg-zinc-500 rounded-full"
                style={{ width: totalDuration > 0 ? `${(currentTime / totalDuration) * 100}%` : '0%' }}
              />
              {/* Dimmed region BEFORE In */}
              {inPoint !== null && (
                <div
                  className="absolute top-0 bottom-0 left-0 bg-black/50 rounded-l"
                  style={{ width: `${(inPoint / totalDuration) * 100}%` }}
                />
              )}
              {/* Dimmed region AFTER Out */}
              {outPoint !== null && (
                <div
                  className="absolute top-0 bottom-0 right-0 bg-black/50 rounded-r"
                  style={{ width: `${100 - (outPoint / totalDuration) * 100}%` }}
                />
              )}
              {/* In/Out range highlight */}
              {(inPoint !== null || outPoint !== null) && (
                <div
                  className="absolute top-0 bottom-0 border-t-2 border-b-2 border-blue-400/70 pointer-events-none"
                  style={{
                    left: `${((inPoint ?? 0) / totalDuration) * 100}%`,
                    width: `${(((outPoint ?? totalDuration) - (inPoint ?? 0)) / totalDuration) * 100}%`,
                  }}
                >
                  <div className="absolute inset-0 top-1/2 -translate-y-1/2 h-1 bg-blue-400/30 rounded-full" />
                </div>
              )}
              {/* In bracket — draggable */}
              {inPoint !== null && (
                <div
                  className="absolute top-0 bottom-0 flex items-center z-10 cursor-ew-resize"
                  style={{ left: `calc(${(inPoint / totalDuration) * 100}% - 6px)`, width: 12 }}
                  onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setDraggingMarker('timelineIn') }}
                >
                  <div className="w-1 h-full bg-blue-400 rounded-l-sm flex flex-col justify-between py-0.5 pointer-events-none ml-auto">
                    <div className="w-2 h-0.5 bg-blue-400 rounded-r" />
                    <div className="w-2 h-0.5 bg-blue-400 rounded-r" />
                  </div>
                </div>
              )}
              {/* Out bracket — draggable */}
              {outPoint !== null && (
                <div
                  className="absolute top-0 bottom-0 flex items-center z-10 cursor-ew-resize"
                  style={{ left: `${(outPoint / totalDuration) * 100}%`, width: 12 }}
                  onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setDraggingMarker('timelineOut') }}
                >
                  <div className="w-1 h-full bg-blue-400 rounded-r-sm flex flex-col justify-between py-0.5 pointer-events-none">
                    <div className="w-2 h-0.5 bg-blue-400 rounded-l -ml-1" />
                    <div className="w-2 h-0.5 bg-blue-400 rounded-l -ml-1" />
                  </div>
                </div>
              )}
              {/* Playhead */}
              <div
                className="absolute top-0 bottom-0 z-20 pointer-events-none"
                style={{ left: totalDuration > 0 ? `${(currentTime / totalDuration) * 100}%` : '0%' }}
              >
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-white rounded-full" />
                <div className="absolute top-1.5 bottom-0 left-1/2 -translate-x-1/2 w-px bg-white" />
              </div>
            </div>
            {/* Timecode labels */}
            {(inPoint !== null || outPoint !== null) && (
              <div className="flex justify-between items-center mt-0.5 h-3">
                <span className="text-[9px] font-mono text-blue-400/80">
                  {inPoint !== null ? `IN ${formatTime(inPoint)}` : ''}
                </span>
                <span className="text-[9px] font-mono text-zinc-500">
                  {inPoint !== null && outPoint !== null ? `Duration: ${formatTime(outPoint - inPoint)}` : ''}
                </span>
                <span className="text-[9px] font-mono text-blue-400/80">
                  {outPoint !== null ? `OUT ${formatTime(outPoint)}` : ''}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Program Transport Controls */}
        <div className="h-10 bg-zinc-900 border-t border-zinc-800 flex items-center justify-center gap-0.5 px-2 flex-shrink-0">
          {/* Mark In */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${inPoint !== null ? 'text-yellow-400' : 'text-zinc-500'}`}
            onClick={() => setInPoint(prev => prev !== null && Math.abs(prev - currentTime) < 0.01 ? null : currentTime)}
            title={inPoint !== null ? `In: ${formatTime(inPoint)}` : 'Set In point (I)'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7,4 4,4 4,20 7,20" />
              <line x1="10" y1="12" x2="20" y2="12" />
              <polyline points="16,8 20,12 16,16" />
            </svg>
          </Button>
          <div className="w-px h-4 bg-zinc-700" />
          {/* Go to start */}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => setCurrentTime(0)} title="Go to start">
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          {/* Step back 1 frame */}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => { setShuttleSpeed(0); setIsPlaying(false); setCurrentTime(t => Math.max(0, t - 1/24)) }} title="Step back 1 frame">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {/* Stop */}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => { setShuttleSpeed(0); setIsPlaying(false) }} title="Stop">
            <Square className="h-3 w-3" />
          </Button>
          {/* Play/Pause */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setShuttleSpeed(0); setIsPlaying(!isPlaying) }}
            className="h-7 w-7 text-zinc-400"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
          </Button>
          {/* Step forward 1 frame */}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => { setShuttleSpeed(0); setIsPlaying(false); setCurrentTime(t => Math.min(totalDuration, t + 1/24)) }} title="Step forward 1 frame">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {/* Go to end */}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => setCurrentTime(totalDuration)} title="Go to end">
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-4 bg-zinc-700" />
          {/* Mark Out */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${outPoint !== null ? 'text-yellow-400' : 'text-zinc-500'}`}
            onClick={() => setOutPoint(prev => prev !== null && Math.abs(prev - currentTime) < 0.01 ? null : currentTime)}
            title={outPoint !== null ? `Out: ${formatTime(outPoint)}` : 'Set Out point (O)'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17,4 20,4 20,20 17,20" />
              <line x1="14" y1="12" x2="4" y2="12" />
              <polyline points="8,8 4,12 8,16" />
            </svg>
          </Button>
          <div className="w-px h-4 bg-zinc-700 mx-0.5" />
          {/* Loop In/Out */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${playingInOut ? 'text-yellow-400 bg-yellow-400/10' : 'text-zinc-500'} ${inPoint === null || outPoint === null ? 'opacity-30 cursor-not-allowed' : ''}`}
            disabled={inPoint === null || outPoint === null}
            onClick={() => {
              if (inPoint === null || outPoint === null) return
              if (playingInOut) { setPlayingInOut(false); setIsPlaying(false) } else { setCurrentTime(inPoint); setPlayingInOut(true); setIsPlaying(true) }
            }}
            title="Loop In/Out"
          >
            <Repeat className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
  )
}
