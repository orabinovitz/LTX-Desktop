import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { 
  Play, Pause, Plus, Trash2,
  ZoomIn, ZoomOut, Maximize2, Video, Image, Upload,
  Scissors, Volume2, VolumeX, Copy, 
  Layers, MoveHorizontal, SkipBack, SkipForward, Square,
  Gauge, ArrowLeftRight, Download, MousePointer2, Hand,
  Magnet, Lock, Unlock, GripVertical, Pencil, Film,
  FlipHorizontal2, FlipVertical2, Sun, Contrast, Palette,
  Thermometer, Droplets, Eye, EyeOff, SunDim, Moon,
  ChevronDown, ChevronRight, ChevronLeft, RotateCcw,
  Clipboard, ArrowDown, ArrowUp, Music,
  FolderPlus, Folder, FolderOpen, X, RefreshCw, Loader2, GitMerge,
  Repeat, FileVideo, FileImage, FileAudio, MessageSquare, FileUp, FileDown,
  Sparkles
} from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { useGeneration } from '../hooks/use-generation'
import { Button } from '../components/ui/button'
import { ExportModal } from '../components/ExportModal'
import { ImportTimelineModal } from '../components/ImportTimelineModal'
import type { GenerationSettings } from '../components/SettingsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import type { Asset, TimelineClip, Track, TransitionType, SubtitleClip, SubtitleStyle, LetterboxSettings } from '../types/project'
import { DEFAULT_SUBTITLE_STYLE, DEFAULT_LETTERBOX } from '../types/project'
import { parseSrt, exportSrt } from '../lib/srt'
import { DEFAULT_TRACKS, DEFAULT_COLOR_CORRECTION } from '../types/project'
import type { ParsedTimeline } from '../lib/timeline-import'
import { exportFcp7Xml } from '../lib/timeline-import'

type ToolType = 'select' | 'trackForward' | 'blade' | 'hand' | 'slip' | 'slide' | 'ripple' | 'roll'

const TOOLS: { id: ToolType; icon: any; label: string; shortcut: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Selection Tool', shortcut: 'V' },
  { id: 'trackForward', icon: ChevronRight, label: 'Track Select Forward', shortcut: 'A' },
  { id: 'blade', icon: Scissors, label: 'Blade Tool', shortcut: 'B' },
  { id: 'hand', icon: Hand, label: 'Hand Tool', shortcut: 'H' },
  { id: 'ripple', icon: ArrowLeftRight, label: 'Ripple Trim', shortcut: 'R' },
  { id: 'roll', icon: GitMerge, label: 'Roll Trim (A/B)', shortcut: 'N' },
  { id: 'slip', icon: MoveHorizontal, label: 'Slip Tool', shortcut: 'Y' },
  { id: 'slide', icon: Gauge, label: 'Slide Tool', shortcut: 'U' },
]

// ------------------------------------------------------------------
// Overwrite helper: given a moved/placed clip, trim or split any clips
// on the same track that it overlaps. Returns the updated clips array.
// `movedIds` = IDs of the clip(s) being moved (they should not be trimmed).
// ------------------------------------------------------------------
function resolveOverlaps(
  allClips: TimelineClip[],
  movedIds: Set<string>,
): TimelineClip[] {
  let result = [...allClips]

  for (const movedId of movedIds) {
    const moved = result.find(c => c.id === movedId)
    if (!moved) continue

    const movedStart = moved.startTime
    const movedEnd = moved.startTime + moved.duration

    const next: TimelineClip[] = []

    for (const c of result) {
      // Skip the moved clip itself — always keep it
      if (movedIds.has(c.id)) { next.push(c); continue }
      // Only affect clips on the same track
      if (c.trackIndex !== moved.trackIndex) { next.push(c); continue }

      const cStart = c.startTime
      const cEnd = c.startTime + c.duration

      // No overlap — keep as-is
      if (cEnd <= movedStart || cStart >= movedEnd) { next.push(c); continue }

      // Completely covered — remove the clip
      if (cStart >= movedStart && cEnd <= movedEnd) continue

      // Partial overlap: moved covers the RIGHT part of c (trim c's right side)
      if (cStart < movedStart && cEnd > movedStart && cEnd <= movedEnd) {
        const newDuration = movedStart - cStart
        next.push({ ...c, duration: newDuration })
        continue
      }

      // Partial overlap: moved covers the LEFT part of c (trim c's left side)
      if (cStart >= movedStart && cStart < movedEnd && cEnd > movedEnd) {
        const trimAmount = movedEnd - cStart
        const newTrimStart = c.trimStart + trimAmount * c.speed
        next.push({
          ...c,
          startTime: movedEnd,
          duration: c.duration - trimAmount,
          trimStart: newTrimStart,
        })
        continue
      }

      // Moved clip is entirely inside c — split c into two pieces
      if (cStart < movedStart && cEnd > movedEnd) {
        // Left piece: from c's start to movedStart
        const leftDuration = movedStart - cStart
        next.push({ ...c, duration: leftDuration })

        // Right piece: from movedEnd to c's end
        const rightTrimAmount = (movedEnd - cStart) * c.speed
        const rightDuration = cEnd - movedEnd
        next.push({
          ...c,
          id: `${c.id}-split-${Date.now()}`,
          startTime: movedEnd,
          duration: rightDuration,
          trimStart: c.trimStart + rightTrimAmount,
        })
        continue
      }

      // Fallback: keep the clip
      next.push(c)
    }

    result = next
  }

  return result
}

// Debounce delay for auto-saving timeline changes to context (ms)
const AUTOSAVE_DELAY = 500

// Max number of undo steps
const MAX_UNDO_HISTORY = 50

// Undo action types
type UndoAction =
  | { type: 'clips'; clips: TimelineClip[] }
  | { type: 'assets'; assets: Asset[] }

// Tolerance in seconds for detecting adjacent clips (cut points)
const CUT_POINT_TOLERANCE = 0.05

// Default cross-dissolve duration in seconds
const DEFAULT_DISSOLVE_DURATION = 0.5

// --- Resizable layout constants ---
const LAYOUT_STORAGE_KEY = 'ltx-video-editor-layout'

interface EditorLayout {
  leftPanelWidth: number   // px
  rightPanelWidth: number  // px
  timelineHeight: number   // px
  assetsHeight: number     // px – height of assets section in left panel (timelines gets the rest)
}

const DEFAULT_LAYOUT: EditorLayout = {
  leftPanelWidth: 288,   // w-72
  rightPanelWidth: 256,   // w-64
  timelineHeight: 224,    // h-56
  assetsHeight: 0,        // 0 = auto (use flex proportions)
}

const LAYOUT_LIMITS = {
  leftPanelWidth:  { min: 180, max: 480 },
  rightPanelWidth: { min: 200, max: 480 },
  timelineHeight:  { min: 120, max: 600 },
  assetsHeight:    { min: 120, max: 800 },
}

function loadLayout(): EditorLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        leftPanelWidth: clampVal(parsed.leftPanelWidth ?? DEFAULT_LAYOUT.leftPanelWidth, LAYOUT_LIMITS.leftPanelWidth),
        rightPanelWidth: clampVal(parsed.rightPanelWidth ?? DEFAULT_LAYOUT.rightPanelWidth, LAYOUT_LIMITS.rightPanelWidth),
        timelineHeight: clampVal(parsed.timelineHeight ?? DEFAULT_LAYOUT.timelineHeight, LAYOUT_LIMITS.timelineHeight),
        assetsHeight: parsed.assetsHeight ? clampVal(parsed.assetsHeight, LAYOUT_LIMITS.assetsHeight) : 0,
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT }
}

function saveLayout(layout: EditorLayout) {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
}

function clampVal(val: number, limits: { min: number; max: number }): number {
  return Math.max(limits.min, Math.min(limits.max, val))
}

// Migrate old clips that don't have new effect fields
function migrateClip(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    flipH: clip.flipH ?? false,
    flipV: clip.flipV ?? false,
    transitionIn: clip.transitionIn ?? { type: 'none', duration: 0.5 },
    transitionOut: clip.transitionOut ?? { type: 'none', duration: 0.5 },
    colorCorrection: clip.colorCorrection ?? { ...DEFAULT_COLOR_CORRECTION },
    opacity: clip.opacity ?? 100,
    isRegenerating: false, // Never persist regeneration state across sessions
  }
}

// Migrate tracks from old format (no kind) to new NLE layout.
// Heuristic: if a track has no `kind`, infer from its name or position.
function migrateTracks(tracks: Track[]): Track[] {
  return tracks.map(t => {
    if (t.kind) return t // already tagged
    if (t.type === 'subtitle') return t // subtitle tracks don't need kind
    // Infer from name
    if (/^A\d/i.test(t.name)) return { ...t, kind: 'audio' as const }
    if (/^V\d/i.test(t.name)) return { ...t, kind: 'video' as const }
    // Legacy "Track N" — default to video
    return { ...t, kind: 'video' as const }
  })
}

// Build CSS filter + transform strings from clip effects
function getClipEffectStyles(clip: TimelineClip, timeInClip?: number): React.CSSProperties {
  const cc = clip.colorCorrection || DEFAULT_COLOR_CORRECTION
  const filters: string[] = []

  // Brightness: CSS brightness(1) = normal, range 0..2 mapped from -100..100
  if (cc.brightness !== 0) filters.push(`brightness(${1 + cc.brightness / 100})`)
  // Contrast: CSS contrast(1) = normal, range 0..2
  if (cc.contrast !== 0) filters.push(`contrast(${1 + cc.contrast / 100})`)
  // Saturation: CSS saturate(1) = normal, range 0..2
  if (cc.saturation !== 0) filters.push(`saturate(${1 + cc.saturation / 100})`)
  // Exposure via brightness boost (stacks with brightness for combined effect)
  if (cc.exposure !== 0) filters.push(`brightness(${1 + cc.exposure / 200})`)
  // Temperature: warm = sepia + hue-rotate towards warm, cool = hue-rotate towards blue
  if (cc.temperature !== 0) {
    const t = cc.temperature
    if (t > 0) {
      filters.push(`sepia(${t / 200})`)
      filters.push(`hue-rotate(-${t * 0.1}deg)`)
    } else {
      filters.push(`hue-rotate(${Math.abs(t) * 0.4}deg)`)
    }
  }
  // Tint: hue-rotate for green/magenta shift
  if (cc.tint !== 0) {
    filters.push(`hue-rotate(${cc.tint * 1.2}deg)`)
  }
  // Highlights: simulate with a small brightness bump (positive) or drop (negative)
  if (cc.highlights !== 0) filters.push(`brightness(${1 + cc.highlights / 300})`)
  // Shadows: simulate with contrast adjustment
  if (cc.shadows !== 0) filters.push(`contrast(${1 + cc.shadows / 300})`)

  // Flip transforms
  const transforms: string[] = []
  if (clip.flipH) transforms.push('scaleX(-1)')
  if (clip.flipV) transforms.push('scaleY(-1)')

  // Transition opacity
  // Base opacity from clip property (0-100 mapped to 0-1)
  let opacity = (clip.opacity ?? 100) / 100
  if (timeInClip !== undefined) {
    const tIn = clip.transitionIn
    const tOut = clip.transitionOut
    // Fade in (only for fade-to-black/white; dissolve is handled separately via dual-clip rendering)
    if (tIn && tIn.duration > 0 && timeInClip < tIn.duration) {
      if (tIn.type === 'fade-to-black' || tIn.type === 'fade-to-white') {
        opacity = Math.min(opacity, timeInClip / tIn.duration)
      }
      // dissolve opacity is NOT applied here -- it's handled in the cross-dissolve preview
    }
    // Fade out (only for fade-to-black/white; dissolve is handled separately)
    if (tOut && tOut.duration > 0) {
      const timeFromEnd = clip.duration - timeInClip
      if (timeFromEnd < tOut.duration) {
        if (tOut.type === 'fade-to-black' || tOut.type === 'fade-to-white') {
          opacity = Math.min(opacity, timeFromEnd / tOut.duration)
        }
      }
    }
    // Wipe transitions: use clip-path
  }

  // Build clip-path for wipe transitions
  let clipPath: string | undefined
  if (timeInClip !== undefined) {
    const tIn = clip.transitionIn
    const tOut = clip.transitionOut
    if (tIn && tIn.type.startsWith('wipe-') && tIn.duration > 0 && timeInClip < tIn.duration) {
      const progress = timeInClip / tIn.duration
      clipPath = getWipeClipPath(tIn.type as TransitionType, progress, true)
    }
    if (tOut && tOut.type.startsWith('wipe-') && tOut.duration > 0) {
      const timeFromEnd = clip.duration - timeInClip
      if (timeFromEnd < tOut.duration) {
        const progress = timeFromEnd / tOut.duration
        clipPath = getWipeClipPath(tOut.type as TransitionType, progress, false)
      }
    }
  }

  const style: React.CSSProperties = {}
  if (filters.length > 0) style.filter = filters.join(' ')
  if (transforms.length > 0) style.transform = transforms.join(' ')
  if (opacity < 1) style.opacity = opacity
  if (clipPath) style.clipPath = clipPath

  return style
}

function getWipeClipPath(type: TransitionType, progress: number, isIn: boolean): string {
  const p = Math.max(0, Math.min(1, progress)) * 100
  switch (type) {
    case 'wipe-left':
      return isIn ? `inset(0 ${100 - p}% 0 0)` : `inset(0 0 0 ${100 - p}%)`
    case 'wipe-right':
      return isIn ? `inset(0 0 0 ${100 - p}%)` : `inset(0 ${100 - p}% 0 0)`
    case 'wipe-up':
      return isIn ? `inset(0 0 ${100 - p}% 0)` : `inset(${100 - p}% 0 0 0)`
    case 'wipe-down':
      return isIn ? `inset(${100 - p}% 0 0 0)` : `inset(0 0 ${100 - p}% 0)`
    default:
      return ''
  }
}

// Get the background color for transition overlay
function getTransitionBgColor(type: TransitionType): string | null {
  if (type === 'fade-to-black') return 'black'
  if (type === 'fade-to-white') return 'white'
  return null
}

// ------------------------------------------------------------------
// Asset grid thumbnail card with hover-scrub
// ------------------------------------------------------------------
function VideoThumbnailCard({ url, thumbnailUrl }: { url: string; thumbnailUrl?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isHovering, setIsHovering] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [scrubProgress, setScrubProgress] = useState(0)
  const [scrubTime, setScrubTime] = useState('')
  const rafRef = useRef<number>(0)

  // Draw the current video frame to canvas for smooth scrub display
  const drawFrame = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Match canvas size to actual rendered size
    const rect = canvas.getBoundingClientRect()
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width
      canvas.height = rect.height
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const video = videoRef.current
    const container = containerRef.current
    if (!video || !container || !video.duration || isNaN(video.duration)) return
    const rect = container.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    const pct = x / rect.width
    const targetTime = pct * video.duration
    video.currentTime = targetTime
    setScrubProgress(pct)
    // Format time
    const mins = Math.floor(targetTime / 60)
    const secs = Math.floor(targetTime % 60)
    const frames = Math.floor((targetTime % 1) * 24) // assume 24fps for display
    setScrubTime(`${mins}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`)
    // Draw frame after seek
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(drawFrame)
  }, [drawFrame])

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false)
    setVideoReady(false)
    setScrubProgress(0)
    setScrubTime('')
    const video = videoRef.current
    if (video) {
      video.currentTime = 0
      video.removeAttribute('src')
      video.load()
    }
  }, [])

  // When hovering starts, load the video
  useEffect(() => {
    if (!isHovering) return
    const video = videoRef.current
    if (!video) return
    video.src = url
    video.preload = 'auto'
    video.load()

    const onLoaded = () => {
      setVideoReady(true)
      // Draw first frame
      requestAnimationFrame(drawFrame)
    }
    video.addEventListener('loadeddata', onLoaded, { once: true })
    return () => video.removeEventListener('loadeddata', onLoaded)
  }, [isHovering, url, drawFrame])

  // Also draw on seeked event for accuracy
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isHovering) return
    const onSeeked = () => requestAnimationFrame(drawFrame)
    video.addEventListener('seeked', onSeeked)
    return () => video.removeEventListener('seeked', onSeeked)
  }, [isHovering, drawFrame])

  return (
    <div
      ref={containerRef}
      className="w-full aspect-video relative overflow-hidden bg-zinc-900"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={isHovering ? handleMouseMove : undefined}
    >
      {/* Static thumbnail (shown when not hovering or scrub not ready) */}
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className={`w-full h-full object-cover absolute inset-0 ${isHovering && videoReady ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}
        />
      ) : (
        <div className={`w-full h-full bg-zinc-800 absolute inset-0 flex items-center justify-center ${isHovering && videoReady ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
          <Video className="h-5 w-5 text-zinc-600" />
        </div>
      )}

      {/* Canvas for scrub display (layered on top of thumbnail) */}
      <canvas
        ref={canvasRef}
        className={`w-full h-full object-cover absolute inset-0 ${isHovering && videoReady ? 'opacity-100' : 'opacity-0'} transition-opacity duration-100`}
      />

      {/* Hidden video element for scrubbing (never visible, just used for frame extraction) */}
      <video
        ref={videoRef}
        className="hidden"
        muted
        playsInline
        preload="none"
      />

      {/* Scrub progress bar */}
      {isHovering && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/40">
          <div
            className="h-full bg-violet-500 transition-none"
            style={{ width: `${scrubProgress * 100}%` }}
          />
        </div>
      )}

      {/* Timecode tooltip */}
      {isHovering && videoReady && scrubTime && (
        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-sm">
          <span className="text-[9px] text-white font-mono tabular-nums">{scrubTime}</span>
        </div>
      )}
    </div>
  )
}

export function VideoEditor() {
  const { 
    currentProject, currentProjectId, addAsset, deleteAsset, updateAsset,
    addTakeToAsset, deleteTakeFromAsset, setAssetActiveTake,
    addTimeline, deleteTimeline, renameTimeline, duplicateTimeline,
    setActiveTimeline, updateTimeline, getActiveTimeline,
  } = useProjects()
  
  // Generation hook for regenerating shots
  const {
    generate: regenGenerate,
    generateImage: regenGenerateImage,
    isGenerating: isRegenerating,
    progress: regenProgress,
    statusMessage: regenStatusMessage,
    videoUrl: regenVideoUrl,
    videoPath: regenVideoPath,
    imageUrl: regenImageUrl,
    cancel: regenCancel,
    reset: regenReset,
  } = useGeneration()
  
  // Track which asset/clip is being regenerated
  const [regeneratingAssetId, setRegeneratingAssetId] = useState<string | null>(null)
  const [regeneratingClipId, setRegeneratingClipId] = useState<string | null>(null)
  
  // Upscale state
  const [upscalingClipIds, setUpscalingClipIds] = useState<Set<string>>(new Set())
  const [upscaleTimelineProgress, setUpscaleTimelineProgress] = useState<{ current: number; total: number; active: boolean } | null>(null)
  const [showUpscaleDialog, setShowUpscaleDialog] = useState<{ timelineId: string } | null>(null)
  
  // Get the active timeline from context
  const activeTimeline = currentProjectId ? getActiveTimeline(currentProjectId) : null
  
  // Local working copies of clips and tracks (for responsive editing without saving on every frame)
  const [clips, setClips] = useState<TimelineClip[]>((activeTimeline?.clips || []).map(migrateClip))
  const [tracks, setTracks] = useState<Track[]>(migrateTracks(activeTimeline?.tracks || DEFAULT_TRACKS.map(t => ({ ...t }))))
  const [subtitles, setSubtitles] = useState<SubtitleClip[]>(activeTimeline?.subtitles || [])
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null)
  const [editingSubtitleId, setEditingSubtitleId] = useState<string | null>(null) // inline editing
  const subtitleFileInputRef = useRef<HTMLInputElement>(null)
  
  // Transient UI state (not persisted)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [assetFilter, setAssetFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all')
  const [selectedBin, setSelectedBin] = useState<string | null>(null) // null = all assets
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set())
  const [binDropdownOpen, setBinDropdownOpen] = useState(false)
  // Lasso selection for assets
  const [assetLasso, setAssetLasso] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const assetGridRef = useRef<HTMLDivElement>(null)
  const [assetContextMenu, setAssetContextMenu] = useState<{ assetId: string; x: number; y: number } | null>(null)
  const assetContextMenuRef = useRef<HTMLDivElement>(null)
  const [takesViewAssetId, setTakesViewAssetId] = useState<string | null>(null) // drill-in to see all takes
  const [takeContextMenu, setTakeContextMenu] = useState<{ assetId: string; takeIndex: number; x: number; y: number } | null>(null)
  const takeContextMenuRef = useRef<HTMLDivElement>(null)
  const [creatingBin, setCreatingBin] = useState(false)
  const [newBinName, setNewBinName] = useState('')
  const newBinInputRef = useRef<HTMLInputElement>(null)
  const [binContextMenu, setBinContextMenu] = useState<{ bin: string; x: number; y: number } | null>(null)
  const binContextMenuRef = useRef<HTMLDivElement>(null)
  const [activeTool, setActiveTool] = useState<ToolType>('select')
  const [snapEnabled, setSnapEnabled] = useState(true)
  
  // In/Out points
  // In/Out points stored per-timeline so they don't bleed across timelines
  const [timelineInOutMap, setTimelineInOutMap] = useState<Record<string, { inPoint: number | null; outPoint: number | null }>>({})
  const [playingInOut, setPlayingInOut] = useState(false) // Looping between In and Out
  
  // Derive current In/Out from map using active timeline ID
  const activeTimelineId = activeTimeline?.id || ''
  const activeTimelineIdRef = useRef(activeTimelineId)
  activeTimelineIdRef.current = activeTimelineId
  const inPoint = timelineInOutMap[activeTimelineId]?.inPoint ?? null
  const outPoint = timelineInOutMap[activeTimelineId]?.outPoint ?? null
  
  // Stable setters that always read the current activeTimelineId from a ref
  const setInPoint = useCallback((updater: (prev: number | null) => number | null) => {
    setTimelineInOutMap(prev => {
      const tlId = activeTimelineIdRef.current
      if (!tlId) return prev
      const current = prev[tlId] || { inPoint: null, outPoint: null }
      const newIn = updater(current.inPoint)
      return { ...prev, [tlId]: { ...current, inPoint: newIn } }
    })
  }, [])
  
  const setOutPoint = useCallback((updater: (prev: number | null) => number | null) => {
    setTimelineInOutMap(prev => {
      const tlId = activeTimelineIdRef.current
      if (!tlId) return prev
      const current = prev[tlId] || { inPoint: null, outPoint: null }
      const newOut = updater(current.outPoint)
      return { ...prev, [tlId]: { ...current, outPoint: newOut } }
    })
  }, [])
  
  const clearInOut = useCallback(() => {
    setTimelineInOutMap(prev => {
      const tlId = activeTimelineIdRef.current
      if (!tlId) return prev
      return { ...prev, [tlId]: { inPoint: null, outPoint: null } }
    })
    setPlayingInOut(false)
  }, [])
  
  // Export modal
  const [showExportModal, setShowExportModal] = useState(false)
  
  // Import timeline modal
  const [showImportTimelineModal, setShowImportTimelineModal] = useState(false)
  
  // Gap selection and generation
  const [selectedGap, setSelectedGap] = useState<{ trackIndex: number; startTime: number; endTime: number } | null>(null)
  const [gapGenerateMode, setGapGenerateMode] = useState<'text-to-video' | 'image-to-video' | 'text-to-image' | null>(null)
  const gapGenerateModeRef = useRef(gapGenerateMode)
  gapGenerateModeRef.current = gapGenerateMode
  const [gapPrompt, setGapPrompt] = useState('')
  const [gapSettings, setGapSettings] = useState<GenerationSettings>({
    model: 'fast',
    duration: 5,
    resolution: '768x512',
    fps: 24,
    audio: false,
    cameraMotion: 'none',
    imageAspectRatio: '16:9',
    imageSteps: 30,
  })
  const [gapImageFile, setGapImageFile] = useState<File | null>(null)
  const gapImageInputRef = useRef<HTMLInputElement>(null)
  
  // Subtitle track global style editor
  const [subtitleTrackStyleIdx, setSubtitleTrackStyleIdx] = useState<number | null>(null) // index of subtitle track being edited
  
  // Gap context-aware prompt suggestion (via Gemini)
  const [gapSuggesting, setGapSuggesting] = useState(false)
  const [gapSuggestion, setGapSuggestion] = useState<string | null>(null)
  const gapSuggestionAbortRef = useRef<AbortController | null>(null)
  // Frames extracted from neighboring clips for the gap animation header
  const [gapBeforeFrame, setGapBeforeFrame] = useState<string | null>(null) // base64 data URI
  const [gapAfterFrame, setGapAfterFrame] = useState<string | null>(null)   // base64 data URI
  
  // Image-to-Video generation from an image clip on the timeline
  const [i2vClipId, setI2vClipId] = useState<string | null>(null)
  const [i2vPrompt, setI2vPrompt] = useState('')
  const [i2vSettings, setI2vSettings] = useState<GenerationSettings>({
    model: 'fast',
    duration: 5,
    resolution: '768x512',
    fps: 24,
    audio: false,
    cameraMotion: 'none',
    imageAspectRatio: '16:9',
    imageSteps: 30,
  })
  
  // Clip properties panel collapsible sections
  const [showTransitions, setShowTransitions] = useState(false)
  const [showFlip, setShowFlip] = useState(false)
  const [showColorCorrection, setShowColorCorrection] = useState(false)
  
  // Clip properties panel tabs: 'properties' = controls, 'metadata' = info
  const [propertiesTab, setPropertiesTab] = useState<'properties' | 'metadata'>('properties')
  
  // Resolution metadata cache: key = video/image URL, value = { width, height }
  const [resolutionCache, setResolutionCache] = useState<Record<string, { width: number; height: number }>>({})
  
  // Resizable layout
  const [layout, setLayout] = useState<EditorLayout>(loadLayout)
  const resizeDragRef = useRef<{
    type: 'left' | 'right' | 'timeline' | 'assets'
    startPos: number
    startSize: number
  } | null>(null)
  
  // Lasso / marquee selection state
  const [lassoRect, setLassoRect] = useState<{
    startX: number; startY: number; currentX: number; currentY: number
  } | null>(null)
  const lassoOriginRef = useRef<{ scrollLeft: number; containerLeft: number; containerTop: number } | null>(null)
  
  // JKL shuttle speed: -8, -4, -2, -1, 0, 1, 2, 4, 8
  const [shuttleSpeed, setShuttleSpeed] = useState(0)
  const kHeldRef = useRef(false)
  
  // Timeline tab UI state
  const [renamingTimelineId, setRenamingTimelineId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [timelineContextMenu, setTimelineContextMenu] = useState<{ timelineId: string; x: number; y: number } | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement>(null)
  // Open timeline tabs — only these appear in the tab bar above the timeline.
  // All timelines are always visible in the library panel on the left.
  const [openTimelineIds, setOpenTimelineIds] = useState<Set<string>>(new Set())
  const [timelineAddMenuOpen, setTimelineAddMenuOpen] = useState(false)
  
  // Dragging state
  const [draggingClip, setDraggingClip] = useState<{
    clipId: string
    startX: number
    startY: number
    originalStartTime: number
    originalTrackIndex: number
    originalPositions: Record<string, { startTime: number; trackIndex: number }>
    isDuplicate?: boolean // Alt+drag: these clips are duplicates being placed
  } | null>(null)
  
  // Resizing/trimming state
  const [resizingClip, setResizingClip] = useState<{
    clipId: string
    edge: 'left' | 'right'
    startX: number
    originalStartTime: number
    originalDuration: number
    originalTrimStart: number
    originalTrimEnd: number
    tool: ToolType // which tool was active when resize started
    adjacentClipId?: string // for roll trim: the clip on the other side of the edit
    adjacentOrigDuration?: number
    adjacentOrigTrimStart?: number
    adjacentOrigTrimEnd?: number
    adjacentOrigStartTime?: number
  } | null>(null)
  
  // Slip/slide drag state
  const [slipSlideClip, setSlipSlideClip] = useState<{
    clipId: string
    tool: 'slip' | 'slide'
    startX: number
    originalTrimStart: number
    originalTrimEnd: number
    originalStartTime: number
    originalDuration: number
    // For slide: adjacent clip info
    prevClipId?: string
    prevOrigDuration?: number
    nextClipId?: string
    nextOrigStartTime?: number
    nextOrigDuration?: number
    nextOrigTrimStart?: number
  } | null>(null)
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const trackContainerRef = useRef<HTMLDivElement>(null)
  const trackHeadersRef = useRef<HTMLDivElement>(null)
  const rulerScrollRef = useRef<HTMLDivElement>(null)
  const centerOnPlayheadRef = useRef(false) // Flag: center view on playhead after next zoom change
  // previewVideoRef always points to the ACTIVE (visible) pool video element
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const previewImageRef = useRef<HTMLImageElement>(null)
  const dissolveOutVideoRef = useRef<HTMLVideoElement>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [previewZoom, setPreviewZoom] = useState<number | 'fit'>('fit') // 'fit' or percentage (e.g. 100 = 100%)
  const [previewZoomOpen, setPreviewZoomOpen] = useState(false)
  const [playbackResolution, setPlaybackResolution] = useState<1 | 0.5 | 0.25>(0.5) // Playback quality: 1=Full, 0.5=Half, 0.25=Quarter
  const [playbackResOpen, setPlaybackResOpen] = useState(false)
  // Computed video frame dimensions (object-fit:contain equivalent for a div)
  const [videoFrameSize, setVideoFrameSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  
  // Video pool for gapless playback: Map<sourceUrl, HTMLVideoElement>
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const activePoolSrcRef = useRef<string>('') // Currently visible pool video src
  
  // --- Performance refs: allow the rAF playback loop to sync video directly ---
  // These mirror React state so the hot loop doesn't depend on re-renders.
  const playbackTimeRef = useRef(0)            // authoritative time during playback
  const clipsRef = useRef(clips)               // mirror of clips state
  const tracksRef = useRef(tracks)             // mirror of tracks state
  const assetsRef = useRef<any[]>([])            // mirror of assets state
  const isPlayingRef = useRef(false)           // mirror of isPlaying state
  const shuttleSpeedRef = useRef(0)            // mirror of shuttleSpeed
  const lastStateUpdateRef = useRef(0)         // timestamp of last React state sync
  const preSeekDoneRef = useRef<string | null>(null) // clipId we already pre-seeked
  const playheadRulerRef = useRef<HTMLDivElement>(null) // direct DOM ref for ruler playhead
  const playheadOverlayRef = useRef<HTMLDivElement>(null) // direct DOM ref for the full-height overlay playhead
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 })
  const previewPanRef = useRef({ dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 })
  const renameInputRef = useRef<HTMLInputElement>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  
  // Keep performance refs in sync with state (cheap assignments, no re-renders)
  useEffect(() => { clipsRef.current = clips }, [clips])
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { shuttleSpeedRef.current = shuttleSpeed }, [shuttleSpeed])
  // Only sync ref ← state when NOT playing (during playback, ref is authoritative)
  useEffect(() => { if (!isPlaying) playbackTimeRef.current = currentTime }, [currentTime, isPlaying])
  
  // Undo/redo history (unified: supports both clip and asset actions)
  const undoStackRef = useRef<UndoAction[]>([])
  const redoStackRef = useRef<UndoAction[]>([])
  const skipHistoryRef = useRef(false) // flag to skip recording when undoing/redoing
  
  // Clipboard for copy/paste
  const clipboardRef = useRef<TimelineClip[]>([])
  
  // Hovered cut point for cross-dissolve UI
  const [hoveredCutPoint, setHoveredCutPoint] = useState<{
    leftClipId: string; rightClipId: string; time: number; trackIndex: number
  } | null>(null)
  
  // Clip right-click context menu
  const [clipContextMenu, setClipContextMenu] = useState<{
    clipId: string; x: number; y: number
  } | null>(null)
  const clipContextMenuRef = useRef<HTMLDivElement>(null)
  
  // Track which timeline is loaded locally so we can detect switches
  const loadedTimelineIdRef = useRef<string | null>(null)
  
  // --- Resizable panel drag handlers ---
  const handleResizeDragStart = useCallback((type: 'left' | 'right' | 'timeline' | 'assets', e: React.MouseEvent) => {
    e.preventDefault()
    const isVertical = type === 'timeline' || type === 'assets'
    const startPos = isVertical ? e.clientY : e.clientX
    const startSize = type === 'left' ? layout.leftPanelWidth
      : type === 'right' ? layout.rightPanelWidth
      : type === 'assets' ? layout.assetsHeight
      : layout.timelineHeight
    resizeDragRef.current = { type, startPos, startSize }
    
    const handleMove = (ev: MouseEvent) => {
      if (!resizeDragRef.current) return
      const { type: t, startPos: sp, startSize: ss } = resizeDragRef.current
      const isV = t === 'timeline' || t === 'assets'
      const pos = isV ? ev.clientY : ev.clientX
      const delta = pos - sp
      
      if (t === 'left') {
        const newWidth = clampVal(ss + delta, LAYOUT_LIMITS.leftPanelWidth)
        setLayout(prev => ({ ...prev, leftPanelWidth: newWidth }))
      } else if (t === 'right') {
        const newWidth = clampVal(ss - delta, LAYOUT_LIMITS.rightPanelWidth)
        setLayout(prev => ({ ...prev, rightPanelWidth: newWidth }))
      } else if (t === 'assets') {
        // Assets: dragging down increases height
        const newHeight = clampVal(ss + delta, LAYOUT_LIMITS.assetsHeight)
        setLayout(prev => ({ ...prev, assetsHeight: newHeight }))
      } else {
        const newHeight = clampVal(ss - delta, LAYOUT_LIMITS.timelineHeight)
        setLayout(prev => ({ ...prev, timelineHeight: newHeight }))
      }
    }
    
    const handleUp = () => {
      resizeDragRef.current = null
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setLayout(prev => { saveLayout(prev); return prev })
    }
    
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }, [layout])
  
  const handleResetLayout = useCallback(() => {
    setLayout({ ...DEFAULT_LAYOUT })
    saveLayout({ ...DEFAULT_LAYOUT })
  }, [])
  
  const assets = currentProject?.assets || []
  const timelines = currentProject?.timelines || []
  
  // Ensure the active timeline is always in the open tab set.
  // On first load (empty set), open only the active timeline.
  useEffect(() => {
    const activeId = activeTimeline?.id
    if (!activeId) return
    setOpenTimelineIds(prev => {
      // If the set is empty (first load / project switch), seed it with just the active timeline
      if (prev.size === 0) return new Set([activeId])
      // Otherwise just make sure the active one is open
      if (prev.has(activeId)) return prev
      const next = new Set(prev)
      next.add(activeId)
      return next
    })
  }, [activeTimeline?.id])
  
  // Clean up open IDs when timelines are deleted
  useEffect(() => {
    const validIds = new Set(timelines.map(t => t.id))
    setOpenTimelineIds(prev => {
      const next = new Set<string>()
      for (const id of prev) { if (validIds.has(id)) next.add(id) }
      if (next.size !== prev.size) return next
      return prev
    })
  }, [timelines])
  
  // Keep assetsRef in sync (declared after assets to avoid forward-reference)
  useEffect(() => { assetsRef.current = assets }, [assets])
  
  // Compute bins from assets
  const bins = useMemo(() => {
    const binSet = new Set<string>()
    for (const asset of assets) {
      if (asset.bin) binSet.add(asset.bin)
    }
    return Array.from(binSet).sort()
  }, [assets])
  
  // Filter assets by type + bin
  const filteredAssets = useMemo(() => {
    let result = assets
    if (assetFilter !== 'all') {
      result = result.filter(a => a.type === assetFilter)
    }
    if (selectedBin !== null) {
      result = result.filter(a => a.bin === selectedBin)
    }
    return result
  }, [assets, assetFilter, selectedBin])
  
  // --- Thumbnail generation for video assets ---
  const [thumbnailMap, setThumbnailMap] = useState<Record<string, string>>({})
  
  useEffect(() => {
    // Generate thumbnails for all video assets that don't have one yet
    let cancelled = false
    const videoAssets = assets.filter(a => a.type === 'video' && a.url)
    
    const genAll = async () => {
      for (const asset of videoAssets) {
        if (cancelled) break
        const url = asset.url
        if (thumbnailMap[url]) continue
        try {
          const { generateThumbnail } = await import('../lib/thumbnails')
          const thumb = await generateThumbnail(url)
          if (!cancelled) {
            setThumbnailMap(prev => ({ ...prev, [url]: thumb }))
          }
        } catch {
          // skip – will show fallback
        }
      }
    }
    genAll()
    return () => { cancelled = true }
  }, [assets]) // re-run when assets change
  
  // For the properties panel: show properties when exactly one clip is selected
  const selectedClip = selectedClipIds.size === 1
    ? clips.find(c => c.id === [...selectedClipIds][0])
    : null
  
  const totalDuration = Math.max(
    clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0),
    30
  )
  
  const pixelsPerSecond = 100 * zoom

  // Dynamic minimum zoom: at min zoom the whole timeline fits in view
  // Falls back to 0.05 if container isn't mounted yet
  const getMinZoom = useCallback(() => {
    const container = trackContainerRef.current
    if (!container || totalDuration <= 0) return 0.05
    const containerWidth = container.clientWidth - 20
    return Math.min(0.5, Math.max(0.01, containerWidth / (totalDuration * 100)))
  }, [totalDuration])
  const getMinZoomRef = useRef(getMinZoom)
  getMinZoomRef.current = getMinZoom
  
  // Detect cut points: adjacent clips on the same track where one ends and another begins
  const cutPoints = useMemo(() => {
    const points: { leftClip: TimelineClip; rightClip: TimelineClip; time: number; trackIndex: number; hasDissolve: boolean }[] = []
    // Group clips by track
    const byTrack: Map<number, TimelineClip[]> = new Map()
    for (const clip of clips) {
      if (!byTrack.has(clip.trackIndex)) byTrack.set(clip.trackIndex, [])
      byTrack.get(clip.trackIndex)!.push(clip)
    }
    for (const [trackIdx, trackClips] of byTrack) {
      const sorted = [...trackClips].sort((a, b) => a.startTime - b.startTime)
      for (let i = 0; i < sorted.length - 1; i++) {
        const left = sorted[i]
        const right = sorted[i + 1]
        const leftEnd = left.startTime + left.duration
        if (Math.abs(leftEnd - right.startTime) < CUT_POINT_TOLERANCE) {
          const hasDissolve = (left.transitionOut?.type === 'dissolve') || (right.transitionIn?.type === 'dissolve')
          points.push({ leftClip: left, rightClip: right, time: leftEnd, trackIndex: trackIdx, hasDissolve })
        }
      }
    }
    return points
  }, [clips])
  
  // --- Sync local state with active timeline from context ---
  
  // When the active timeline changes (switch or first load), load its data locally
  useEffect(() => {
    if (!activeTimeline) return
    if (loadedTimelineIdRef.current === activeTimeline.id) return // Already loaded
    
    // Save current timeline before switching (if we had one loaded)
    if (loadedTimelineIdRef.current && currentProjectId) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      updateTimeline(currentProjectId, loadedTimelineIdRef.current, { clips, tracks, subtitles })
    }
    
    // Load new timeline (migrate old clips without new effect fields)
    setClips((activeTimeline.clips || []).map(migrateClip))
    setTracks(migrateTracks(activeTimeline.tracks?.length > 0 ? activeTimeline.tracks : DEFAULT_TRACKS.map(t => ({ ...t }))))
    setSubtitles(activeTimeline.subtitles || [])
    setCurrentTime(0)
    setIsPlaying(false)
    setPlayingInOut(false)
    setSelectedClipIds(new Set())
    setSelectedSubtitleId(null)
    undoStackRef.current = []
    redoStackRef.current = []
    loadedTimelineIdRef.current = activeTimeline.id
  }, [activeTimeline?.id])
  
  // Debounced auto-save: when clips, tracks, or subtitles change, schedule a save
  useEffect(() => {
    if (!currentProjectId || !loadedTimelineIdRef.current) return
    
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      updateTimeline(currentProjectId, loadedTimelineIdRef.current!, { clips, tracks, subtitles })
    }, AUTOSAVE_DELAY)
    
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [clips, tracks, subtitles, currentProjectId])
  
  // Save on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      if (currentProjectId && loadedTimelineIdRef.current) {
        // We can't read latest clips/tracks from state here since this is a cleanup,
        // but the debounced save should have already caught the latest changes.
      }
    }
  }, [])
  
  // --- Core timeline logic ---
  
  // ─── NLE Track display ordering ───────────────────────────────────
  // Video tracks are displayed bottom-to-top (V1 nearest center, VN at top).
  // Audio tracks are displayed top-to-bottom (A1 nearest center, AN at bottom).
  // Subtitle tracks go after audio.
  // The underlying data model (trackIndex) is unchanged — only display is reordered.
  const orderedTracks: { track: Track; realIndex: number; displayRow: number }[] = useMemo(() => {
    const videoTracks: { track: Track; realIndex: number }[] = []
    const audioTracks: { track: Track; realIndex: number }[] = []
    const subtitleTracks: { track: Track; realIndex: number }[] = []
    
    tracks.forEach((track, i) => {
      if (track.type === 'subtitle') {
        subtitleTracks.push({ track, realIndex: i })
      } else if (track.kind === 'audio') {
        audioTracks.push({ track, realIndex: i })
      } else {
        // Default to video kind
        videoTracks.push({ track, realIndex: i })
      }
    })
    
    // Video tracks reversed: highest-numbered at top, V1 at bottom (nearest divider)
    videoTracks.reverse()
    
    // Subtitle tracks at the very top (frozen), then video, then audio
    const ordered = [...subtitleTracks, ...videoTracks, ...audioTracks]
    return ordered.map((entry, displayRow) => ({ ...entry, displayRow }))
  }, [tracks])
  
  // Map: real trackIndex → display row (for positioning clips/gaps/subtitles)
  const trackDisplayRow = useMemo(() => {
    const map = new Map<number, number>()
    orderedTracks.forEach(entry => {
      map.set(entry.realIndex, entry.displayRow)
    })
    return map
  }, [orderedTracks])
  
  // Index of the first audio track in display order (for the divider line)
  const audioDividerDisplayRow = useMemo(() => {
    const firstAudio = orderedTracks.find(e => e.track.kind === 'audio')
    return firstAudio?.displayRow ?? -1
  }, [orderedTracks])
  
  // Helper: compute the top pixel offset for a given real trackIndex,
  // accounting for display reordering and the V/A divider (4px).
  const TRACK_H = 56 // h-14 = 56px
  const DIVIDER_H = 4 // divider between V and A
  const trackTopPx = useCallback((realTrackIndex: number, padding = 0): number => {
    const displayRow = trackDisplayRow.get(realTrackIndex) ?? realTrackIndex
    const dividerOffset = audioDividerDisplayRow >= 0 && displayRow >= audioDividerDisplayRow ? DIVIDER_H : 0
    return displayRow * TRACK_H + dividerOffset + padding
  }, [trackDisplayRow, audioDividerDisplayRow])
  
  // Find the clip at current playhead position
  // Priority: 1) upper tracks (lower trackIndex) win over lower tracks
  //           2) on the same track, the clip placed later (higher array index) wins
  const getClipAtTime = useCallback((time: number): TimelineClip | null => {
    // Only consider video/image clips for the visual preview — audio is heard, not seen
    // Skip adjustment layers (they apply effects but don't have video content)
    // Also skip clips on tracks with output disabled (enabled === false)
    const clipsAtTime = clips
      .map((clip, arrayIndex) => ({ clip, arrayIndex }))
      .filter(({ clip }) =>
        clip.type !== 'audio' && clip.type !== 'adjustment' &&
        (tracks[clip.trackIndex]?.enabled !== false) &&
        time >= clip.startTime && time < clip.startTime + clip.duration
      )
    if (clipsAtTime.length === 0) return null
    // Sort: higher trackIndex first (NLE rule: V3 is above V2, higher tracks take priority)
    // Then higher arrayIndex first (later clip wins on same track)
    clipsAtTime.sort((a, b) => {
      if (a.clip.trackIndex !== b.clip.trackIndex) return b.clip.trackIndex - a.clip.trackIndex
      return b.arrayIndex - a.arrayIndex
    })
    return clipsAtTime[0].clip
  }, [clips, tracks])
  
  const activeClip = getClipAtTime(currentTime)
  const clipPlaybackOffset = activeClip ? currentTime - activeClip.startTime : 0
  
  // Compute the next video clip that follows the current one (for ping-pong preloading)
  
  // Cross-dissolve detection: scan ALL clip pairs for dissolve overlap at current time
  // Independent of activeClip to avoid flickering when getClipAtTime switches between clips
  const crossDissolveState = useMemo(() => {
    for (const clipA of clips) {
      // Check if clipA has a dissolve transition-out
      if (clipA.transitionOut?.type !== 'dissolve' || clipA.transitionOut.duration <= 0) continue
      
      const clipAEnd = clipA.startTime + clipA.duration
      const dissolveStart = clipAEnd - clipA.transitionOut.duration
      
      // Is the playhead within the dissolve-out region of clipA?
      if (currentTime < dissolveStart || currentTime >= clipAEnd) continue
      
      // Find the matching incoming clip (starts at clipA's end, has dissolve-in)
      const clipB = clips.find(c =>
        c.id !== clipA.id &&
        c.trackIndex === clipA.trackIndex &&
        c.transitionIn?.type === 'dissolve' &&
        Math.abs(c.startTime - clipAEnd) < 0.05
      )
      if (!clipB) continue
      
      // Compute progress: 0 = fully outgoing (clipA), 1 = fully incoming (clipB)
      const dissolveDuration = clipA.transitionOut.duration
      const timeIntoDisssolve = currentTime - dissolveStart
      const progress = Math.max(0, Math.min(1, timeIntoDisssolve / dissolveDuration))
      
      return { outgoing: clipA, incoming: clipB, progress }
    }
    return null
  }, [clips, currentTime])
  
  // Compute the maximum timeline duration for a video clip based on its actual media length
  const getMaxClipDuration = useCallback((clip: TimelineClip): number => {
    if (clip.type !== 'video' || !clip.asset?.duration) return Infinity
    const mediaDuration = clip.asset.duration
    const usableMedia = mediaDuration - clip.trimStart - clip.trimEnd
    return Math.max(0.5, usableMedia / clip.speed)
  }, [])
  
  // Frame duration at 24fps
  const frameDuration = 1 / 24
  
  // JKL shuttle speed steps
  const FORWARD_SPEEDS = [1, 2, 4, 8]
  const REVERSE_SPEEDS = [-1, -2, -4, -8]
  
  // Keyboard shortcuts - uses refs to avoid ordering issues with useCallback
  const keyboardStateRef = useRef({
    clips: clips,
    selectedClipIds: selectedClipIds,
    totalDuration: totalDuration,
    selectedAssetIds: selectedAssetIds,
    currentTime: currentTime,
  })
  keyboardStateRef.current = { clips, selectedClipIds, totalDuration, selectedAssetIds, currentTime }
  
  // These handler refs are populated after the useCallbacks below
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  const copyRef = useRef<() => void>(() => {})
  const pasteRef = useRef<() => void>(() => {})
  const cutRef = useRef<() => void>(() => {})
  const pushUndoRef = useRef<() => void>(() => {})
  const pushAssetUndoRef = useRef<() => void>(() => {})
  const fitToViewRef = useRef<() => void>(() => {})
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const { clips: c, selectedClipIds: sel, totalDuration: td, selectedAssetIds: selAssets } = keyboardStateRef.current
      
      switch (e.key.toLowerCase()) {
        // Tool shortcuts (only when no modifier key)
        case 'b': if (!e.ctrlKey && !e.metaKey) setActiveTool('blade'); break
        case 'r': if (!e.ctrlKey && !e.metaKey) setActiveTool('ripple'); break
        case 'n': if (!e.ctrlKey && !e.metaKey) setActiveTool('roll'); break
        case 'u': if (!e.ctrlKey && !e.metaKey) setActiveTool('slide'); break
        case 'delete':
        case 'backspace':
          if (sel.size > 0) {
            pushUndoRef.current()
            setClips(prev => prev.filter(cl => !sel.has(cl.id)))
            setSelectedClipIds(new Set())
          } else if (selectedGap) {
            pushUndoRef.current()
            deleteGap(selectedGap)
          } else if (selectedSubtitleId && !editingSubtitleId) {
            deleteSubtitle(selectedSubtitleId)
          } else if (selAssets.size > 0 && currentProjectId) {
            pushAssetUndoRef.current()
            selAssets.forEach(id => deleteAsset(currentProjectId!, id))
            setSelectedAssetIds(new Set())
          }
          break
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            setSelectedClipIds(new Set(c.map(cl => cl.id)))
          } else if (!e.shiftKey) {
            setActiveTool('trackForward')
          }
          break
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            if (e.shiftKey) { redoRef.current() } else { undoRef.current() }
          }
          break
        case 'y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            redoRef.current()
          } else if (!e.shiftKey) {
            setActiveTool('slip')
          }
          break
        case 'c':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); copyRef.current() }
          break
        case 'v':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); pasteRef.current() }
          else if (!e.shiftKey) { setActiveTool('select') }
          break
        case 'x':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); cutRef.current() }
          break
        case 'escape':
          // Close gap generation panel if open, otherwise deselect clips
          if (gapGenerateModeRef.current) {
            setGapGenerateMode(null)
            setSelectedGap(null)
          } else {
            setSelectedClipIds(new Set())
          }
          break
        
        // In/Out points
        case 'i':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            setInPoint(prev => {
              const { currentTime: ct } = keyboardStateRef.current
              // Toggle off if already at this time
              if (prev !== null && Math.abs(prev - ct) < 0.01) return null
              return ct
            })
          }
          break
        case 'o':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            setOutPoint(prev => {
              const { currentTime: ct } = keyboardStateRef.current
              if (prev !== null && Math.abs(prev - ct) < 0.01) return null
              return ct
            })
          }
          break
        
        // Clear In/Out with Alt+X
        case 'x':
          if (e.altKey) {
            e.preventDefault()
            clearInOut()
          }
          break
        
        case ' ':
          e.preventDefault()
          setShuttleSpeed(0)
          setIsPlaying(p => !p)
          break
          
        // JKL Shuttle Control
        case 'j': {
          e.preventDefault()
          if (kHeldRef.current) {
            setIsPlaying(false)
            setShuttleSpeed(0)
            setCurrentTime(prev => Math.max(0, prev - frameDuration))
          } else {
            setShuttleSpeed(prev => {
              if (prev > 0) return -1
              const idx = REVERSE_SPEEDS.indexOf(prev)
              const nextIdx = idx >= 0 ? Math.min(idx + 1, REVERSE_SPEEDS.length - 1) : 0
              return REVERSE_SPEEDS[nextIdx]
            })
            setIsPlaying(true)
          }
          break
        }
        case 'k': {
          e.preventDefault()
          kHeldRef.current = true
          setShuttleSpeed(0)
          setIsPlaying(false)
          break
        }
        case 'l': {
          e.preventDefault()
          if (kHeldRef.current) {
            setIsPlaying(false)
            setShuttleSpeed(0)
            setCurrentTime(prev => Math.min(td, prev + frameDuration))
          } else {
            setShuttleSpeed(prev => {
              if (prev < 0) return 1
              const idx = FORWARD_SPEEDS.indexOf(prev)
              const nextIdx = idx >= 0 ? Math.min(idx + 1, FORWARD_SPEEDS.length - 1) : 0
              return FORWARD_SPEEDS[nextIdx]
            })
            setIsPlaying(true)
          }
          break
        }
        
        case 'h': {
          if (!kHeldRef.current) setActiveTool('hand')
          break
        }
        
        // Arrow keys: frame-by-frame navigation (Shift = 1 second jump)
        case 'arrowleft': {
          e.preventDefault()
          const step = e.shiftKey ? 1 : frameDuration
          setCurrentTime(prev => Math.max(0, prev - step))
          break
        }
        case 'arrowright': {
          e.preventDefault()
          const { totalDuration: dur } = keyboardStateRef.current
          const step = e.shiftKey ? 1 : frameDuration
          setCurrentTime(prev => Math.min(dur, prev + step))
          break
        }
        
        // Home / End: jump to beginning / end of sequence
        case 'home': {
          e.preventDefault()
          setCurrentTime(0)
          setIsPlaying(false)
          setShuttleSpeed(0)
          break
        }
        case 'end': {
          e.preventDefault()
          const { totalDuration: dur } = keyboardStateRef.current
          setCurrentTime(dur)
          setIsPlaying(false)
          setShuttleSpeed(0)
          break
        }
        
        // Zoom shortcuts — center view on playhead after zoom
        case '=':
        case '+': {
          e.preventDefault()
          centerOnPlayheadRef.current = true
          setZoom(prev => Math.min(4, +(prev + 0.25).toFixed(2)))
          break
        }
        case '-': {
          e.preventDefault()
          centerOnPlayheadRef.current = true
          setZoom(prev => Math.max(getMinZoomRef.current(), +(prev - 0.25).toFixed(2)))
          break
        }
        case '0': {
          // Ctrl+0 / Cmd+0 = fit timeline to view
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            fitToViewRef.current()
          }
          break
        }
      }
    }
    
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k') {
        kHeldRef.current = false
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, []) // stable - uses refs for latest state
  
  // Ctrl+scroll-wheel zoom on the timeline
  useEffect(() => {
    const container = trackContainerRef.current
    if (!container) return
    
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        centerOnPlayheadRef.current = true
        const delta = e.deltaY > 0 ? -0.15 : 0.15
        setZoom(prev => Math.min(4, Math.max(getMinZoomRef.current(), +(prev + delta).toFixed(2))))
      }
    }
    
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])
  
  // Fit-to-view helper
  const handleFitToView = useCallback(() => {
    const container = trackContainerRef.current
    if (!container || totalDuration <= 0) return
    const containerWidth = container.clientWidth - 20 // small padding
    const idealZoom = containerWidth / (totalDuration * 100)
    setZoom(Math.min(4, Math.max(getMinZoom(), +idealZoom.toFixed(2))))
  }, [totalDuration, getMinZoom])
  
  // ─── Unified playback engine (rAF) ───────────────────────────────────
  // During playback this loop is the SINGLE authority for:
  //   • advancing time (via playbackTimeRef — NOT React state every frame)
  //   • switching / seeking pool video elements (instant, no useEffect delay)
  //   • pre-seeking the NEXT clip so its first frame is already decoded
  //   • auto-scrolling the timeline
  //   • updating playhead position via direct DOM mutation
  // React state (currentTime) is synced at a throttled rate (~24 fps) for UI.
  // This eliminates the old pipeline: rAF→setState→render→useEffect→sync.
  useEffect(() => {
    if (!isPlaying) return
    
    const effectiveSpeed = shuttleSpeed !== 0 ? shuttleSpeed : 1
    let lastTimestamp: number | null = null
    let animFrameId: number
    
    // Inline helpers that read refs (no React dependency)
    const resolveClipSrcRef = (clip: TimelineClip): string => {
      if (!clip) return ''
      let src = clip.asset?.url || ''
      if (clip.assetId) {
        const liveAsset = assetsRef.current.find((a: any) => a.id === clip.assetId)
        if (liveAsset) {
          if (liveAsset.takes && liveAsset.takes.length > 0 && clip.takeIndex !== undefined) {
            const idx = Math.max(0, Math.min(clip.takeIndex, liveAsset.takes.length - 1))
            src = liveAsset.takes[idx].url
          } else {
            src = liveAsset.url
          }
        }
      }
      return src || clip.importedUrl || ''
    }
    
    const getClipAtTimeRef = (time: number): TimelineClip | null => {
      const all = clipsRef.current
      const trks = tracksRef.current
      const clipsAtTime = all
        .map((clip: TimelineClip, arrayIndex: number) => ({ clip, arrayIndex }))
        .filter(({ clip }: { clip: TimelineClip }) =>
          clip.type !== 'audio' && clip.type !== 'adjustment' &&
          (trks[clip.trackIndex]?.enabled !== false) &&
          time >= clip.startTime && time < clip.startTime + clip.duration
        )
      if (clipsAtTime.length === 0) return null
      // Higher trackIndex = higher visual track = takes priority (NLE rule)
      clipsAtTime.sort((a: any, b: any) => {
        if (a.clip.trackIndex !== b.clip.trackIndex) return b.clip.trackIndex - a.clip.trackIndex
        return b.arrayIndex - a.arrayIndex
      })
      return clipsAtTime[0].clip
    }
    
    // Find the next video clip AFTER a given clip (for pre-seeking)
    const getNextVideoClip = (afterClip: TimelineClip): TimelineClip | null => {
      const all = clipsRef.current
      const endTime = afterClip.startTime + afterClip.duration
      let best: TimelineClip | null = null
      for (const c of all) {
        if (c.type === 'audio' || c.type === 'adjustment') continue
        if (c.asset?.type !== 'video') continue
        if (c.startTime >= endTime - 0.01) {
          if (!best || c.startTime < best.startTime) best = c
        }
      }
      return best
    }
    
    const STATE_UPDATE_INTERVAL = 42 // ~24fps for React state updates
    lastStateUpdateRef.current = 0
    
    const tick = (timestamp: number) => {
      if (lastTimestamp === null) {
        lastTimestamp = timestamp
        lastStateUpdateRef.current = timestamp
        animFrameId = requestAnimationFrame(tick)
        return
      }
      
      const deltaMs = timestamp - lastTimestamp
      lastTimestamp = timestamp
      const deltaSec = (deltaMs / 1000) * effectiveSpeed
      
      // ── 1. Advance time ──
      let next = playbackTimeRef.current + deltaSec
      let stopped = false
      
      // In/Out loop
      if (playingInOut && inPoint !== null && outPoint !== null) {
        const loopStart = Math.min(inPoint, outPoint)
        const loopEnd = Math.max(inPoint, outPoint)
        if (next >= loopEnd) next = loopStart
        else if (next <= loopStart) next = loopEnd
      } else {
        if (next >= totalDuration) { next = 0; stopped = true }
        else if (next <= 0) { next = 0; stopped = true }
      }
      
      playbackTimeRef.current = next
      
      if (stopped) {
        setIsPlaying(false)
        setShuttleSpeed(0)
        setCurrentTime(next)
        return // don't schedule next frame
      }
      
      // ── 2. Find active clip & sync video directly ──
      const pool = videoPoolRef.current
      const syncClip = getClipAtTimeRef(next)
      
      if (syncClip && syncClip.asset?.type === 'video') {
        const clipSrc = resolveClipSrcRef(syncClip)
        if (clipSrc) {
          let video = pool.get(clipSrc)
          
          // Ensure video is in the DOM
          if (video) {
            const container = document.getElementById('video-pool-container')
            if (container && !video.parentElement) container.appendChild(video)
          }
          
          // Switch visibility instantly if clip source changed
          if (clipSrc !== activePoolSrcRef.current) {
            const oldVid = pool.get(activePoolSrcRef.current)
            if (oldVid) {
              oldVid.style.opacity = '0'
              oldVid.style.zIndex = '0'
              oldVid.pause()
            }
            if (video) {
              video.style.opacity = '1'
              video.style.zIndex = '1'
            }
            activePoolSrcRef.current = clipSrc
            preSeekDoneRef.current = null // reset pre-seek tracker on clip change
          }
          
          // Seek / play the video
          if (video) {
            const seekAndPlay = (v: HTMLVideoElement) => {
              const timeInClip = next - syncClip.startTime
              const videoDuration = v.duration
              if (!isNaN(videoDuration)) {
                const usableMedia = videoDuration - syncClip.trimStart - syncClip.trimEnd
                const targetTime = syncClip.reversed
                  ? Math.max(0, Math.min(videoDuration, syncClip.trimStart + usableMedia - timeInClip * syncClip.speed))
                  : Math.max(0, Math.min(videoDuration, syncClip.trimStart + timeInClip * syncClip.speed))
                
                if (syncClip.reversed) {
                  if (!v.paused) v.pause()
                  v.playbackRate = 1
                  if (!isNaN(targetTime) && Math.abs(v.currentTime - targetTime) > 0.04) {
                    if (typeof (v as any).fastSeek === 'function') (v as any).fastSeek(targetTime)
                    else v.currentTime = targetTime
                  }
                } else {
                  v.playbackRate = syncClip.speed
                  if (!isNaN(targetTime) && Math.abs(v.currentTime - targetTime) > 0.3) {
                    if (typeof (v as any).fastSeek === 'function') (v as any).fastSeek(targetTime)
                    else v.currentTime = targetTime
                  }
                  if (v.paused) v.play().catch(() => {})
                }
                
                v.muted = syncClip.muted || tracksRef.current[syncClip.trackIndex]?.muted || false
                v.volume = syncClip.volume
              }
            }
            
            if (video.readyState >= 2) {
              seekAndPlay(video)
            } else if (!(video as any).__pendingCanplay) {
              // Video not decoded yet — seek & play as soon as it's ready (one listener only)
              (video as any).__pendingCanplay = true
              const onReady = () => {
                video.removeEventListener('canplay', onReady)
                ;(video as any).__pendingCanplay = false
                video.style.opacity = '1'
                video.style.zIndex = '1'
                seekAndPlay(video)
              }
              video.addEventListener('canplay', onReady)
            }
          }
          
          // Update previewVideoRef for other code that reads it
          ;(previewVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = video || null
          
          // ── 3. Pre-seek the NEXT clip so its first frame is decoded ──
          const nextClip = getNextVideoClip(syncClip)
          if (nextClip && nextClip.id !== preSeekDoneRef.current) {
            const remainingInCurrent = (syncClip.startTime + syncClip.duration) - next
            if (remainingInCurrent < 1.5 && remainingInCurrent > 0) {
              const nextSrc = resolveClipSrcRef(nextClip)
              const nextVideo = nextSrc ? pool.get(nextSrc) : null
              if (nextVideo && nextVideo.readyState >= 1) {
                const nextTargetTime = nextClip.reversed
                  ? nextClip.trimStart + (nextVideo.duration || 0) - nextClip.trimStart - nextClip.trimEnd
                  : nextClip.trimStart
                if (!isNaN(nextTargetTime)) {
                  if (typeof (nextVideo as any).fastSeek === 'function') (nextVideo as any).fastSeek(nextTargetTime)
                  else nextVideo.currentTime = nextTargetTime
                }
                preSeekDoneRef.current = nextClip.id
              }
            }
          }
        }
      } else if (!syncClip || syncClip?.asset?.type !== 'video') {
        // No video clip at this time — pause current pool video (keep last frame)
        const curVid = pool.get(activePoolSrcRef.current)
        if (curVid && !curVid.paused) curVid.pause()
      }
      
      // ── 4. Direct DOM updates for playhead (no React re-render) ──
      const pps = zoom * 100 // pixelsPerSecond
      const px = `${next * pps}px`
      if (playheadRulerRef.current) playheadRulerRef.current.style.left = px
      // Update the overlay playhead (scroll-adjusted, positioned on the wrapper)
      if (playheadOverlayRef.current) {
        const scrollX = trackContainerRef.current?.scrollLeft || 0
        playheadOverlayRef.current.style.left = `${next * pps - scrollX}px`
      }
      
      // ── 5. Auto-scroll timeline ──
      const container = trackContainerRef.current
      if (container) {
        const playheadX = next * pps
        const { scrollLeft, clientWidth } = container
        const margin = 80
        if (playheadX > scrollLeft + clientWidth - margin) {
          container.scrollLeft = playheadX - clientWidth + margin
        } else if (playheadX < scrollLeft + margin) {
          container.scrollLeft = Math.max(0, playheadX - margin)
        }
        if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = container.scrollLeft
      }
      
      // ── 6. Throttled React state sync for UI (~24fps) ──
      if (timestamp - lastStateUpdateRef.current >= STATE_UPDATE_INTERVAL) {
        lastStateUpdateRef.current = timestamp
        setCurrentTime(next)
      }
      
      animFrameId = requestAnimationFrame(tick)
    }
    
    animFrameId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(animFrameId)
      // Final sync: push authoritative time to React state
      setCurrentTime(playbackTimeRef.current)
    }
  }, [isPlaying, totalDuration, shuttleSpeed, playingInOut, inPoint, outPoint, zoom])
  
  // Clear In/Out loop mode when playback stops
  useEffect(() => {
    if (!isPlaying && playingInOut) {
      setPlayingInOut(false)
    }
  }, [isPlaying, playingInOut])
  
  // Auto-scroll timeline to keep playhead visible during playback
  // NOTE: During playback the rAF engine handles auto-scroll directly (faster).
  // This effect only handles non-playing scrub/seek scenarios.
  useEffect(() => {
    if (isPlaying) return // rAF engine handles this
    const container = trackContainerRef.current
    if (!container) return
    
    // no-op when not scrubbing (avoid jittery scroll when idle)
  }, [isPlaying, currentTime, pixelsPerSecond])
  
  // Center view on playhead after zoom change (triggered by +/- keys)
  useEffect(() => {
    if (!centerOnPlayheadRef.current) return
    centerOnPlayheadRef.current = false
    
    const container = trackContainerRef.current
    if (!container) return
    
    const playheadX = currentTime * pixelsPerSecond
    const centerScroll = playheadX - container.clientWidth / 2
    container.scrollLeft = Math.max(0, centerScroll)
    
    // Sync ruler
    if (rulerScrollRef.current) {
      rulerScrollRef.current.scrollLeft = container.scrollLeft
    }
  }, [pixelsPerSecond, currentTime])
  
  // Helper: resolve the playback URL for a clip (inline, safe to call in effects)
  const resolveClipSrc = useCallback((clip: TimelineClip | null): string => {
    if (!clip) return ''
    let src = clip.asset?.url || ''
    if (clip.assetId) {
      const liveAsset = assets.find(a => a.id === clip.assetId)
      if (liveAsset) {
        if (liveAsset.takes && liveAsset.takes.length > 0 && clip.takeIndex !== undefined) {
          const idx = Math.max(0, Math.min(clip.takeIndex, liveAsset.takes.length - 1))
          src = liveAsset.takes[idx].url
        } else {
          src = liveAsset.url
        }
      }
    }
    return src || clip.importedUrl || ''
  }, [assets])
  
  // --- Video pool management for gapless playback ---
  // Collect all unique video source URLs used in the timeline
  const timelineVideoSources = useMemo(() => {
    const srcSet = new Set<string>()
    for (const clip of clips) {
      if (clip.type === 'audio' || clip.asset?.type !== 'video') continue
      const src = resolveClipSrc(clip)
      if (src) srcSet.add(src)
    }
    return srcSet
  }, [clips, resolveClipSrc])
  
  // Maintain the video pool: create/remove <video> elements as sources change
  // Eagerly attach ALL pool videos to the DOM so they begin buffering immediately.
  useEffect(() => {
    const pool = videoPoolRef.current
    const container = document.getElementById('video-pool-container')
    
    // Add new sources
    for (const src of timelineVideoSources) {
      if (!pool.has(src)) {
        const video = document.createElement('video')
        video.preload = 'auto'
        video.playsInline = true
        video.muted = true // will be unmuted when active
        video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;z-index:0;pointer-events:none;'
        video.src = src
        video.load()
        pool.set(src, video)
        // Eagerly attach to DOM so the browser starts decoding
        if (container) container.appendChild(video)
      }
    }
    
    // Remove sources no longer in timeline (keep pool clean)
    for (const [src, video] of pool) {
      if (!timelineVideoSources.has(src)) {
        video.pause()
        video.removeAttribute('src')
        video.load()
        if (video.parentElement) video.parentElement.removeChild(video)
        pool.delete(src)
      }
    }
  }, [timelineVideoSources])
  
  // Apply playback resolution to pool video elements
  // CSS trick: shrink the video element's rendered size so the browser decodes at lower res
  useEffect(() => {
    const pool = videoPoolRef.current
    for (const [, video] of pool) {
      if (playbackResolution < 1) {
        // Scale the video element down, then scale the container up via CSS transform
        // This reduces actual pixel decode work
        video.style.width = `${playbackResolution * 100}%`
        video.style.height = `${playbackResolution * 100}%`
        video.style.transform = `scale(${1 / playbackResolution})`
        video.style.transformOrigin = 'top left'
      } else {
        video.style.width = '100%'
        video.style.height = '100%'
        video.style.transform = ''
        video.style.transformOrigin = ''
      }
    }
  }, [playbackResolution, timelineVideoSources]) // re-apply when pool changes
  
  // Cleanup pool on unmount
  useEffect(() => {
    return () => {
      for (const [, video] of videoPoolRef.current) {
        video.pause()
        video.removeAttribute('src')
        video.load()
        if (video.parentElement) video.parentElement.removeChild(video)
      }
      videoPoolRef.current.clear()
    }
  }, [])
  
  // Sync preview video with timeline using the video pool
  // NOTE: During playback the rAF engine handles video sync directly for zero-latency.
  // This useEffect only runs when NOT playing (scrubbing, seeking, clip changes).
  useEffect(() => {
    if (isPlaying) return // rAF engine handles sync during playback
    
    const pool = videoPoolRef.current
    
    // Determine which clip to sync
    const syncClip = crossDissolveState ? crossDissolveState.incoming : activeClip
    if (!syncClip || syncClip.asset?.type !== 'video') {
      // No video clip — pause the current pool video but keep last frame
      const curVid = pool.get(activePoolSrcRef.current)
      if (curVid && !curVid.paused) curVid.pause()
      return
    }
    
    const clipSrc = resolveClipSrc(syncClip)
    if (!clipSrc) return
    
    // Get or create the video element for this source
    let video = pool.get(clipSrc)
    if (!video) {
      video = document.createElement('video')
      video.preload = 'auto'
      video.playsInline = true
      video.muted = true
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;z-index:0;'
      video.src = clipSrc
      video.load()
      pool.set(clipSrc, video)
    }
    
    // Attach to the container if not already
    const container = document.getElementById('video-pool-container')
    if (container && !video.parentElement) {
      container.appendChild(video)
    }
    
    // Switch visibility: hide previous, show current
    if (clipSrc !== activePoolSrcRef.current) {
      const oldVid = pool.get(activePoolSrcRef.current)
      if (oldVid) {
        oldVid.style.opacity = '0'
        oldVid.style.zIndex = '0'
        oldVid.pause()
      }
      video.style.opacity = '1'
      video.style.zIndex = '1'
      activePoolSrcRef.current = clipSrc
    }
    
    ;(previewVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = video
    
    const timeInClip = currentTime - syncClip.startTime
    
    const syncVideo = () => {
      if (!video || !video.duration || isNaN(video.duration)) return
      
      const videoDuration = video.duration
      const usableMediaDuration = videoDuration - syncClip.trimStart - syncClip.trimEnd
      
      const targetTime = syncClip.reversed 
        ? Math.max(0, Math.min(videoDuration, syncClip.trimStart + usableMediaDuration - timeInClip * syncClip.speed))
        : Math.max(0, Math.min(videoDuration, syncClip.trimStart + timeInClip * syncClip.speed))
      
      if (syncClip.reversed || crossDissolveState) {
        if (!video.paused) video.pause()
        video.playbackRate = 1
        if (!isNaN(targetTime) && Math.abs(video.currentTime - targetTime) > 0.04) {
          video.currentTime = targetTime
        }
      } else {
        video.playbackRate = syncClip.speed
        if (!isNaN(targetTime) && Math.abs(video.currentTime - targetTime) > 0.3) {
          video.currentTime = targetTime
        }
        if (!video.paused) video.pause()
      }
      
      video.muted = syncClip.muted || tracks[syncClip.trackIndex]?.muted || false
      video.volume = syncClip.volume
    }
    
    if (video.readyState >= 2) {
      syncVideo()
    } else {
      video.addEventListener('loadeddata', syncVideo, { once: true })
      if (container) {
        for (const [, v] of pool) {
          if (!v.parentElement) container.appendChild(v)
        }
      }
    }
    
    return () => {
      video?.removeEventListener('loadeddata', syncVideo)
    }
  }, [currentTime, isPlaying, activeClip, crossDissolveState, tracks, resolveClipSrc])
  
  // Sync dissolve outgoing video with timeline
  useEffect(() => {
    const video = dissolveOutVideoRef.current
    if (!video || !crossDissolveState) return
    
    const { outgoing } = crossDissolveState
    if (outgoing.asset?.type !== 'video') return
    
    const syncOutgoing = () => {
      if (!video.duration || isNaN(video.duration)) return
      
      const outOffset = currentTime - outgoing.startTime
      const videoDuration = video.duration
      const usableMedia = videoDuration - outgoing.trimStart - outgoing.trimEnd
      
      const targetTime = outgoing.reversed
        ? Math.max(0, Math.min(videoDuration, outgoing.trimStart + usableMedia - outOffset * outgoing.speed))
        : Math.max(0, Math.min(videoDuration, outgoing.trimStart + outOffset * outgoing.speed))
      
      // Always keep paused and seek manually for frame-accurate dissolve
      if (!video.paused) video.pause()
      if (!isNaN(targetTime) && Math.abs(video.currentTime - targetTime) > 0.04) {
        video.currentTime = targetTime
      }
      video.muted = true
    }
    
    if (video.readyState >= 2) {
      syncOutgoing()
    } else {
      video.addEventListener('loadeddata', syncOutgoing, { once: true })
    }
    
    return () => {
      video.removeEventListener('loadeddata', syncOutgoing)
    }
  }, [currentTime, crossDissolveState])
  
  // Sync audio for ALL layers: audio clips + video clips that aren't the active preview
  // The activeClip's audio is handled by previewVideoRef. All other clips with audio need
  // hidden <audio> elements so their sound plays simultaneously.
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  
  useEffect(() => {
    // Determine which clip is being previewed visually (its audio is handled by the <video> element)
    const previewedClipId = crossDissolveState
      ? crossDissolveState.incoming.id
      : activeClip?.id
    
    // Helper to get the live URL for a clip (from project context, respecting takes)
    const getAudioClipUrl = (clip: TimelineClip): string | null => {
      if (clip.assetId) {
        const liveAsset = assets.find(a => a.id === clip.assetId)
        if (liveAsset) {
          if (liveAsset.takes && liveAsset.takes.length > 0 && clip.takeIndex !== undefined) {
            const idx = Math.max(0, Math.min(clip.takeIndex, liveAsset.takes.length - 1))
            return liveAsset.takes[idx].url
          }
          return liveAsset.url
        }
      }
      return clip.asset?.url || clip.importedUrl || null
    }
    
    // Collect all clips that should produce audio via hidden elements:
    // 1. Audio-type clips at the playhead
    // 2. Video-type clips at the playhead that are NOT the active preview clip
    const audioSourceClips = clips.filter(c => {
      const url = getAudioClipUrl(c)
      return url &&
        currentTime >= c.startTime &&
        currentTime < c.startTime + c.duration &&
        (
          c.type === 'audio' ||
          ((c.asset?.type === 'video' || c.type === 'video') && c.id !== previewedClipId)
        )
    })
    
    const activeAudioIds = new Set(audioSourceClips.map(c => c.id))
    
    // Remove audio elements for clips no longer active
    for (const [id, el] of audioElementsRef.current) {
      if (!activeAudioIds.has(id)) {
        el.pause()
        el.src = ''
        audioElementsRef.current.delete(id)
      }
    }
    
    // Sync active audio clips
    for (const clip of audioSourceClips) {
      const clipUrl = getAudioClipUrl(clip)!
      let el = audioElementsRef.current.get(clip.id)
      
      if (!el) {
        el = document.createElement('audio')
        el.src = clipUrl
        el.preload = 'auto'
        audioElementsRef.current.set(clip.id, el)
      } else if (el.src !== clipUrl && clipUrl) {
        // URL changed (e.g. take switch or asset update) — update source
        el.src = clipUrl
      }
      
      const liveAsset = clip.assetId ? assets.find(a => a.id === clip.assetId) : null
      const assetDuration = liveAsset?.duration || clip.asset?.duration || clip.duration
      const timeInClip = currentTime - clip.startTime
      const targetTime = clip.reversed
        ? Math.max(0, assetDuration - clip.trimEnd - timeInClip * clip.speed)
        : Math.max(0, clip.trimStart + timeInClip * clip.speed)
      
      el.muted = clip.muted || tracks[clip.trackIndex]?.muted || false
      el.volume = clip.volume
      el.playbackRate = clip.reversed ? 1 : clip.speed
      
      if (el.readyState >= 2) {
        if (Math.abs(el.currentTime - targetTime) > 0.3) {
          el.currentTime = targetTime
        }
        
        if (isPlaying && !clip.reversed) {
          if (el.paused) el.play().catch(() => {})
        } else {
          if (!el.paused) el.pause()
          if (Math.abs(el.currentTime - targetTime) > 0.05) {
            el.currentTime = targetTime
          }
        }
      }
    }
    
    // Pause all when not playing
    if (!isPlaying) {
      for (const [, el] of audioElementsRef.current) {
        if (!el.paused) el.pause()
      }
    }
  }, [currentTime, isPlaying, clips, tracks, activeClip, crossDissolveState, assets])
  
  // Clean up all audio elements on unmount
  useEffect(() => {
    return () => {
      for (const [, el] of audioElementsRef.current) {
        el.pause()
        el.src = ''
      }
      audioElementsRef.current.clear()
    }
  }, [])
  
  // --- Clip/Track operations ---
  
  const addClipToTimeline = (asset: Asset, trackIndex: number = 0, startTime?: number) => {
    const track = tracks[trackIndex]
    if (!track || track.locked) return
    
    let clipStartTime = startTime
    if (clipStartTime === undefined) {
      const trackClips = clips.filter(c => c.trackIndex === trackIndex)
      clipStartTime = trackClips.reduce((max, clip) => 
        Math.max(max, clip.startTime + clip.duration), 0
      )
    }
    
    const isAdjustment = asset.type === 'adjustment'
    const newClip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      assetId: asset.id,
      type: isAdjustment ? 'adjustment' : asset.type === 'video' ? 'video' : asset.type === 'audio' ? 'audio' : 'image',
      startTime: clipStartTime,
      duration: asset.duration || (isAdjustment ? 10 : 5),
      trimStart: 0,
      trimEnd: 0,
      speed: 1,
      reversed: false,
      muted: false,
      volume: 1,
      trackIndex,
      asset,
      flipH: false,
      flipV: false,
      transitionIn: { type: 'none', duration: isAdjustment ? 0 : 0.5 },
      transitionOut: { type: 'none', duration: isAdjustment ? 0 : 0.5 },
      colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
      opacity: 100,
      ...(isAdjustment ? { letterbox: { ...DEFAULT_LETTERBOX } } : {}),
    }
    setClips(prev => resolveOverlaps([...prev, newClip], new Set([newClip.id])))
  }
  
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || !currentProjectId) return
    
    for (const file of Array.from(files)) {
      const isVideo = file.type.startsWith('video/')
      const isAudio = file.type.startsWith('audio/')
      const isImage = file.type.startsWith('image/')
      
      if (!isVideo && !isAudio && !isImage) continue
      
      // In Electron, File objects have a .path property with the full filesystem path
      const electronFilePath = (file as any).path as string | undefined
      
      let persistentUrl: string
      let persistentPath: string
      
      if (electronFilePath && window.electronAPI?.importFileToStorage) {
        // Copy file to persistent storage so it survives app restarts
        const result = await window.electronAPI.importFileToStorage(electronFilePath, file.name)
        if (result.success && result.url && result.path) {
          persistentUrl = result.url
          persistentPath = result.path
        } else {
          // Fallback to blob URL if copy fails
          console.warn('Failed to copy imported file to storage:', result.error)
          persistentUrl = URL.createObjectURL(file)
          persistentPath = file.name
        }
      } else {
        // Non-Electron environment: use blob URL
        persistentUrl = URL.createObjectURL(file)
        persistentPath = file.name
      }
      
      let duration = 5
      if (isVideo || isAudio) {
        duration = await getMediaDuration(persistentUrl, isAudio)
      }
      
      addAsset(currentProjectId, {
        type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
        path: persistentPath,
        url: persistentUrl,
        prompt: `Imported: ${file.name}`,
        resolution: 'imported',
        duration,
      })
    }
    
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }
  
  const getMediaDuration = (url: string, isAudio = false): Promise<number> => {
    return new Promise((resolve) => {
      const media = document.createElement(isAudio ? 'audio' : 'video')
      media.src = url
      media.onloadedmetadata = () => resolve(media.duration)
      media.onerror = () => resolve(5)
    })
  }
  
  // --- Undo/Redo helpers ---
  const pushUndo = useCallback((currentClips?: TimelineClip[]) => {
    const snapshot = currentClips || clips
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), { type: 'clips', clips: snapshot.map(c => ({ ...c })) }]
    redoStackRef.current = [] // clear redo on new action
  }, [clips])
  
  const pushAssetUndo = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), { type: 'assets', assets: assets.map(a => ({ ...a })) }]
    redoStackRef.current = []
  }, [assets])
  
  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return
    const action = undoStackRef.current.pop()!
    if (action.type === 'clips') {
      redoStackRef.current.push({ type: 'clips', clips: clips.map(c => ({ ...c })) })
      skipHistoryRef.current = true
      setClips(action.clips)
      skipHistoryRef.current = false
    } else if (action.type === 'assets' && currentProjectId) {
      redoStackRef.current.push({ type: 'assets', assets: assets.map(a => ({ ...a })) })
      // Restore assets by updating each one or replacing the whole array
      // We use a bulk approach: set all assets at once via updateProject-style
      // Since ProjectContext doesn't have a "setAssets" bulk method, we'll do it via individual updates
      // But that's inefficient. Instead, let's use a direct approach:
      const prevAssets = action.assets
      // Remove assets that don't exist in the snapshot
      const prevIds = new Set(prevAssets.map(a => a.id))
      const currentIds = new Set(assets.map(a => a.id))
      // Delete assets not in prev
      assets.filter(a => !prevIds.has(a.id)).forEach(a => deleteAsset(currentProjectId, a.id))
      // Add assets that are in prev but not current
      prevAssets.filter(a => !currentIds.has(a.id)).forEach(a => {
        addAsset(currentProjectId, { ...a })
      })
      // Update assets that exist in both
      prevAssets.filter(a => currentIds.has(a.id)).forEach(a => {
        updateAsset(currentProjectId, a.id, a)
      })
    }
  }, [clips, assets, currentProjectId, deleteAsset, addAsset, updateAsset])
  
  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return
    const action = redoStackRef.current.pop()!
    if (action.type === 'clips') {
      undoStackRef.current.push({ type: 'clips', clips: clips.map(c => ({ ...c })) })
      skipHistoryRef.current = true
      setClips(action.clips)
      skipHistoryRef.current = false
    } else if (action.type === 'assets' && currentProjectId) {
      undoStackRef.current.push({ type: 'assets', assets: assets.map(a => ({ ...a })) })
      const nextAssets = action.assets
      const nextIds = new Set(nextAssets.map(a => a.id))
      const currentIds = new Set(assets.map(a => a.id))
      assets.filter(a => !nextIds.has(a.id)).forEach(a => deleteAsset(currentProjectId, a.id))
      nextAssets.filter(a => !currentIds.has(a.id)).forEach(a => {
        addAsset(currentProjectId, { ...a })
      })
      nextAssets.filter(a => currentIds.has(a.id)).forEach(a => {
        updateAsset(currentProjectId, a.id, a)
      })
    }
  }, [clips, assets, currentProjectId, deleteAsset, addAsset, updateAsset])
  
  // --- Copy / Paste ---
  const handleCopy = useCallback(() => {
    if (selectedClipIds.size === 0) return
    clipboardRef.current = clips.filter(c => selectedClipIds.has(c.id)).map(c => ({ ...c }))
  }, [clips, selectedClipIds])
  
  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return
    pushUndo()
    // Paste at playhead, offset relative to the earliest clipboard clip
    const earliest = clipboardRef.current.reduce((min, c) => Math.min(min, c.startTime), Infinity)
    const newClips = clipboardRef.current.map(c => ({
      ...c,
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      startTime: currentTime + (c.startTime - earliest),
    }))
    setClips(prev => [...prev, ...newClips])
    setSelectedClipIds(new Set(newClips.map(c => c.id)))
  }, [currentTime, pushUndo])
  
  const handleCut = useCallback(() => {
    if (selectedClipIds.size === 0) return
    handleCopy()
    pushUndo()
    setClips(prev => prev.filter(c => !selectedClipIds.has(c.id)))
    setSelectedClipIds(new Set())
  }, [selectedClipIds, handleCopy, pushUndo])
  
  // Keep keyboard refs in sync
  undoRef.current = handleUndo
  redoRef.current = handleRedo
  copyRef.current = handleCopy
  pasteRef.current = handlePaste
  cutRef.current = handleCut
  pushUndoRef.current = pushUndo
  pushAssetUndoRef.current = pushAssetUndo
  fitToViewRef.current = handleFitToView
  
  const updateClip = (clipId: string, updates: Partial<TimelineClip>) => {
    pushUndo()
    setClips(clips.map(c => c.id === clipId ? { ...c, ...updates } : c))
  }
  
  const duplicateClip = (clipId: string) => {
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return
    pushUndo()
    
    const newClip: TimelineClip = {
      ...clip,
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      startTime: clip.startTime + clip.duration,
    }
    setClips([...clips, newClip])
  }
  
  const splitClipAtPlayhead = (clipId: string) => {
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return
    
    const splitPoint = currentTime - clip.startTime
    if (splitPoint <= 0.1 || splitPoint >= clip.duration - 0.1) return
    pushUndo()
    
    const firstHalf: TimelineClip = {
      ...clip,
      duration: splitPoint,
      trimEnd: clip.trimEnd + (clip.duration - splitPoint),
    }
    
    const secondHalf: TimelineClip = {
      ...clip,
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      startTime: clip.startTime + splitPoint,
      duration: clip.duration - splitPoint,
      trimStart: clip.trimStart + splitPoint,
    }
    
    setClips(clips.map(c => c.id === clipId ? firstHalf : c).concat(secondHalf))
  }
  
  const removeClip = (clipId: string) => {
    pushUndo()
    setClips(clips.filter(c => c.id !== clipId))
    setSelectedClipIds(prev => {
      const next = new Set(prev)
      next.delete(clipId)
      return next
    })
  }
  
  // --- Cross-dissolve at cut points ---
  const addCrossDissolve = useCallback((leftClipId: string, rightClipId: string) => {
    const leftClip = clips.find(c => c.id === leftClipId)
    const rightClip = clips.find(c => c.id === rightClipId)
    if (!leftClip || !rightClip) return
    
    pushUndo()
    const dissolveDur = DEFAULT_DISSOLVE_DURATION
    
    // Set transition out on left clip and transition in on right clip
    setClips(prev => prev.map(c => {
      if (c.id === leftClipId) {
        return { ...c, transitionOut: { type: 'dissolve' as TransitionType, duration: dissolveDur } }
      }
      if (c.id === rightClipId) {
        return { ...c, transitionIn: { type: 'dissolve' as TransitionType, duration: dissolveDur } }
      }
      return c
    }))
    setHoveredCutPoint(null)
  }, [clips, pushUndo])
  
  const removeCrossDissolve = useCallback((leftClipId: string, rightClipId: string) => {
    pushUndo()
    setClips(prev => prev.map(c => {
      if (c.id === leftClipId) {
        return { ...c, transitionOut: { type: 'none' as TransitionType, duration: 0.5 } }
      }
      if (c.id === rightClipId) {
        return { ...c, transitionIn: { type: 'none' as TransitionType, duration: 0.5 } }
      }
      return c
    }))
    setHoveredCutPoint(null)
  }, [pushUndo])
  
  const addTrack = (kind: 'video' | 'audio' = 'video') => {
    const sameKindCount = tracks.filter(t => t.kind === kind && t.type !== 'subtitle').length
    const newTrack: Track = {
      id: `track-${Date.now()}`,
      name: kind === 'audio' ? `A${sameKindCount + 1}` : `V${sameKindCount + 1}`,
      muted: false,
      locked: false,
      kind,
    }
    setTracks([...tracks, newTrack])
  }
  
  const deleteTrack = (idx: number) => {
    if (tracks.length <= 1) return // Keep at least one track
    // Remove clips on that track and shift clips on higher tracks down
    setClips(prev => prev
      .filter(c => c.trackIndex !== idx)
      .map(c => c.trackIndex > idx ? { ...c, trackIndex: c.trackIndex - 1 } : c)
    )
    // Also shift subtitle track indices
    setSubtitles(prev => prev
      .filter(s => s.trackIndex !== idx)
      .map(s => s.trackIndex > idx ? { ...s, trackIndex: s.trackIndex - 1 } : s)
    )
    setTracks(tracks.filter((_, i) => i !== idx))
  }
  
  // --- Adjustment layer operations ---
  // Creates an adjustment layer asset in the project asset panel.
  // The user can then drag it onto any video track like any other asset.
  const createAdjustmentLayerAsset = () => {
    if (!currentProjectId) return
    const count = assets.filter(a => a.type === 'adjustment').length
    addAsset(currentProjectId, {
      type: 'adjustment',
      path: '',
      url: '',
      prompt: count > 0 ? `Adjustment Layer ${count + 1}` : 'Adjustment Layer',
      resolution: '',
      duration: 10,
    })
  }
  
  // --- Subtitle operations ---
  
  const addSubtitleTrack = () => {
    const subCount = tracks.filter(t => t.type === 'subtitle').length
    const newTrack: Track = {
      id: `track-sub-${Date.now()}`,
      name: subCount > 0 ? `Subtitles ${subCount + 1}` : 'Subtitles',
      muted: false,
      locked: false,
      type: 'subtitle',
    }
    // Insert at the top (index 0) like Premiere Pro — shift all existing indices up
    setClips(prev => prev.map(c => ({ ...c, trackIndex: c.trackIndex + 1 })))
    setSubtitles(prev => prev.map(s => ({ ...s, trackIndex: s.trackIndex + 1 })))
    setTracks([newTrack, ...tracks])
  }
  
  const addSubtitleClip = (trackIndex: number) => {
    // Default: 3-second subtitle at current playhead
    const sub: SubtitleClip = {
      id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      text: 'New subtitle',
      startTime: currentTime,
      endTime: currentTime + 3,
      trackIndex,
    }
    setSubtitles(prev => [...prev, sub])
    setSelectedSubtitleId(sub.id)
    setEditingSubtitleId(sub.id)
    setSelectedClipIds(new Set())
  }
  
  const updateSubtitle = (id: string, updates: Partial<SubtitleClip>) => {
    setSubtitles(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
  }
  
  const deleteSubtitle = (id: string) => {
    setSubtitles(prev => prev.filter(s => s.id !== id))
    if (selectedSubtitleId === id) setSelectedSubtitleId(null)
    if (editingSubtitleId === id) setEditingSubtitleId(null)
  }
  
  const handleImportSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    // Find the first subtitle track, or create one (inserted at top = index 0)
    let subtitleTrackIdx = tracks.findIndex(t => t.type === 'subtitle')
    if (subtitleTrackIdx === -1) {
      addSubtitleTrack()
      subtitleTrackIdx = 0 // addSubtitleTrack inserts at position 0
    }
    
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result as string
      if (!content) return
      const cues = parseSrt(content)
      const newSubs: SubtitleClip[] = cues.map(cue => ({
        id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${cue.index}`,
        text: cue.text,
        startTime: cue.startTime,
        endTime: cue.endTime,
        trackIndex: subtitleTrackIdx,
        ...(cue.color ? { style: { color: cue.color } } : {}),
      }))
      setSubtitles(prev => [...prev.filter(s => s.trackIndex !== subtitleTrackIdx), ...newSubs])
    }
    reader.readAsText(file)
    
    // Reset input
    if (subtitleFileInputRef.current) subtitleFileInputRef.current.value = ''
  }
  
  const handleExportSrt = () => {
    const cues = subtitles
      .filter(s => s.text.trim())
      .sort((a, b) => a.startTime - b.startTime)
    
    if (cues.length === 0) {
      alert('No subtitles to export')
      return
    }
    
    const srtContent = exportSrt(cues)
    
    // Use Electron save dialog if available
    if (window.electronAPI?.showSaveDialog) {
      window.electronAPI.showSaveDialog({
        title: 'Export Subtitles',
        defaultPath: `subtitles_${activeTimeline?.name || 'timeline'}.srt`,
        filters: [{ name: 'SRT Files', extensions: ['srt'] }]
      }).then(filePath => {
        if (filePath) {
          window.electronAPI.saveFile(filePath, srtContent)
        }
      })
    } else {
      // Fallback: download via blob
      const blob = new Blob([srtContent], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `subtitles_${activeTimeline?.name || 'timeline'}.srt`
      a.click()
      URL.revokeObjectURL(url)
    }
  }
  
  // Get active subtitle at current playhead time
  const activeSubtitles = useMemo(() => {
    return subtitles.filter(s => {
      const track = tracks[s.trackIndex]
      return track && !track.muted && currentTime >= s.startTime && currentTime < s.endTime
    })
  }, [subtitles, currentTime, tracks])
  
  // Get active letterbox from adjustment layers at playhead
  const activeLetterbox = useMemo(() => {
    // Find the topmost (lowest trackIndex) adjustment layer clip at the current time with letterbox enabled
    // Skip clips on tracks with output disabled
    const adjClips = clips
      .filter(c => c.type === 'adjustment' && (tracks[c.trackIndex]?.enabled !== false) && currentTime >= c.startTime && currentTime < c.startTime + c.duration)
      .sort((a, b) => a.trackIndex - b.trackIndex) // lower trackIndex = higher in visual stack
    
    for (const clip of adjClips) {
      if (clip.letterbox?.enabled) {
        const ratioMap: Record<string, number> = {
          '2.35:1': 2.35,
          '2.39:1': 2.39,
          '2.76:1': 2.76,
          '1.85:1': 1.85,
          '4:3': 4 / 3,
        }
        const ratio = clip.letterbox.aspectRatio === 'custom'
          ? (clip.letterbox.customRatio || 2.35)
          : (ratioMap[clip.letterbox.aspectRatio] || 2.35)
        return { ratio, color: clip.letterbox.color || '#000000', opacity: (clip.letterbox.opacity ?? 100) / 100 }
      }
    }
    return null
  }, [clips, currentTime, tracks])
  
  // --- Gap detection: find empty spaces between clips on each non-subtitle track ---
  const timelineGaps = useMemo(() => {
    const gaps: { trackIndex: number; startTime: number; endTime: number }[] = []
    
    tracks.forEach((track, trackIdx) => {
      if (track.type === 'subtitle') return
      
      // Get clips on this track, sorted by start time
      const trackClips = clips
        .filter(c => c.trackIndex === trackIdx)
        .sort((a, b) => a.startTime - b.startTime)
      
      if (trackClips.length === 0) return
      
      // Gap before first clip (only if it starts after 0)
      if (trackClips[0].startTime > 0.05) {
        gaps.push({ trackIndex: trackIdx, startTime: 0, endTime: trackClips[0].startTime })
      }
      
      // Gaps between consecutive clips
      for (let i = 0; i < trackClips.length - 1; i++) {
        const endOfCurrent = trackClips[i].startTime + trackClips[i].duration
        const startOfNext = trackClips[i + 1].startTime
        if (startOfNext - endOfCurrent > 0.05) { // Min 50ms gap to be visible
          gaps.push({ trackIndex: trackIdx, startTime: endOfCurrent, endTime: startOfNext })
        }
      }
    })
    
    return gaps
  }, [clips, tracks])
  
  // Delete gap: ripple all clips on the same track (and optionally all tracks) to close it
  const deleteGap = useCallback((gap: { trackIndex: number; startTime: number; endTime: number }) => {
    const gapDuration = gap.endTime - gap.startTime
    
    // Shift all clips that start at or after the gap end on ALL tracks to the left
    setClips(prev => prev.map(c => {
      if (c.startTime >= gap.endTime) {
        return { ...c, startTime: Math.max(0, c.startTime - gapDuration) }
      }
      return c
    }))
    
    // Also shift subtitles
    setSubtitles(prev => prev.map(s => {
      if (s.startTime >= gap.endTime) {
        return { ...s, startTime: Math.max(0, s.startTime - gapDuration), endTime: Math.max(0.1, s.endTime - gapDuration) }
      }
      return s
    }))
    
    setSelectedGap(null)
  }, [])
  
  // Handle starting generation in a gap
  const handleGapGenerate = useCallback(async () => {
    if (!selectedGap || !gapGenerateMode || !gapPrompt.trim() || !currentProjectId) return
    
    const gap = selectedGap
    const gapDuration = gap.endTime - gap.startTime
    
    // Adjust settings to match gap duration
    const settings: GenerationSettings = {
      ...gapSettings,
      duration: Math.min(Math.max(1, Math.round(gapDuration)), gapSettings.model === 'pro' ? 10 : 20),
    }
    
    try {
      if (gapGenerateMode === 'text-to-image') {
        await regenGenerateImage(gapPrompt, settings)
      } else {
        await regenGenerate(gapPrompt, gapImageFile, settings)
      }
    } catch (err) {
      console.error('Gap generation failed:', err)
    }
  }, [selectedGap, gapGenerateMode, gapPrompt, gapSettings, gapImageFile, currentProjectId, regenGenerate, regenGenerateImage])
  
  // When generation completes, place the result in the gap
  useEffect(() => {
    if (!selectedGap || !gapGenerateMode || isRegenerating) return
    
    const url = gapGenerateMode === 'text-to-image' ? regenImageUrl : regenVideoUrl
    const path = regenVideoPath
    if (!url || !currentProjectId) return
    
    const gap = selectedGap
    const gapDuration = gap.endTime - gap.startTime
    const type = gapGenerateMode === 'text-to-image' ? 'image' : 'video'
    
    // Create asset with generationParams so the regenerate button appears
    const asset = addAsset(currentProjectId, {
      type: type as 'image' | 'video',
      path: path || url,
      url,
      prompt: gapPrompt,
      resolution: gapSettings.resolution,
      duration: type === 'video' ? gapDuration : undefined,
      generationParams: {
        mode: gapGenerateMode as 'text-to-video' | 'image-to-video' | 'text-to-image',
        prompt: gapPrompt,
        model: gapSettings.model,
        duration: Math.min(Math.max(1, Math.round(gapDuration)), gapSettings.model === 'pro' ? 10 : 20),
        resolution: gapSettings.resolution,
        fps: gapSettings.fps,
        audio: gapSettings.audio,
        cameraMotion: gapSettings.cameraMotion,
        imageAspectRatio: gapSettings.imageAspectRatio,
        imageSteps: gapSettings.imageSteps,
      },
      takes: [{
        url,
        path: path || url,
        createdAt: Date.now(),
      }],
      activeTakeIndex: 0,
    })
    
    // Create clip that fits the gap
    const newClip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      assetId: asset.id,
      type: type === 'image' ? 'image' : 'video',
      startTime: gap.startTime,
      duration: gapDuration,
      trimStart: 0,
      trimEnd: 0,
      speed: 1,
      reversed: false,
      muted: false,
      volume: 1,
      trackIndex: gap.trackIndex,
      asset,
      flipH: false,
      flipV: false,
      transitionIn: { type: 'none', duration: 0 },
      transitionOut: { type: 'none', duration: 0 },
      colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
      opacity: 100,
    }
    
    setClips(prev => [...prev, newClip])
    
    // Clean up
    setSelectedGap(null)
    setGapGenerateMode(null)
    setGapPrompt('')
    setGapImageFile(null)
    regenReset()
    
  }, [regenVideoUrl, regenImageUrl, isRegenerating])
  
  // --- Gap context-aware prompt suggestion via Gemini ---
  // When the gap generation modal opens, extract frames from neighboring clips and ask Gemini for a prompt
  useEffect(() => {
    if (!selectedGap || !gapGenerateMode) {
      // Modal closed — reset suggestion state
      setGapSuggesting(false)
      setGapSuggestion(null)
      setGapBeforeFrame(null)
      setGapAfterFrame(null)
      gapSuggestionAbortRef.current?.abort()
      return
    }
    
    // Only suggest if the prompt is still empty (don't overwrite user input)
    if (gapPrompt.trim()) return
    
    const abortController = new AbortController()
    gapSuggestionAbortRef.current = abortController
    
    const suggest = async () => {
      try {
        setGapSuggesting(true)
        setGapSuggestion(null)
        
        const { extractFrameAsBase64, extractImageAsBase64 } = await import('../lib/thumbnails')
        
        const gap = selectedGap
        const trackClips = clips
          .filter(c => c.trackIndex === gap.trackIndex && c.type !== 'audio')
          .sort((a, b) => a.startTime - b.startTime)
        
        // Find clip immediately before the gap
        const clipBefore = trackClips.find(c => {
          const clipEnd = c.startTime + c.duration
          return Math.abs(clipEnd - gap.startTime) < 0.05
        })
        
        // Find clip immediately after the gap
        const clipAfter = trackClips.find(c => {
          return Math.abs(c.startTime - gap.endTime) < 0.05
        })
        
        if (!clipBefore && !clipAfter) {
          setGapSuggesting(false)
          return
        }
        
        // Extract frames and prompts in parallel
        let beforeFrame = ''
        let afterFrame = ''
        let beforePrompt = ''
        let afterPrompt = ''
        
        const framePromises: Promise<void>[] = []
        
        if (clipBefore) {
          const clipSrc = resolveClipSrc(clipBefore)
          beforePrompt = clipBefore.asset?.prompt || ''
          if (clipSrc) {
            if (clipBefore.asset?.type === 'video') {
              // Last frame: seek to near the end of the usable portion
              const seekTime = clipBefore.trimStart + clipBefore.duration * clipBefore.speed - 0.1
              framePromises.push(
                extractFrameAsBase64(clipSrc, Math.max(0, seekTime))
                  .then(b64 => { beforeFrame = b64 })
                  .catch(() => {}) // non-critical
              )
            } else if (clipBefore.asset?.type === 'image') {
              framePromises.push(
                extractImageAsBase64(clipSrc)
                  .then(b64 => { beforeFrame = b64 })
                  .catch(() => {})
              )
            }
          }
        }
        
        if (clipAfter) {
          const clipSrc = resolveClipSrc(clipAfter)
          afterPrompt = clipAfter.asset?.prompt || ''
          if (clipSrc) {
            if (clipAfter.asset?.type === 'video') {
              // First frame: seek to the trim start
              framePromises.push(
                extractFrameAsBase64(clipSrc, clipAfter.trimStart + 0.1)
                  .then(b64 => { afterFrame = b64 })
                  .catch(() => {})
              )
            } else if (clipAfter.asset?.type === 'image') {
              framePromises.push(
                extractImageAsBase64(clipSrc)
                  .then(b64 => { afterFrame = b64 })
                  .catch(() => {})
              )
            }
          }
        }
        
        await Promise.all(framePromises)
        
        if (abortController.signal.aborted) return
        
        // Save extracted frames for the animation header
        if (beforeFrame) setGapBeforeFrame(beforeFrame.startsWith('data:') ? beforeFrame : `data:image/jpeg;base64,${beforeFrame}`)
        if (afterFrame) setGapAfterFrame(afterFrame.startsWith('data:') ? afterFrame : `data:image/jpeg;base64,${afterFrame}`)
        
        // If we have nothing useful, bail
        if (!beforeFrame && !afterFrame && !beforePrompt && !afterPrompt) {
          setGapSuggesting(false)
          return
        }
        
        // Call backend
        const backendUrl = await window.electronAPI.getBackendUrl()
        const response = await fetch(`${backendUrl}/api/suggest-gap-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gapDuration: gap.endTime - gap.startTime,
            mode: gapGenerateMode,
            beforePrompt,
            afterPrompt,
            beforeFrame,
            afterFrame,
          }),
          signal: abortController.signal,
        })
        
        if (abortController.signal.aborted) return
        
        if (response.ok) {
          const data = await response.json()
          if (data.suggested_prompt && !abortController.signal.aborted) {
            setGapSuggestion(data.suggested_prompt)
            // Auto-fill the prompt if user hasn't typed anything yet
            setGapPrompt(prev => prev.trim() ? prev : data.suggested_prompt)
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        console.warn('Gap prompt suggestion failed:', err)
      } finally {
        if (!abortController.signal.aborted) {
          setGapSuggesting(false)
        }
      }
    }
    
    suggest()
    
    return () => { abortController.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGap, gapGenerateMode]) // Only trigger when modal opens, not on every prompt change
  
  // --- Image-to-Video from image clip ---
  const handleI2vGenerate = useCallback(async () => {
    if (!i2vClipId || !i2vPrompt.trim() || !currentProjectId) return
    
    const clip = clips.find(c => c.id === i2vClipId)
    if (!clip) return
    
    // Get the image URL for this clip
    const imageUrl = resolveClipSrc(clip)
    if (!imageUrl) return
    
    // Convert the image URL/path to a File object for the generation API
    // NOTE: fetch() cannot access file:// URLs in Electron renderer, so we use
    // either readLocalFile IPC (for file:// paths) or canvas capture as fallback
    try {
      let file: File
      
      // Extract the file path from the URL (handle file:/// prefix)
      const filePath = imageUrl.startsWith('file:///')
        ? decodeURIComponent(imageUrl.replace('file:///', ''))  // Windows: file:///C:/... → C:/...
        : imageUrl.startsWith('file://')
        ? decodeURIComponent(imageUrl.replace('file://', ''))   // Unix: file:///path → /path
        : null
      
      if (filePath && window.electronAPI?.readLocalFile) {
        // Use Electron IPC to read the local file as base64
        const { data, mimeType } = await window.electronAPI.readLocalFile(filePath)
        const byteString = atob(data)
        const ab = new ArrayBuffer(byteString.length)
        const ia = new Uint8Array(ab)
        for (let i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i)
        }
        const blob = new Blob([ab], { type: mimeType || 'image/png' })
        file = new File([blob], 'input-image.png', { type: mimeType || 'image/png' })
      } else {
        // Fallback: draw the image onto a canvas to get a blob
        const img = new window.Image()
        img.crossOrigin = 'anonymous'
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('Failed to load image for I2V'))
          img.src = imageUrl
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png')
        })
        file = new File([blob], 'input-image.png', { type: 'image/png' })
      }
      
      const settings: GenerationSettings = {
        ...i2vSettings,
        duration: Math.min(Math.max(1, Math.round(clip.duration)), i2vSettings.model === 'pro' ? 10 : 20),
      }
      
      await regenGenerate(i2vPrompt, file, settings)
    } catch (err) {
      console.error('I2V generation failed:', err)
    }
  }, [i2vClipId, i2vPrompt, i2vSettings, currentProjectId, clips, resolveClipSrc, regenGenerate])
  
  // When I2V generation completes, replace the image clip with a video clip
  useEffect(() => {
    if (!i2vClipId || isRegenerating) return
    if (!regenVideoUrl || !currentProjectId) return
    
    const clip = clips.find(c => c.id === i2vClipId)
    if (!clip) { setI2vClipId(null); return }
    
    // Create a new video asset with generationParams so regenerate button works
    const asset = addAsset(currentProjectId, {
      type: 'video',
      path: regenVideoPath || regenVideoUrl,
      url: regenVideoUrl,
      prompt: i2vPrompt,
      resolution: i2vSettings.resolution,
      duration: clip.duration,
      generationParams: {
        mode: 'image-to-video',
        prompt: i2vPrompt,
        model: i2vSettings.model,
        duration: Math.min(Math.max(1, Math.round(clip.duration)), i2vSettings.model === 'pro' ? 10 : 20),
        resolution: i2vSettings.resolution,
        fps: i2vSettings.fps,
        audio: i2vSettings.audio,
        cameraMotion: i2vSettings.cameraMotion,
      },
      takes: [{
        url: regenVideoUrl,
        path: regenVideoPath || regenVideoUrl,
        createdAt: Date.now(),
      }],
      activeTakeIndex: 0,
    })
    
    // Replace the image clip with a video clip in-place
    setClips(prev => prev.map(c => {
      if (c.id !== i2vClipId) return c
      return {
        ...c,
        assetId: asset.id,
        type: 'video' as const,
        asset,
      }
    }))
    
    // Clean up
    setI2vClipId(null)
    setI2vPrompt('')
    regenReset()
    
  }, [regenVideoUrl, isRegenerating])
  
  // --- Import timeline from NLE XML ---
  const handleImportTimeline = useCallback(async (parsed: ParsedTimeline) => {
    if (!currentProjectId) return
    
    // Build a map from media ref id → our Asset
    const mediaToAsset = new Map<string, Asset>()
    
    for (const ref of parsed.mediaRefs) {
      const filePath = ref.relinkedPath || ref.resolvedPath
      const fileName = ref.name || filePath.split(/[/\\]/).pop() || 'Unknown'
      
      let url = ''
      let assetPath = filePath
      
      // If file is found, create a file:// URL and optionally import to storage
      if (ref.found && filePath) {
        // Try to import to persistent storage
        if (window.electronAPI?.importFileToStorage) {
          try {
            const result = await window.electronAPI.importFileToStorage(filePath, fileName)
            if (result.success && result.url && result.path) {
              url = result.url
              assetPath = result.path
            } else {
              // Fallback: build file URL directly
              const normalized = filePath.replace(/\\/g, '/')
              url = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
              assetPath = filePath
            }
          } catch {
            const normalized = filePath.replace(/\\/g, '/')
            url = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
            assetPath = filePath
          }
        } else {
          const normalized = filePath.replace(/\\/g, '/')
          url = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
          assetPath = filePath
        }
      }
      
      // Create an asset in the project
      const resolution = (ref.width && ref.height) ? `${ref.width}x${ref.height}` : 'Unknown'
      const asset = addAsset(currentProjectId, {
        type: ref.type,
        path: assetPath,
        url,
        prompt: fileName,
        resolution,
        duration: ref.duration || undefined,
        bin: 'Imported',
      })
      
      mediaToAsset.set(ref.id, asset)
    }
    
    // Build tracks with NLE naming and kind
    const totalTracks = Math.max(parsed.videoTrackCount + parsed.audioTrackCount, 1)
    const newTracks: Track[] = []
    for (let i = 0; i < totalTracks; i++) {
      const isAudio = i >= parsed.videoTrackCount
      newTracks.push({
        id: `track-${Date.now()}-${i}`,
        name: isAudio ? `A${i - parsed.videoTrackCount + 1}` : `V${i + 1}`,
        muted: false,
        locked: false,
        kind: isAudio ? 'audio' : 'video',
      })
    }
    
    // Build clips
    const newClips: TimelineClip[] = []
    for (const pc of parsed.clips) {
      const asset = mediaToAsset.get(pc.mediaRefId)
      if (!asset) continue
      
      const clip: TimelineClip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        assetId: asset.id,
        type: pc.trackType === 'audio' ? 'audio' : asset.type === 'image' ? 'image' : 'video',
        startTime: pc.startTime,
        duration: pc.duration,
        trimStart: pc.sourceIn || 0,
        trimEnd: 0,
        speed: pc.speed || 1,
        reversed: pc.reversed || false,
        muted: pc.muted || false,
        volume: pc.volume !== undefined ? Math.min(1, Math.max(0, pc.volume)) : 1,
        trackIndex: Math.min(pc.trackIndex, totalTracks - 1),
        asset,
        importedName: pc.name,
        flipH: pc.flipH || false,
        flipV: pc.flipV || false,
        transitionIn: { type: 'none', duration: 0 },
        transitionOut: { type: 'none', duration: 0 },
        colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
        opacity: pc.opacity !== undefined ? pc.opacity : 100,
      }
      newClips.push(clip)
    }
    
    // Create a new timeline with these tracks and clips
    const newTimeline = addTimeline(currentProjectId, parsed.name || 'Imported Timeline')
    
    // Update with our custom tracks and clips
    updateTimeline(currentProjectId, newTimeline.id, {
      tracks: newTracks,
      clips: newClips,
    })
    
    // Switch to the new timeline and open its tab
    setActiveTimeline(currentProjectId, newTimeline.id)
    setOpenTimelineIds(prev => { const next = new Set(prev); next.add(newTimeline.id); return next })
    
    // Load locally
    setTracks(newTracks)
    setClips(newClips)
    setSubtitles([])
    setCurrentTime(0)
    setSelectedClipIds(new Set())
    setSelectedSubtitleId(null)
    
  }, [currentProjectId, addAsset, addTimeline, updateTimeline, setActiveTimeline])
  
  // --- Export timeline as FCP 7 XML ---
  const handleExportTimelineXml = useCallback(async () => {
    if (!activeTimeline) return
    
    // Build clip data for export
    const exportClips = clips
      .filter(c => c.asset && c.type !== 'adjustment')
      .map(c => {
        const asset = assets.find(a => a.id === c.assetId) || c.asset!
        // Get the active take's path
        let filePath = asset.path
        if (asset.takes && asset.takes.length > 0) {
          const idx = c.takeIndex ?? asset.activeTakeIndex ?? 0
          const take = asset.takes[Math.min(idx, asset.takes.length - 1)]
          filePath = take.path
        }
        
        // Parse resolution
        const resParts = asset.resolution?.match(/(\d+)x(\d+)/)
        const width = resParts ? parseInt(resParts[1]) : 1920
        const height = resParts ? parseInt(resParts[2]) : 1080
        
        return {
          name: c.importedName || asset.path?.split(/[/\\]/).pop() || 'clip',
          filePath,
          trackIndex: c.trackIndex,
          type: c.type as 'video' | 'image' | 'audio',
          startTime: c.startTime,
          duration: c.duration,
          trimStart: c.trimStart,
          sourceDuration: asset.duration || c.duration,
          width,
          height,
        }
      })
    
    const xmlContent = exportFcp7Xml({
      name: activeTimeline.name,
      fps: 24,
      width: 1920,
      height: 1080,
      clips: exportClips,
    })
    
    if (window.electronAPI?.showSaveDialog) {
      const filePath = await window.electronAPI.showSaveDialog({
        title: 'Export Timeline as FCP 7 XML',
        defaultPath: `${activeTimeline.name}.xml`,
        filters: [{ name: 'FCP 7 XML', extensions: ['xml'] }],
      })
      if (filePath) {
        await window.electronAPI.saveFile(filePath, xmlContent)
      }
    } else {
      const blob = new Blob([xmlContent], { type: 'text/xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${activeTimeline.name}.xml`
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [activeTimeline, clips, assets])
  
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    const frames = Math.floor((seconds % 1) * 24)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`
  }
  
  // Compute adaptive ruler interval based on zoom level
  const rulerInterval = useMemo(() => {
    // Target: major tick labels should be at least ~80px apart
    const minLabelSpacing = 80
    // Candidate intervals in seconds
    const intervals = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    for (const interval of intervals) {
      if (interval * pixelsPerSecond >= minLabelSpacing) return interval
    }
    return 600
  }, [pixelsPerSecond])
  
  // Compute sub-tick interval (minor ticks between major ones)
  const rulerSubInterval = useMemo(() => {
    if (rulerInterval <= 1) return 0.5
    if (rulerInterval <= 5) return 1
    if (rulerInterval <= 15) return 5
    if (rulerInterval <= 60) return 10
    if (rulerInterval <= 300) return 60
    return 60
  }, [rulerInterval])
  
  // --- Scroll sync: keep track headers and ruler in sync with timeline scroll ---
  const handleTimelineScroll = useCallback(() => {
    const container = trackContainerRef.current
    if (!container) return
    // Sync track headers vertical scroll
    if (trackHeadersRef.current) {
      trackHeadersRef.current.scrollTop = container.scrollTop
    }
    // Sync ruler horizontal scroll
    if (rulerScrollRef.current) {
      rulerScrollRef.current.scrollLeft = container.scrollLeft
    }
    // Sync overlay playhead horizontal position
    if (playheadOverlayRef.current) {
      playheadOverlayRef.current.style.left = `${currentTime * pixelsPerSecond - container.scrollLeft}px`
    }
  }, [currentTime, pixelsPerSecond])
  
  // --- Mouse handlers ---
  
  // --- Ruler scrub: click + drag to scrub playhead ---
  const isScrubbing = useRef(false)
  
  const scrubFromEvent = useCallback((clientX: number) => {
    if (!timelineRef.current) return
    const rect = timelineRef.current.getBoundingClientRect()
    // getBoundingClientRect already accounts for the parent's scroll offset,
    // so clientX - rect.left gives the correct position within the timeline.
    const x = clientX - rect.left
    const time = x / pixelsPerSecond
    setCurrentTime(Math.max(0, Math.min(time, totalDuration)))
  }, [pixelsPerSecond, totalDuration])
  
  const handleRulerMouseDown = useCallback((e: React.MouseEvent) => {
    if (activeTool === 'hand') return
    if (e.button !== 0) return // only left button
    e.preventDefault() // prevent text selection
    isScrubbing.current = true
    setIsPlaying(false) // pause playback while scrubbing
    scrubFromEvent(e.clientX)
    
    const onMove = (ev: MouseEvent) => {
      if (!isScrubbing.current) return
      ev.preventDefault()
      scrubFromEvent(ev.clientX)
    }
    const onUp = () => {
      isScrubbing.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [activeTool, scrubFromEvent])
  
  
  
  const handleClipMouseDown = (e: React.MouseEvent, clip: TimelineClip) => {
    e.stopPropagation()
    
    if (activeTool === 'blade') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const clickTime = clip.startTime + (clickX / rect.width) * clip.duration
      
      setCurrentTime(clickTime)
      setTimeout(() => splitClipAtPlayhead(clip.id), 0)
      return
    }
    
    // --- Slip tool: shift source content within clip ---
    if (activeTool === 'slip') {
      setSelectedClipIds(new Set([clip.id]))
      pushUndo()
      setSlipSlideClip({
        clipId: clip.id,
        tool: 'slip',
        startX: e.clientX,
        originalTrimStart: clip.trimStart,
        originalTrimEnd: clip.trimEnd,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
      })
      return
    }
    
    // --- Slide tool: move clip, adjust neighbors ---
    if (activeTool === 'slide') {
      setSelectedClipIds(new Set([clip.id]))
      pushUndo()
      
      // Find the previous and next clips on the same track
      const sameTrack = clips
        .filter(c => c.trackIndex === clip.trackIndex && c.id !== clip.id)
        .sort((a, b) => a.startTime - b.startTime)
      const prevClip = sameTrack.filter(c => c.startTime + c.duration <= clip.startTime + 0.05).pop()
      const nextClip = sameTrack.find(c => c.startTime >= clip.startTime + clip.duration - 0.05)
      
      setSlipSlideClip({
        clipId: clip.id,
        tool: 'slide',
        startX: e.clientX,
        originalTrimStart: clip.trimStart,
        originalTrimEnd: clip.trimEnd,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        prevClipId: prevClip?.id,
        prevOrigDuration: prevClip?.duration,
        nextClipId: nextClip?.id,
        nextOrigStartTime: nextClip?.startTime,
        nextOrigDuration: nextClip?.duration,
        nextOrigTrimStart: nextClip?.trimStart,
      })
      return
    }
    
    // --- Track Select Forward: select this clip + all clips to the right ---
    if (activeTool === 'trackForward') {
      const forwardClips = clips.filter(c => {
        if (e.shiftKey) {
          // Shift held: select forward on ALL tracks
          return c.startTime >= clip.startTime
        } else {
          // Normal: only the same track
          return c.trackIndex === clip.trackIndex && c.startTime >= clip.startTime
        }
      })
      const forwardIds = new Set(forwardClips.map(c => c.id))
      setSelectedClipIds(forwardIds)
      setSelectedSubtitleId(null)
      setSelectedGap(null)
      
      // Start drag so the user can slide the whole forward selection
      pushUndo()
      const originalPositions: Record<string, { startTime: number; trackIndex: number }> = {}
      forwardClips.forEach(c => {
        originalPositions[c.id] = { startTime: c.startTime, trackIndex: c.trackIndex }
      })
      setDraggingClip({
        clipId: clip.id,
        startX: e.clientX,
        startY: e.clientY,
        originalStartTime: clip.startTime,
        originalTrackIndex: clip.trackIndex,
        originalPositions,
      })
      return
    }
    
    if (activeTool === 'select' || activeTool === 'ripple' || activeTool === 'roll') {
      // Compute the effective selection BEFORE React processes the state update
      let effectiveSelection: Set<string>
      if (e.shiftKey) {
        // Shift+click: toggle clip in/out of multi-selection
        effectiveSelection = new Set(selectedClipIds)
        if (effectiveSelection.has(clip.id)) {
          effectiveSelection.delete(clip.id)
        } else {
          effectiveSelection.add(clip.id)
        }
        setSelectedClipIds(effectiveSelection)
      } else {
        // Normal click: if clip is already part of multi-selection, keep it
        // otherwise select only this clip
        if (selectedClipIds.has(clip.id)) {
          effectiveSelection = selectedClipIds
        } else {
          effectiveSelection = new Set([clip.id])
          setSelectedClipIds(effectiveSelection)
        }
      }
      
      // Record undo before drag begins
      pushUndo()
      // Capture original positions of all clips in the effective selection
      const originalPositions: Record<string, { startTime: number; trackIndex: number }> = {}
      for (const c of clips) {
        if (effectiveSelection.has(c.id)) {
          originalPositions[c.id] = { startTime: c.startTime, trackIndex: c.trackIndex }
        }
      }
      // Always ensure the clicked clip is in the group
      if (!originalPositions[clip.id]) {
        originalPositions[clip.id] = { startTime: clip.startTime, trackIndex: clip.trackIndex }
      }
      
      // --- Alt+drag: duplicate clips instead of moving originals ---
      if (e.altKey) {
        // Create duplicate clips for all selected clips
        const idMap = new Map<string, string>() // old id → new id
        const duplicateClips: TimelineClip[] = []
        for (const c of clips) {
          if (!originalPositions[c.id]) continue
          const newId = `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
          idMap.set(c.id, newId)
          duplicateClips.push({
            ...c,
            id: newId,
            isRegenerating: false,
          })
        }
        
        // Add duplicates to the timeline (originals stay in place)
        setClips(prev => [...prev, ...duplicateClips])
        
        // Build originalPositions for the NEW duplicate clips
        const dupOrigPositions: Record<string, { startTime: number; trackIndex: number }> = {}
        for (const [oldId, pos] of Object.entries(originalPositions)) {
          const newId = idMap.get(oldId)
          if (newId) dupOrigPositions[newId] = { ...pos }
        }
        
        // Select the duplicates
        const newPrimaryId = idMap.get(clip.id) || clip.id
        setSelectedClipIds(new Set(Object.keys(dupOrigPositions)))
        
        // Start dragging the duplicates
        setDraggingClip({
          clipId: newPrimaryId,
          startX: e.clientX,
          startY: e.clientY,
          originalStartTime: clip.startTime,
          originalTrackIndex: clip.trackIndex,
          originalPositions: dupOrigPositions,
          isDuplicate: true,
        })
      } else {
        // Normal drag: move originals
        setDraggingClip({
          clipId: clip.id,
          startX: e.clientX,
          startY: e.clientY,
          originalStartTime: clip.startTime,
          originalTrackIndex: clip.trackIndex,
          originalPositions,
        })
      }
    }
  }
  
  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Handle lasso dragging
    if (lassoRect) {
      setLassoRect(prev => prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null)
      return
    }
    
    if (!draggingClip || !trackContainerRef.current) return
    
    const primaryClip = clips.find(c => c.id === draggingClip.clipId)
    if (!primaryClip) return
    
    const deltaX = e.clientX - draggingClip.startX
    const deltaY = e.clientY - draggingClip.startY
    
    // Compute the primary clip's new position
    let newStartTime = draggingClip.originalStartTime + deltaX / pixelsPerSecond
    newStartTime = Math.max(0, newStartTime)
    
    // Snap the primary clip (skip other clips in the drag group for snapping)
    const origPositions = draggingClip.originalPositions
    if (snapEnabled) {
      const snapThreshold = 0.2
      for (const otherClip of clips) {
        if (origPositions[otherClip.id]) continue // skip clips in the drag group
        
        if (Math.abs(newStartTime - otherClip.startTime) < snapThreshold) {
          newStartTime = otherClip.startTime
        }
        const otherEnd = otherClip.startTime + otherClip.duration
        if (Math.abs(newStartTime - otherEnd) < snapThreshold) {
          newStartTime = otherEnd
        }
        const clipEnd = newStartTime + primaryClip.duration
        if (Math.abs(clipEnd - otherClip.startTime) < snapThreshold) {
          newStartTime = otherClip.startTime - primaryClip.duration
        }
      }
      if (Math.abs(newStartTime - currentTime) < snapThreshold) {
        newStartTime = currentTime
      }
      if (Math.abs(newStartTime + primaryClip.duration - currentTime) < snapThreshold) {
        newStartTime = currentTime - primaryClip.duration
      }
    }
    
    const trackHeight = 56
    const rawTrackDelta = Math.round(deltaY / trackHeight)
    
    // Compute raw deltas relative to primary clip's original position
    let timeDelta = newStartTime - draggingClip.originalStartTime
    let trackIndexDelta = rawTrackDelta
    
    // Clamp deltas so NO clip in the group goes out of bounds — preserves relative positions
    for (const orig of Object.values(origPositions)) {
      // Ensure no clip goes before time 0
      if (orig.startTime + timeDelta < 0) {
        timeDelta = -orig.startTime
      }
      // Ensure no clip goes below track 0
      if (orig.trackIndex + trackIndexDelta < 0) {
        trackIndexDelta = Math.max(trackIndexDelta, -orig.trackIndex)
      }
      // Ensure no clip goes above the last track
      if (orig.trackIndex + trackIndexDelta > tracks.length - 1) {
        trackIndexDelta = Math.min(trackIndexDelta, tracks.length - 1 - orig.trackIndex)
      }
    }
    
    // Check if any clip in the group would land on a locked track — if so, prevent track movement
    const anyLocked = Object.values(origPositions).some(orig => {
      const targetTrack = orig.trackIndex + trackIndexDelta
      return tracks[targetTrack]?.locked
    })
    if (anyLocked) trackIndexDelta = 0
    
    // Move all selected clips together using the same clamped deltas
    setClips(prev => prev.map(c => {
      const orig = origPositions[c.id]
      if (!orig) return c
      return {
        ...c,
        startTime: orig.startTime + timeDelta,
        trackIndex: orig.trackIndex + trackIndexDelta,
      }
    }))
  }, [draggingClip, clips, pixelsPerSecond, snapEnabled, tracks, currentTime, lassoRect])
  
  const handleMouseUp = useCallback(() => {
    // Finalize lasso selection
    if (lassoRect && trackContainerRef.current) {
      const origin = lassoOriginRef.current
      if (origin) {
        const container = trackContainerRef.current
        const scrollLeft = container.scrollLeft
        const scrollTop = container.scrollTop
        
        // Compute lasso rectangle in timeline-local coordinates
        const lx1 = Math.min(lassoRect.startX, lassoRect.currentX) - origin.containerLeft + scrollLeft
        const lx2 = Math.max(lassoRect.startX, lassoRect.currentX) - origin.containerLeft + scrollLeft
        const ly1 = Math.min(lassoRect.startY, lassoRect.currentY) - origin.containerTop + scrollTop
        const ly2 = Math.max(lassoRect.startY, lassoRect.currentY) - origin.containerTop + scrollTop
        
        // Convert to time/track
        const timeStart = lx1 / pixelsPerSecond
        const timeEnd = lx2 / pixelsPerSecond
        const trackHeight = 56
        
        const newSelection = new Set<string>()
        for (const clip of clips) {
          const clipLeft = clip.startTime
          const clipRight = clip.startTime + clip.duration
          const clipTop = clip.trackIndex * trackHeight + 4
          const clipBottom = clipTop + 48 // h-12 = 48px
          
          // Check overlap between lasso rect and clip rect
          if (clipRight > timeStart && clipLeft < timeEnd && clipBottom > ly1 && clipTop < ly2) {
            newSelection.add(clip.id)
          }
        }
        setSelectedClipIds(newSelection)
      }
      setLassoRect(null)
      lassoOriginRef.current = null
    }
    
    // Resolve overlaps after drag or resize completes
    if (draggingClip) {
      const movedIds = new Set(Object.keys(draggingClip.originalPositions))
      setClips(prev => resolveOverlaps(prev, movedIds))
    }
    if (resizingClip) {
      setClips(prev => resolveOverlaps(prev, new Set([resizingClip.clipId])))
    }
    
    setDraggingClip(null)
    setResizingClip(null)
  }, [lassoRect, clips, pixelsPerSecond, draggingClip, resizingClip])
  
  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingClip) return
    
    const clip = clips.find(c => c.id === resizingClip.clipId)
    if (!clip) return
    
    const deltaX = e.clientX - resizingClip.startX
    const deltaTime = deltaX / pixelsPerSecond
    const tool = resizingClip.tool
    
    // --- ROLL TRIM: move the edit point between two adjacent clips ---
    if (tool === 'roll' && resizingClip.adjacentClipId) {
      const adjClip = clips.find(c => c.id === resizingClip.adjacentClipId)
      if (!adjClip) return
      
      let dt = deltaTime
      
      if (resizingClip.edge === 'right') {
        // Dragging right edge of clip → makes clip longer, adjacent (to the right) shorter
        const maxExtend = Math.min(
          getMaxClipDuration(clip) - resizingClip.originalDuration,
          (resizingClip.adjacentOrigDuration ?? adjClip.duration) - 0.5,
        )
        const maxShrink = resizingClip.originalDuration - 0.5
        dt = Math.max(-maxShrink, Math.min(maxExtend, dt))
        
        setClips(prev => prev.map(c => {
          if (c.id === clip.id) {
            return { ...c, duration: Math.max(0.5, resizingClip.originalDuration + dt) }
          }
          if (c.id === resizingClip.adjacentClipId) {
            const newStart = (resizingClip.adjacentOrigStartTime ?? c.startTime) + dt
            const newDur = (resizingClip.adjacentOrigDuration ?? c.duration) - dt
            const newTrimStart = (resizingClip.adjacentOrigTrimStart ?? c.trimStart) + dt * c.speed
            return { ...c, startTime: newStart, duration: Math.max(0.5, newDur), trimStart: Math.max(0, newTrimStart) }
          }
          return c
        }))
      } else {
        // Dragging left edge of clip → makes clip longer (to the left), adjacent (to the left) shorter
        const maxExtend = Math.min(
          getMaxClipDuration(clip) - resizingClip.originalDuration,
          (resizingClip.adjacentOrigDuration ?? adjClip.duration) - 0.5,
        )
        const maxShrink = resizingClip.originalDuration - 0.5
        dt = Math.max(-maxExtend, Math.min(maxShrink, dt))
        
        setClips(prev => prev.map(c => {
          if (c.id === clip.id) {
            const newStart = resizingClip.originalStartTime + dt
            const newDur = resizingClip.originalDuration - dt
            const newTrimStart = resizingClip.originalTrimStart + dt * c.speed
            return { ...c, startTime: newStart, duration: Math.max(0.5, newDur), trimStart: Math.max(0, newTrimStart) }
          }
          if (c.id === resizingClip.adjacentClipId) {
            return { ...c, duration: Math.max(0.5, (resizingClip.adjacentOrigDuration ?? c.duration) + dt) }
          }
          return c
        }))
      }
      return
    }
    
    // --- RIPPLE TRIM: trim edge and shift all subsequent clips ---
    if (tool === 'ripple') {
      if (resizingClip.edge === 'left') {
        let newStartTime = resizingClip.originalStartTime + deltaTime
        let newDuration = resizingClip.originalDuration - deltaTime
        
        if (newDuration < 0.5) { newDuration = 0.5; newStartTime = resizingClip.originalStartTime + resizingClip.originalDuration - 0.5 }
        if (newStartTime < 0) { newDuration = resizingClip.originalDuration + resizingClip.originalStartTime; newStartTime = 0 }
        
        const newTrimStart = resizingClip.originalTrimStart + (newStartTime - resizingClip.originalStartTime)
        const maxDur = getMaxClipDuration({ ...clip, trimStart: Math.max(0, newTrimStart) })
        newDuration = Math.min(newDuration, maxDur)
        
        const rippleDelta = newStartTime - resizingClip.originalStartTime // negative = clip grew left, positive = clip shrank left
        
        setClips(prev => prev.map(c => {
          if (c.id === clip.id) {
            return { ...c, startTime: newStartTime, duration: Math.max(0.5, newDuration), trimStart: Math.max(0, newTrimStart) }
          }
          // Shift clips that come before this clip on the same track
          if (c.trackIndex === clip.trackIndex && c.id !== clip.id && c.startTime < resizingClip.originalStartTime) {
            return { ...c, startTime: Math.max(0, c.startTime + rippleDelta) }
          }
          return c
        }))
      } else {
        let newDuration = resizingClip.originalDuration + deltaTime
        newDuration = Math.max(0.5, newDuration)
        const maxDur = getMaxClipDuration(clip)
        newDuration = Math.min(newDuration, maxDur)
        
        const originalEnd = resizingClip.originalStartTime + resizingClip.originalDuration
        const newEnd = resizingClip.originalStartTime + newDuration
        const rippleDelta = newEnd - originalEnd
        
        setClips(prev => prev.map(c => {
          if (c.id === clip.id) {
            return { ...c, duration: Math.max(0.5, newDuration) }
          }
          // Shift clips that start at or after the original end on the same track
          if (c.trackIndex === clip.trackIndex && c.id !== clip.id && c.startTime >= originalEnd - 0.01) {
            return { ...c, startTime: Math.max(0, c.startTime + rippleDelta) }
          }
          return c
        }))
      }
      return
    }
    
    // --- NORMAL TRIM (select tool or any tool without special handling) ---
    if (resizingClip.edge === 'left') {
      let newStartTime = resizingClip.originalStartTime + deltaTime
      let newDuration = resizingClip.originalDuration - deltaTime
      
      if (newDuration < 0.5) {
        newDuration = 0.5
        newStartTime = resizingClip.originalStartTime + resizingClip.originalDuration - 0.5
      }
      
      if (newStartTime < 0) {
        newDuration = resizingClip.originalDuration + resizingClip.originalStartTime
        newStartTime = 0
      }
      
      if (snapEnabled) {
        const snapThreshold = 0.2
        if (Math.abs(newStartTime - currentTime) < snapThreshold) {
          const adjustment = currentTime - newStartTime
          newStartTime = currentTime
          newDuration -= adjustment
        }
        for (const otherClip of clips) {
          if (otherClip.id === clip.id) continue
          const otherEnd = otherClip.startTime + otherClip.duration
          if (Math.abs(newStartTime - otherEnd) < snapThreshold) {
            const adjustment = otherEnd - newStartTime
            newStartTime = otherEnd
            newDuration -= adjustment
          }
          if (Math.abs(newStartTime - otherClip.startTime) < snapThreshold) {
            const adjustment = otherClip.startTime - newStartTime
            newStartTime = otherClip.startTime
            newDuration -= adjustment
          }
        }
      }
      
      const newTrimStart = resizingClip.originalTrimStart + (newStartTime - resizingClip.originalStartTime)
      const maxDur = getMaxClipDuration({ ...clip, trimStart: Math.max(0, newTrimStart) })
      newDuration = Math.min(newDuration, maxDur)
      
      setClips(prev => prev.map(c => c.id === clip.id ? { ...c, startTime: newStartTime, duration: Math.max(0.5, newDuration), trimStart: Math.max(0, newTrimStart) } : c))
    } else {
      let newDuration = resizingClip.originalDuration + deltaTime
      newDuration = Math.max(0.5, newDuration)
      
      if (snapEnabled) {
        const snapThreshold = 0.2
        const newEndTime = clip.startTime + newDuration
        
        if (Math.abs(newEndTime - currentTime) < snapThreshold) {
          newDuration = currentTime - clip.startTime
        }
        for (const otherClip of clips) {
          if (otherClip.id === clip.id) continue
          if (Math.abs(newEndTime - otherClip.startTime) < snapThreshold) {
            newDuration = otherClip.startTime - clip.startTime
          }
          const otherEnd = otherClip.startTime + otherClip.duration
          if (Math.abs(newEndTime - otherEnd) < snapThreshold) {
            newDuration = otherEnd - clip.startTime
          }
        }
      }
      
      const maxDur = getMaxClipDuration(clip)
      newDuration = Math.min(newDuration, maxDur)
      
      setClips(prev => prev.map(c => c.id === clip.id ? { ...c, duration: Math.max(0.5, newDuration) } : c))
    }
  }, [resizingClip, clips, pixelsPerSecond, snapEnabled, currentTime, getMaxClipDuration])
  
  const handleResizeStart = (e: React.MouseEvent, clip: TimelineClip, edge: 'left' | 'right') => {
    e.stopPropagation()
    e.preventDefault()
    
    setSelectedClipIds(new Set([clip.id]))
    
    // For Roll trim, find the adjacent clip at the edit point
    let adjacentClip: TimelineClip | undefined
    if (activeTool === 'roll') {
      const clipEnd = clip.startTime + clip.duration
      if (edge === 'right') {
        // Find clip that starts right at (or very near) this clip's end on the same track
        adjacentClip = clips.find(c => c.id !== clip.id && c.trackIndex === clip.trackIndex && Math.abs(c.startTime - clipEnd) < 0.05)
      } else {
        // Find clip that ends right at (or very near) this clip's start on the same track
        adjacentClip = clips.find(c => c.id !== clip.id && c.trackIndex === clip.trackIndex && Math.abs((c.startTime + c.duration) - clip.startTime) < 0.05)
      }
    }
    
    setResizingClip({
      clipId: clip.id,
      edge,
      startX: e.clientX,
      originalStartTime: clip.startTime,
      originalDuration: clip.duration,
      originalTrimStart: clip.trimStart,
      originalTrimEnd: clip.trimEnd,
      tool: activeTool,
      adjacentClipId: adjacentClip?.id,
      adjacentOrigDuration: adjacentClip?.duration,
      adjacentOrigTrimStart: adjacentClip?.trimStart,
      adjacentOrigTrimEnd: adjacentClip?.trimEnd,
      adjacentOrigStartTime: adjacentClip?.startTime,
    })
  }
  
  useEffect(() => {
    if (draggingClip || lassoRect) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [draggingClip, lassoRect, handleMouseMove, handleMouseUp])
  
  useEffect(() => {
    if (resizingClip) {
      window.addEventListener('mousemove', handleResizeMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleResizeMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [resizingClip, handleResizeMove, handleMouseUp])
  
  // --- Slip/Slide mouse move handler ---
  const handleSlipSlideMove = useCallback((e: MouseEvent) => {
    if (!slipSlideClip) return
    
    const clip = clips.find(c => c.id === slipSlideClip.clipId)
    if (!clip) return
    
    const deltaX = e.clientX - slipSlideClip.startX
    const deltaTime = deltaX / pixelsPerSecond
    
    if (slipSlideClip.tool === 'slip') {
      // SLIP: shift source content within the clip (change trimStart/trimEnd, keep position)
      // Moving right = shift source earlier = increase trimStart, decrease trimEnd
      if (clip.type !== 'video' || !clip.asset?.duration) return
      
      const mediaDuration = clip.asset.duration
      const shiftAmount = deltaTime * clip.speed // convert to media time
      
      let newTrimStart = slipSlideClip.originalTrimStart + shiftAmount
      let newTrimEnd = slipSlideClip.originalTrimEnd - shiftAmount
      
      // Clamp so neither goes negative
      if (newTrimStart < 0) {
        newTrimEnd += newTrimStart
        newTrimStart = 0
      }
      if (newTrimEnd < 0) {
        newTrimStart += newTrimEnd
        newTrimEnd = 0
      }
      
      // Ensure trimStart + trimEnd + visible media ≤ total media duration
      const visibleMedia = clip.duration * clip.speed
      if (newTrimStart + visibleMedia + newTrimEnd > mediaDuration) {
        return // Can't slip further
      }
      
      setClips(prev => prev.map(c =>
        c.id === clip.id ? { ...c, trimStart: Math.max(0, newTrimStart), trimEnd: Math.max(0, newTrimEnd) } : c
      ))
    } else {
      // SLIDE: move clip in time, adjust neighbor durations to fill the space
      let newStartTime = slipSlideClip.originalStartTime + deltaTime
      
      // Clamp: can't go before prevClip's start (or 0)
      const minStart = slipSlideClip.prevClipId
        ? clips.find(c => c.id === slipSlideClip.prevClipId)?.startTime ?? 0
        : 0
      // Clamp: can't go past nextClip's end (or infinity)
      const nextEnd = slipSlideClip.nextClipId
        ? (slipSlideClip.nextOrigStartTime ?? 0) + (slipSlideClip.nextOrigDuration ?? 0)
        : Infinity
      newStartTime = Math.max(minStart, Math.min(nextEnd - clip.duration, newStartTime))
      
      const actualDelta = newStartTime - slipSlideClip.originalStartTime
      
      setClips(prev => prev.map(c => {
        if (c.id === clip.id) {
          return { ...c, startTime: newStartTime }
        }
        // Adjust previous clip: extend its duration
        if (slipSlideClip.prevClipId && c.id === slipSlideClip.prevClipId) {
          const newDur = (slipSlideClip.prevOrigDuration ?? c.duration) + actualDelta
          return { ...c, duration: Math.max(0.5, newDur) }
        }
        // Adjust next clip: shift start and extend duration
        if (slipSlideClip.nextClipId && c.id === slipSlideClip.nextClipId) {
          const newStart = (slipSlideClip.nextOrigStartTime ?? c.startTime) + actualDelta
          const newDur = (slipSlideClip.nextOrigDuration ?? c.duration) - actualDelta
          const newTrimStart = (slipSlideClip.nextOrigTrimStart ?? c.trimStart) + actualDelta * c.speed
          return { ...c, startTime: newStart, duration: Math.max(0.5, newDur), trimStart: Math.max(0, newTrimStart) }
        }
        return c
      }))
    }
  }, [slipSlideClip, clips, pixelsPerSecond])
  
  const handleSlipSlideUp = useCallback(() => {
    setSlipSlideClip(null)
  }, [])
  
  useEffect(() => {
    if (slipSlideClip) {
      window.addEventListener('mousemove', handleSlipSlideMove)
      window.addEventListener('mouseup', handleSlipSlideUp)
      return () => {
        window.removeEventListener('mousemove', handleSlipSlideMove)
        window.removeEventListener('mouseup', handleSlipSlideUp)
      }
    }
  }, [slipSlideClip, handleSlipSlideMove, handleSlipSlideUp])
  
  const handleTrackDrop = (e: React.DragEvent, trackIndex: number) => {
    e.preventDefault()
    
    // Check if it's a timeline being dropped (flatten on drop)
    const timelineData = e.dataTransfer.getData('timeline')
    if (timelineData && trackContainerRef.current) {
      const droppedTimeline = JSON.parse(timelineData) as { id: string; name: string }
      const sourceTimeline = timelines.find(t => t.id === droppedTimeline.id)
      if (!sourceTimeline || sourceTimeline.id === activeTimeline?.id) return
      if (sourceTimeline.clips.length === 0) return
      
      const rect = trackContainerRef.current.getBoundingClientRect()
      const scrollLeft = trackContainerRef.current.scrollLeft
      const x = e.clientX - rect.left + scrollLeft
      const dropTime = Math.max(0, x / pixelsPerSecond)
      
      // Flatten: copy all clips from the source timeline, offset to drop position
      // Find the earliest clip start in the source to compute relative offsets
      const earliestStart = sourceTimeline.clips.reduce(
        (min, c) => Math.min(min, c.startTime), Infinity
      )
      
      const newClips = sourceTimeline.clips.map(srcClip => migrateClip({
        ...srcClip,
        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        startTime: dropTime + (srcClip.startTime - earliestStart),
        // Remap trackIndex: offset by the drop track, but keep relative spacing
        trackIndex: Math.min(trackIndex + srcClip.trackIndex, tracks.length - 1),
      }))
      
      setClips(prev => [...prev, ...newClips])
      return
    }
    
    // Multi-asset drop (from multi-select drag)
    const assetIdsJson = e.dataTransfer.getData('assetIds')
    if (assetIdsJson && trackContainerRef.current) {
      try {
        const ids: string[] = JSON.parse(assetIdsJson)
        const droppedAssets = ids.map(id => assets.find(a => a.id === id)).filter(Boolean) as Asset[]
        if (droppedAssets.length > 0) {
          const rect = trackContainerRef.current.getBoundingClientRect()
          const scrollLeft = trackContainerRef.current.scrollLeft
          const x = e.clientX - rect.left + scrollLeft
          let nextStart = Math.max(0, x / pixelsPerSecond)
          pushUndo()
          const newClips: TimelineClip[] = droppedAssets.map(a => {
            const dur = a.duration || 5
            const clip: TimelineClip = {
              id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              assetId: a.id,
              type: a.type === 'video' ? 'video' : a.type === 'audio' ? 'audio' : 'image',
              startTime: nextStart,
              duration: dur,
              trimStart: 0,
              trimEnd: 0,
              speed: 1,
              reversed: false,
              muted: false,
              volume: 1,
              trackIndex,
              asset: a,
              flipH: false,
              flipV: false,
              transitionIn: { type: 'none', duration: 0.5 },
              transitionOut: { type: 'none', duration: 0.5 },
              colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
              opacity: 100,
            }
            nextStart += dur
            return clip
          })
          const newIds = new Set(newClips.map(c => c.id))
          setClips(prev => resolveOverlaps([...prev, ...newClips], newIds))
          return
        }
      } catch { /* ignore parse errors */ }
    }
    
    // Single asset drop
    const assetId = e.dataTransfer.getData('assetId')
    const assetData = e.dataTransfer.getData('asset')
    
    let asset: Asset | undefined
    if (assetData) {
      asset = JSON.parse(assetData)
    } else if (assetId) {
      asset = assets.find(a => a.id === assetId)
    }
    
    if (asset && trackContainerRef.current) {
      const rect = trackContainerRef.current.getBoundingClientRect()
      const scrollLeft = trackContainerRef.current.scrollLeft
      const x = e.clientX - rect.left + scrollLeft
      const startTime = Math.max(0, x / pixelsPerSecond)
      addClipToTimeline(asset, trackIndex, startTime)
    }
  }
  
  // --- Timeline tab handlers ---
  
  const handleAddTimeline = () => {
    if (!currentProjectId) return
    const newTl = addTimeline(currentProjectId)
    // Auto-open the new timeline tab
    if (newTl?.id) {
      setOpenTimelineIds(prev => { const next = new Set(prev); next.add(newTl.id); return next })
    }
  }
  
  const handleDeleteTimeline = (timelineId: string) => {
    if (!currentProjectId) return
    if (timelines.length <= 1) return // Can't delete the last one
    deleteTimeline(currentProjectId, timelineId)
    setTimelineContextMenu(null)
  }
  
  const handleDuplicateTimeline = (timelineId: string) => {
    if (!currentProjectId) return
    const dup = duplicateTimeline(currentProjectId, timelineId)
    // Auto-open the duplicated timeline tab
    if (dup?.id) {
      setOpenTimelineIds(prev => { const next = new Set(prev); next.add(dup.id); return next })
    }
    setTimelineContextMenu(null)
  }
  
  const handleSwitchTimeline = (timelineId: string) => {
    if (!currentProjectId || timelineId === activeTimeline?.id) return
    // Force-save current timeline before switching
    if (loadedTimelineIdRef.current) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      updateTimeline(currentProjectId, loadedTimelineIdRef.current, { clips, tracks })
    }
    loadedTimelineIdRef.current = null // Reset so the useEffect picks up the new one
    setActiveTimeline(currentProjectId, timelineId)
    // Auto-open the tab when switching to a timeline
    setOpenTimelineIds(prev => {
      if (prev.has(timelineId)) return prev
      const next = new Set(prev)
      next.add(timelineId)
      return next
    })
  }
  
  const handleCloseTimelineTab = (timelineId: string) => {
    // Remove from open tabs
    setOpenTimelineIds(prev => {
      const next = new Set(prev)
      next.delete(timelineId)
      // Must keep at least the active timeline open
      if (next.size === 0 && activeTimeline?.id) {
        next.add(activeTimeline.id)
      }
      return next
    })
    // If closing the active timeline tab, switch to another open one
    if (timelineId === activeTimeline?.id && currentProjectId) {
      const remaining = Array.from(openTimelineIds).filter(id => id !== timelineId)
      if (remaining.length > 0) {
        handleSwitchTimeline(remaining[remaining.length - 1])
      } else {
        // All tabs closed — pick the first timeline from the library
        const fallback = timelines.find(t => t.id !== timelineId)
        if (fallback) {
          handleSwitchTimeline(fallback.id)
        }
      }
    }
  }
  
  const handleStartRename = (timelineId: string, currentName: string) => {
    setRenamingTimelineId(timelineId)
    setRenameValue(currentName)
    setTimelineContextMenu(null)
    setTimeout(() => renameInputRef.current?.select(), 0)
  }
  
  const handleFinishRename = () => {
    if (renamingTimelineId && currentProjectId && renameValue.trim()) {
      renameTimeline(currentProjectId, renamingTimelineId, renameValue.trim())
    }
    setRenamingTimelineId(null)
    setRenameValue('')
  }
  
  const handleTimelineTabContextMenu = (e: React.MouseEvent, timelineId: string) => {
    e.preventDefault()
    setTimelineContextMenu({ timelineId, x: e.clientX, y: e.clientY })
  }
  
  // Close timeline context menu on click elsewhere
  useEffect(() => {
    if (!timelineContextMenu) return
    const handler = () => setTimelineContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [timelineContextMenu])
  
  // Adjust timeline context menu position to stay within viewport
  useEffect(() => {
    if (!timelineContextMenu || !timelineContextMenuRef.current) return
    const el = timelineContextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = timelineContextMenu
    let adjusted = false
    
    if (rect.right > vw - 8) { x = vw - rect.width - 8; adjusted = true }
    if (rect.bottom > vh - 8) { y = vh - rect.height - 8; adjusted = true }
    if (x < 8) { x = 8; adjusted = true }
    if (y < 8) { y = 8; adjusted = true }
    
    if (adjusted) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [timelineContextMenu])
  
  // Clip context menu handler
  const handleClipContextMenu = (e: React.MouseEvent, clip: TimelineClip) => {
    e.preventDefault()
    e.stopPropagation()
    // Select the clip if not already selected
    if (!selectedClipIds.has(clip.id)) {
      setSelectedClipIds(new Set([clip.id]))
    }
    setClipContextMenu({ clipId: clip.id, x: e.clientX, y: e.clientY })
  }
  
  // Close clip context menu on click elsewhere
  useEffect(() => {
    if (!clipContextMenu) return
    const handler = () => setClipContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [clipContextMenu])
  
  // Adjust context menu position to stay within viewport
  useEffect(() => {
    if (!clipContextMenu || !clipContextMenuRef.current) return
    const el = clipContextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = clipContextMenu
    let adjusted = false
    
    if (rect.right > vw - 8) {
      x = vw - rect.width - 8
      adjusted = true
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8
      adjusted = true
    }
    if (x < 8) { x = 8; adjusted = true }
    if (y < 8) { y = 8; adjusted = true }
    
    if (adjusted) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [clipContextMenu])
  
  // Close bin dropdown on click outside
  useEffect(() => {
    if (!binDropdownOpen) return
    const handler = () => setBinDropdownOpen(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [binDropdownOpen])
  
  // Close zoom dropdown on click outside
  useEffect(() => {
    if (!previewZoomOpen) return
    const handler = () => setPreviewZoomOpen(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [previewZoomOpen])
  
  // Close playback resolution dropdown on click outside
  useEffect(() => {
    if (!playbackResOpen) return
    const handler = () => setPlaybackResOpen(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [playbackResOpen])
  
  // Reset pan when switching to fit
  useEffect(() => {
    if (previewZoom === 'fit') setPreviewPan({ x: 0, y: 0 })
  }, [previewZoom])
  
  // Mouse wheel zoom on preview
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setPreviewZoom(prev => {
        const current = prev === 'fit' ? 100 : prev
        const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const next = Math.round(Math.min(1600, Math.max(10, current * delta)))
        return next
      })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])
  
  // Observe preview container size → compute video frame dimensions (16:9 "contain" fit)
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    const PROJECT_RATIO = 16 / 9
    const compute = () => {
      const { width, height } = el.getBoundingClientRect()
      if (width === 0 || height === 0) return
      let fw: number, fh: number
      if (width / height > PROJECT_RATIO) {
        // Container is wider → height is the constraint
        fh = height
        fw = height * PROJECT_RATIO
      } else {
        // Container is taller → width is the constraint
        fw = width
        fh = width / PROJECT_RATIO
      }
      setVideoFrameSize(prev => (prev.width === fw && prev.height === fh) ? prev : { width: fw, height: fh })
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Close asset context menu on click elsewhere
  useEffect(() => {
    if (!assetContextMenu) return
    const handler = () => setAssetContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [assetContextMenu])
  
  // Close timeline add menu on click elsewhere
  useEffect(() => {
    if (!timelineAddMenuOpen) return
    const handler = () => setTimelineAddMenuOpen(false)
    // Delay so the toggle click itself doesn't immediately close
    const timer = setTimeout(() => window.addEventListener('click', handler), 0)
    return () => { clearTimeout(timer); window.removeEventListener('click', handler) }
  }, [timelineAddMenuOpen])
  
  // Adjust asset context menu position to stay within viewport
  useEffect(() => {
    if (!assetContextMenu || !assetContextMenuRef.current) return
    const el = assetContextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = assetContextMenu
    let adjusted = false
    if (rect.right > vw - 8) { x = vw - rect.width - 8; adjusted = true }
    if (rect.bottom > vh - 8) { y = vh - rect.height - 8; adjusted = true }
    if (x < 8) { x = 8; adjusted = true }
    if (y < 8) { y = 8; adjusted = true }
    if (adjusted) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [assetContextMenu])
  
  // Close take context menu on click elsewhere
  useEffect(() => {
    if (!takeContextMenu) return
    const handler = () => setTakeContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [takeContextMenu])
  
  // Adjust take context menu position
  useEffect(() => {
    if (!takeContextMenu || !takeContextMenuRef.current) return
    const el = takeContextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = takeContextMenu
    let adjusted = false
    if (rect.right > vw - 8) { x = vw - rect.width - 8; adjusted = true }
    if (rect.bottom > vh - 8) { y = vh - rect.height - 8; adjusted = true }
    if (x < 8) { x = 8; adjusted = true }
    if (y < 8) { y = 8; adjusted = true }
    if (adjusted) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [takeContextMenu])
  
  // Close bin context menu on click elsewhere
  useEffect(() => {
    if (!binContextMenu) return
    const handler = () => setBinContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [binContextMenu])
  
  // Adjust bin context menu position to stay within viewport
  useEffect(() => {
    if (!binContextMenu || !binContextMenuRef.current) return
    const el = binContextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = binContextMenu
    let adjusted = false
    if (rect.right > vw - 8) { x = vw - rect.width - 8; adjusted = true }
    if (rect.bottom > vh - 8) { y = vh - rect.height - 8; adjusted = true }
    if (x < 8) { x = 8; adjusted = true }
    if (y < 8) { y = 8; adjusted = true }
    if (adjusted) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [binContextMenu])
  
  // Focus new bin input when creating
  useEffect(() => {
    if (creatingBin) {
      setTimeout(() => newBinInputRef.current?.focus(), 0)
    }
  }, [creatingBin])
  
  // Timeline background right-click (paste)
  const handleTimelineBgContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    // Set playhead to clicked position, then open menu with Paste option
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const scrollLeft = (e.currentTarget as HTMLElement).scrollLeft || 0
    const clickX = e.clientX - rect.left + scrollLeft
    const clickTime = Math.max(0, clickX / pixelsPerSecond)
    setCurrentTime(clickTime)
    // Use a special "no clip" context menu: clipId = '' signals background click
    setClipContextMenu({ clipId: '', x: e.clientX, y: e.clientY })
  }
  
  // --- Regeneration ---
  
  const handleRegenerate = useCallback(async (assetId: string, clipId?: string) => {
    if (!currentProjectId || isRegenerating) return
    const asset = assets.find(a => a.id === assetId)
    if (!asset) return
    
    setRegeneratingAssetId(assetId)
    setRegeneratingClipId(clipId || null)
    
    // Mark the clip as regenerating for visual feedback
    if (clipId) {
      setClips(prev => prev.map(c => c.id === clipId ? { ...c, isRegenerating: true } : c))
    }
    
    // If the asset has no generationParams (imported asset), auto-generate a prompt from the first frame via Gemini
    let params = asset.generationParams
    if (!params) {
      try {
        const { extractFrameAsBase64, extractImageAsBase64 } = await import('../lib/thumbnails')
        const clipSrc = resolveClipSrc(clips.find(c => c.id === clipId) || { asset, assetId: asset.id } as any)
        let frameBase64 = ''
        if (asset.type === 'video' && clipSrc) {
          frameBase64 = await extractFrameAsBase64(clipSrc, 0.1)
        } else if (asset.type === 'image' && clipSrc) {
          frameBase64 = await extractImageAsBase64(clipSrc)
        }
        
        if (frameBase64) {
          // Ask Gemini to describe the frame
          const backendUrl = await window.electronAPI.getBackendUrl()
          const resp = await fetch(`${backendUrl}/api/suggest-gap-prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gapDuration: asset.duration || 5,
              mode: asset.type === 'image' ? 'text-to-image' : 'text-to-video',
              beforePrompt: '',
              afterPrompt: '',
              beforeFrame: frameBase64,
              afterFrame: '',
            }),
          })
          if (resp.ok) {
            const data = await resp.json()
            if (data.suggested_prompt) {
              params = {
                mode: asset.type === 'image' ? 'text-to-image' : 'image-to-video',
                prompt: data.suggested_prompt,
                model: 'fast',
                duration: asset.duration || 5,
                resolution: asset.resolution || '768x512',
                fps: 24,
                audio: false,
                cameraMotion: 'none',
                inputImageUrl: asset.type === 'video' ? clipSrc : undefined,
              }
              // Save the generated params back to the asset so future regenerations are instant
              // (update the asset in project context)
              if (asset.id && currentProjectId) {
                updateAsset(currentProjectId, asset.id, { generationParams: params })
              }
            }
          }
        }
      } catch (err) {
        console.warn('Failed to auto-generate prompt for imported asset:', err)
      }
      
      if (!params) {
        // Still no params — can't regenerate
        setRegeneratingAssetId(null)
        setRegeneratingClipId(null)
        if (clipId) {
          setClips(prev => prev.map(c => c.id === clipId ? { ...c, isRegenerating: false } : c))
        }
        return
      }
    }
    
    if (params.mode === 'text-to-image') {
      regenGenerateImage(params.prompt, {
        model: params.model as 'fast' | 'pro',
        duration: params.duration,
        resolution: params.resolution,
        fps: params.fps,
        audio: params.audio,
        cameraMotion: params.cameraMotion,
        imageAspectRatio: params.imageAspectRatio || '16:9',
        imageSteps: params.imageSteps || 4,
        variations: 1,
      })
    } else {
      // For video generation (T2V or I2V)
      let imageFile: File | null = null
      
      // If I2V and we have an input image URL, convert to File
      if (params.mode === 'image-to-video' && params.inputImageUrl) {
        try {
          const imgUrl = params.inputImageUrl
          if (imgUrl.startsWith('blob:') || imgUrl.startsWith('http')) {
            const response = await fetch(imgUrl)
            const blob = await response.blob()
            imageFile = new File([blob], 'input-image.png', { type: blob.type })
          } else if (imgUrl.startsWith('file:///') || imgUrl.startsWith('file://')) {
            // Load via canvas for file:// URLs
            let filePath = imgUrl.startsWith('file:///') ? imgUrl.slice(8) : imgUrl.slice(7)
            filePath = decodeURIComponent(filePath)
            const img = document.createElement('img')
            img.crossOrigin = 'anonymous'
            const blob = await new Promise<Blob>((resolve, reject) => {
              img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                const ctx = canvas.getContext('2d')
                if (!ctx) { reject(new Error('No canvas context')); return }
                ctx.drawImage(img, 0, 0)
                canvas.toBlob((b) => {
                  if (b) resolve(b)
                  else reject(new Error('Failed to convert'))
                }, 'image/png')
              }
              img.onerror = () => reject(new Error('Failed to load'))
              img.src = imgUrl
            })
            imageFile = new File([blob], 'input-image.png', { type: 'image/png' })
          }
        } catch (e) {
          console.warn('Failed to load input image for regeneration:', e)
        }
      }
      
      regenGenerate(params.prompt, imageFile, {
        model: params.model as 'fast' | 'pro',
        duration: params.duration,
        resolution: params.resolution,
        fps: params.fps,
        audio: params.audio,
        cameraMotion: params.cameraMotion,
        imageAspectRatio: params.imageAspectRatio || '16:9',
        imageSteps: params.imageSteps || 4,
      })
    }
  }, [currentProjectId, isRegenerating, assets, clips, regenGenerate, regenGenerateImage, resolveClipSrc, updateAsset])
  
  const handleCancelRegeneration = useCallback(() => {
    regenCancel()
    // Clear the regenerating visual on the clip
    if (regeneratingClipId) {
      setClips(prev => prev.map(c => c.id === regeneratingClipId ? { ...c, isRegenerating: false } : c))
    }
    setRegeneratingAssetId(null)
    setRegeneratingClipId(null)
    regenReset()
  }, [regenCancel, regenReset, regeneratingClipId])
  
  // Handle regeneration video result
  useEffect(() => {
    if (regenVideoUrl && regenVideoPath && regeneratingAssetId && currentProjectId && !isRegenerating) {
      addTakeToAsset(currentProjectId, regeneratingAssetId, {
        url: regenVideoUrl,
        path: regenVideoPath,
        createdAt: Date.now(),
      })
      
      // Update clip to use the new take and clear regenerating flag
      if (regeneratingClipId) {
        setClips(prev => prev.map(c => {
          if (c.id !== regeneratingClipId) return c
          const asset = assets.find(a => a.id === c.assetId)
          const newTakeIdx = asset?.takes ? asset.takes.length : 1 // The new take will be at this index
          return { ...c, isRegenerating: false, takeIndex: newTakeIdx }
        }))
      }
      
      setRegeneratingAssetId(null)
      setRegeneratingClipId(null)
      regenReset()
    }
  }, [regenVideoUrl, regenVideoPath, regeneratingAssetId, currentProjectId, isRegenerating])
  
  // Handle regeneration image result
  useEffect(() => {
    if (regenImageUrl && regeneratingAssetId && currentProjectId && !isRegenerating) {
      addTakeToAsset(currentProjectId, regeneratingAssetId, {
        url: regenImageUrl,
        path: regenImageUrl,
        createdAt: Date.now(),
      })
      
      if (regeneratingClipId) {
        setClips(prev => prev.map(c => {
          if (c.id !== regeneratingClipId) return c
          const asset = assets.find(a => a.id === c.assetId)
          const newTakeIdx = asset?.takes ? asset.takes.length : 1
          return { ...c, isRegenerating: false, takeIndex: newTakeIdx }
        }))
      }
      
      setRegeneratingAssetId(null)
      setRegeneratingClipId(null)
      regenReset()
    }
  }, [regenImageUrl, regeneratingAssetId, currentProjectId, isRegenerating])
  
  // --- Upscale ---
  
  // Upscale a single clip's video
  const handleUpscaleClip = useCallback(async (clipId: string) => {
    const clip = clips.find(c => c.id === clipId)
    if (!clip || clip.type !== 'video') return
    
    // Get the video path from the asset
    const asset = clip.assetId ? assets.find(a => a.id === clip.assetId) : null
    let videoPath: string | null = null
    
    if (asset) {
      // Check if using a specific take
      if (asset.takes && asset.takes.length > 0 && clip.takeIndex !== undefined) {
        const idx = Math.max(0, Math.min(clip.takeIndex, asset.takes.length - 1))
        videoPath = asset.takes[idx].path
      } else {
        videoPath = asset.path
      }
    }
    
    if (!videoPath) return
    
    // Mark clip as upscaling
    setUpscalingClipIds(prev => new Set(prev).add(clipId))
    
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const response = await fetch(`${backendUrl}/api/upscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_path: videoPath }),
      })
      
      const data = await response.json()
      
      const upscaledPath = data.upscaled_path || data.video_path
      if (response.ok && data.status === 'complete' && upscaledPath) {
        const pathNormalized = upscaledPath.replace(/\\/g, '/')
        const upscaledUrl = pathNormalized.startsWith('/') ? `file://${pathNormalized}` : `file:///${pathNormalized}`
        
        // Add as a new take on the asset so the user can compare
        if (asset && currentProjectId) {
          // Calculate the new take index BEFORE calling addTakeToAsset
          // If takes already exist, the new take will be appended at the end
          // If no takes exist, addTakeToAsset initializes [original, newTake], so index = 1
          const newTakeIdx = asset.takes ? asset.takes.length : 1
          
          addTakeToAsset(currentProjectId, asset.id, {
            url: upscaledUrl,
            path: upscaledPath,
            createdAt: Date.now(),
          })
          // Pre-populate resolution cache for the upscaled URL so it shows immediately
          // (the probing effect will also detect and probe it if this data is missing)
          if (data.width && data.height) {
            setResolutionCache(prev => ({ ...prev, [upscaledUrl]: { width: data.width, height: data.height } }))
          }
          // Update clip to use the new upscaled take
          setClips(prev => prev.map(c => {
            if (c.id !== clipId) return c
            return { ...c, takeIndex: newTakeIdx }
          }))
        }
      } else {
        console.error('Upscale failed:', data.error || 'Unknown error')
      }
    } catch (error) {
      console.error('Upscale error:', error)
    } finally {
      setUpscalingClipIds(prev => {
        const next = new Set(prev)
        next.delete(clipId)
        return next
      })
    }
  }, [clips, assets, currentProjectId, addTakeToAsset])
  
  // Upscale all video clips in a timeline
  const handleUpscaleTimeline = useCallback(async (timelineId: string, mode: 'duplicate' | 'replace') => {
    if (!currentProjectId) return
    setShowUpscaleDialog(null)
    
    // Save current timeline first
    if (loadedTimelineIdRef.current) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      updateTimeline(currentProjectId, loadedTimelineIdRef.current, { clips, tracks })
    }
    
    let targetTimelineId = timelineId
    let targetClips = [...clips]
    
    if (mode === 'duplicate') {
      // Duplicate the timeline first
      const newTimeline = duplicateTimeline(currentProjectId, timelineId)
      if (!newTimeline) return
      // Rename it
      renameTimeline(currentProjectId, newTimeline.id, `${activeTimeline?.name || 'Timeline'} (Upscaled)`)
      // Switch to the new timeline
      targetTimelineId = newTimeline.id
      targetClips = [...newTimeline.clips]
      
      // Switch to the duplicated timeline so user can see progress
      loadedTimelineIdRef.current = null
      setActiveTimeline(currentProjectId, targetTimelineId)
      setOpenTimelineIds(prev => { const next = new Set(prev); next.add(targetTimelineId); return next })
      // Wait a tick for state to settle
      await new Promise(r => setTimeout(r, 100))
    }
    
    // Find all video clips that can be upscaled
    const videoClips = targetClips.filter(c => c.type === 'video' && c.assetId)
    if (videoClips.length === 0) return
    
    setUpscaleTimelineProgress({ current: 0, total: videoClips.length, active: true })
    
    // Track how many takes have been added per asset during this batch,
    // so we can compute the correct take index even though the context
    // assets array is stale within this async loop.
    const addedTakesPerAsset: Record<string, number> = {}
    
    for (let i = 0; i < videoClips.length; i++) {
      const clip = videoClips[i]
      setUpscaleTimelineProgress({ current: i + 1, total: videoClips.length, active: true })
      
      // Get the video path
      const asset = clip.assetId ? assets.find(a => a.id === clip.assetId) : null
      let videoPath: string | null = null
      if (asset) {
        if (asset.takes && asset.takes.length > 0 && clip.takeIndex !== undefined) {
          const idx = Math.max(0, Math.min(clip.takeIndex, asset.takes.length - 1))
          videoPath = asset.takes[idx].path
        } else {
          videoPath = asset.path
        }
      }
      
      if (!videoPath || !asset) continue
      
      // Mark clip as upscaling
      setUpscalingClipIds(prev => new Set(prev).add(clip.id))
      
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const response = await fetch(`${backendUrl}/api/upscale`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_path: videoPath }),
        })
        
        const data = await response.json()
        
        const upscaledPath = data.upscaled_path || data.video_path
        if (response.ok && data.status === 'complete' && upscaledPath) {
          const pathNormalized = upscaledPath.replace(/\\/g, '/')
          const upscaledUrl = pathNormalized.startsWith('/') ? `file://${pathNormalized}` : `file:///${pathNormalized}`
          
          // Calculate the new take index BEFORE adding, accounting for any
          // takes we've already added to this same asset in this batch
          const baseTakeCount = asset.takes ? asset.takes.length : 1 // 1 because addTakeToAsset creates [original, new] if no takes
          const alreadyAdded = addedTakesPerAsset[asset.id] || 0
          const newTakeIdx = baseTakeCount + alreadyAdded
          addedTakesPerAsset[asset.id] = alreadyAdded + 1
          
          // Add as new take
          addTakeToAsset(currentProjectId, asset.id, {
            url: upscaledUrl,
            path: upscaledPath,
            createdAt: Date.now(),
          })
          // Pre-populate resolution cache for the upscaled URL
          if (data.width && data.height) {
            setResolutionCache(prev => ({ ...prev, [upscaledUrl]: { width: data.width, height: data.height } }))
          }
          // Update clip to use the new upscaled take
          setClips(prev => prev.map(c => {
            if (c.id !== clip.id) return c
            return { ...c, takeIndex: newTakeIdx }
          }))
        }
      } catch (error) {
        console.error(`Upscale error for clip ${clip.id}:`, error)
      } finally {
        setUpscalingClipIds(prev => {
          const next = new Set(prev)
          next.delete(clip.id)
          return next
        })
      }
    }
    
    // Force an immediate save of the updated clips to the context.
    // We read the latest local clips via a state-reader pattern to ensure
    // all the setClips updates from the loop have been applied.
    await new Promise<void>(resolve => {
      setClips(currentClips => {
        // Save to context — currentClips has all the updated takeIndex values
        updateTimeline(currentProjectId, targetTimelineId, { clips: currentClips })
        resolve()
        return currentClips // no mutation, just reading
      })
    })
    
    setUpscaleTimelineProgress(null)
  }, [currentProjectId, clips, tracks, assets, activeTimeline, duplicateTimeline, renameTimeline, setActiveTimeline, updateTimeline, addTakeToAsset])
  
  // Handle take navigation on a clip
  const handleClipTakeChange = useCallback((clipId: string, direction: 'prev' | 'next') => {
    setClips(prev => prev.map(c => {
      if (c.id !== clipId || !c.asset) return c
      const asset = assets.find(a => a.id === c.assetId)
      if (!asset?.takes || asset.takes.length <= 1) return c
      
      const currentIdx = c.takeIndex ?? (asset.activeTakeIndex ?? asset.takes.length - 1)
      let newIdx = direction === 'prev' ? currentIdx - 1 : currentIdx + 1
      newIdx = Math.max(0, Math.min(newIdx, asset.takes.length - 1))
      
      return { ...c, takeIndex: newIdx }
    }))
  }, [assets])
  
  // Delete the currently displayed take from a clip's asset
  const handleDeleteTake = useCallback((clipId: string) => {
    if (!currentProjectId) return
    const clip = clips.find(c => c.id === clipId)
    if (!clip?.assetId) return
    const asset = assets.find(a => a.id === clip.assetId)
    if (!asset?.takes || asset.takes.length <= 1) return // Can't delete the only take
    
    const takeIdx = clip.takeIndex ?? (asset.activeTakeIndex ?? asset.takes.length - 1)
    
    // Delete the take from the asset in context
    deleteTakeFromAsset(currentProjectId, asset.id, takeIdx)
    
    // Update ALL clips that reference this asset: adjust their takeIndex
    setClips(prev => prev.map(c => {
      if (c.assetId !== asset.id) return c
      const cIdx = c.takeIndex ?? (asset.activeTakeIndex ?? asset.takes!.length - 1)
      if (cIdx === takeIdx) {
        // This clip was showing the deleted take → move to the previous one (or 0)
        return { ...c, takeIndex: Math.max(0, takeIdx - 1) }
      } else if (cIdx > takeIdx) {
        // This clip was showing a take after the deleted one → shift down by 1
        return { ...c, takeIndex: cIdx - 1 }
      }
      return c
    }))
  }, [clips, assets, currentProjectId, deleteTakeFromAsset])
  
  // Get the live asset for a clip (from project context, not stale clip.asset)
  const getLiveAsset = useCallback((clip: TimelineClip) => {
    if (!clip.assetId) return clip.asset
    return assets.find(a => a.id === clip.assetId) || clip.asset
  }, [assets])
  
  // Get the effective URL for a clip (considering its take index)
  const getClipUrl = useCallback((clip: TimelineClip): string | null => {
    if (!clip.assetId) return clip.importedUrl || null
    const asset = assets.find(a => a.id === clip.assetId)
    if (!asset) return null
    
    if (asset.takes && asset.takes.length > 0 && clip.takeIndex !== undefined) {
      const idx = Math.max(0, Math.min(clip.takeIndex, asset.takes.length - 1))
      return asset.takes[idx].url
    }
    return asset.url
  }, [assets])

  // --- Resolution probing: detect actual video/image dimensions from the linked file ---
  // Track which URLs are currently being probed (to avoid duplicate concurrent probes)
  const probingUrlsRef = useRef<Set<string>>(new Set())
  // Build a map of clip URLs on every render so the effect can detect changes
  const clipUrlMap = useMemo(() => {
    const map: Record<string, string> = {}
    clips.forEach(clip => {
      if (clip.type === 'audio') return
      const url = getClipUrl(clip) || clip.asset?.url
      if (url) map[clip.id] = url
    })
    return map
  }, [clips, getClipUrl])
  
  useEffect(() => {
    // Collect all unique URLs that clips currently point to
    const urlsToProbe = new Set<string>()
    Object.values(clipUrlMap).forEach(url => {
      // Skip if already cached with valid dims, or currently probing
      const cached = resolutionCache[url]
      if (cached && cached.width > 0 && cached.height > 0) return
      if (probingUrlsRef.current.has(url)) return
      urlsToProbe.add(url)
    })
    
    urlsToProbe.forEach(url => {
      probingUrlsRef.current.add(url)
      
      // Determine if this is a video or image based on the clip(s) using it
      const isVideo = clips.some(c => 
        (clipUrlMap[c.id] === url) && (c.type === 'video' || c.asset?.type === 'video')
      )
      
      if (isVideo) {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        video.onloadedmetadata = () => {
          setResolutionCache(prev => ({ ...prev, [url]: { width: video.videoWidth, height: video.videoHeight } }))
          probingUrlsRef.current.delete(url)
          video.src = ''
        }
        video.onerror = () => { probingUrlsRef.current.delete(url); video.src = '' }
        video.src = url
      } else {
        const img = new window.Image()
        img.onload = () => {
          setResolutionCache(prev => ({ ...prev, [url]: { width: img.naturalWidth, height: img.naturalHeight } }))
          probingUrlsRef.current.delete(url)
        }
        img.onerror = () => { probingUrlsRef.current.delete(url) }
        img.src = url
      }
    })
  }, [clipUrlMap, resolutionCache, clips])
  
  // Helper: classify height into resolution category + color
  const classifyResolution = useCallback((h: number, w?: number): { label: string; color: string; height: number } => {
    const dims = w ? ` (${w}×${h})` : ''
    if (h >= 2160) return { label: `4K${dims}`, color: '#22c55e', height: h }       // green-500
    if (h >= 1080) return { label: `1080p${dims}`, color: '#3b82f6', height: h }    // blue-500
    if (h >= 720)  return { label: `720p${dims}`, color: '#f59e0b', height: h }     // amber-500
    return { label: `${h}p${dims}`, color: '#ef4444', height: h }                    // red-500
  }, [])
  
  // Helper: get resolution category and color for a clip based on its CURRENTLY DISPLAYED take
  const getClipResolution = useCallback((clip: TimelineClip): { label: string; color: string; height: number } | null => {
    if (clip.type === 'audio') return null
    const url = getClipUrl(clip) || clip.asset?.url
    if (!url) return null
    const dims = resolutionCache[url]
    // If we have actual probed dimensions, use them (skip 0,0 which means "probing in progress")
    if (dims && (dims.width > 0 || dims.height > 0)) {
      return classifyResolution(dims.height, dims.width)
    }
    // Fallback: use the generation resolution from the LIVE asset in context
    // (not the stale clip.asset snapshot which never updates)
    const liveAsset = clip.assetId ? assets.find(a => a.id === clip.assetId) : clip.asset
    const res = liveAsset?.resolution
    if (!res || res === 'imported') return null
    const h = parseInt(res)
    if (isNaN(h)) return null
    return classifyResolution(h)
  }, [getClipUrl, resolutionCache, assets, classifyResolution])

  // --- Render ---
  
  return (
    <div className="h-full flex overflow-hidden">
      {/* Left Panel - Asset Library & Timelines */}
      <div className="flex-shrink-0 border-r border-zinc-800 flex flex-col" style={{ width: layout.leftPanelWidth }}>
        {/* Assets Section */}
        <div className="flex flex-col min-h-0" style={layout.assetsHeight > 0 ? { height: layout.assetsHeight } : { flex: '1 1 60%' }}>
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
            
            {/* Type filter */}
            <div className="flex gap-1 bg-zinc-900 rounded-lg p-0.5">
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
                      ref={newBinInputRef}
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
              ref={fileInputRef}
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
            ref={assetGridRef}
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
            
            {/* Multi-select action bar */}
            {selectedAssetIds.size > 0 && (
              <div className="flex items-center gap-1 mb-2 px-1.5 py-1 rounded-md bg-zinc-800/90 border border-zinc-700/60 shadow-lg">
                <span className="text-[10px] text-zinc-400 font-medium tabular-nums pl-1 mr-1 flex-shrink-0 whitespace-nowrap">
                  {selectedAssetIds.size} selected
                </span>
                <div className="w-px h-4 bg-zinc-700 flex-shrink-0" />
                {/* Move to bin */}
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setBinDropdownOpen(prev => !prev) }}
                    className={`h-6 px-1.5 rounded flex items-center gap-1 text-[10px] whitespace-nowrap transition-colors ${
                      binDropdownOpen ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60'
                    }`}
                    title="Move to bin"
                  >
                    <Folder className="h-3 w-3 flex-shrink-0" />
                    <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" />
                  </button>
                  {binDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl py-1 z-50 min-w-[140px]">
                      <div className="px-3 py-1 text-[9px] text-zinc-500 font-semibold uppercase tracking-wider">Move to Bin</div>
                      <button
                        onClick={() => {
                          if (currentProjectId) {
                            pushAssetUndoRef.current()
                            selectedAssetIds.forEach(id => updateAsset(currentProjectId, id, { bin: undefined }))
                          }
                          setSelectedAssetIds(new Set())
                          setBinDropdownOpen(false)
                        }}
                        className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 text-[10px] flex items-center gap-2"
                      >
                        <X className="h-3 w-3 text-zinc-500" />
                        Remove from Bin
                      </button>
                      {bins.map(bin => (
                        <button
                          key={bin}
                          onClick={() => {
                            if (currentProjectId) {
                              pushAssetUndoRef.current()
                              selectedAssetIds.forEach(id => updateAsset(currentProjectId, id, { bin }))
                            }
                            setSelectedAssetIds(new Set())
                            setBinDropdownOpen(false)
                          }}
                          className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 text-[10px] flex items-center gap-2"
                        >
                          <Folder className="h-3 w-3 text-zinc-500" />
                          {bin}
                        </button>
                      ))}
                      <div className="h-px bg-zinc-700 my-0.5" />
                      <button
                        onClick={() => {
                          const name = prompt('New bin name:')
                          if (name?.trim() && currentProjectId) {
                            pushAssetUndoRef.current()
                            selectedAssetIds.forEach(id => updateAsset(currentProjectId, id, { bin: name.trim() }))
                            setSelectedAssetIds(new Set())
                          }
                          setBinDropdownOpen(false)
                        }}
                        className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 text-[10px] flex items-center gap-2"
                      >
                        <FolderPlus className="h-3 w-3 text-zinc-500" />
                        New Bin...
                      </button>
                    </div>
                  )}
                </div>
                {/* Group as takes */}
                {selectedAssetIds.size >= 2 && (
                  <button
                    onClick={() => {
                      if (!currentProjectId) return
                      const selectedAssets = assets.filter(a => selectedAssetIds.has(a.id))
                      if (selectedAssets.length < 2) return
                      pushAssetUndoRef.current()
                      const primary = selectedAssets[0]
                      const newTakes = selectedAssets.map(a => ({
                        url: a.url, path: a.path, thumbnail: a.thumbnail, createdAt: a.createdAt,
                      }))
                      updateAsset(currentProjectId, primary.id, { takes: newTakes, activeTakeIndex: 0 })
                      selectedAssets.slice(1).forEach(a => deleteAsset(currentProjectId, a.id))
                      setSelectedAssetIds(new Set())
                    }}
                    className="h-6 px-1.5 rounded text-[10px] text-zinc-400 hover:text-violet-300 hover:bg-violet-600/20 transition-colors flex items-center gap-1 whitespace-nowrap"
                    title="Merge selected assets into one asset with multiple takes"
                  >
                    <GitMerge className="h-3 w-3 flex-shrink-0" />
                    <span className="hidden min-[400px]:inline">Group</span>
                  </button>
                )}
                {/* Delete selected */}
                <button
                  onClick={() => {
                    if (currentProjectId) {
                      pushAssetUndoRef.current()
                      selectedAssetIds.forEach(id => deleteAsset(currentProjectId, id))
                    }
                    setSelectedAssetIds(new Set())
                  }}
                  className="h-6 px-1.5 rounded text-[10px] text-zinc-400 hover:text-red-400 hover:bg-red-900/20 transition-colors flex items-center gap-1 whitespace-nowrap"
                  title="Delete selected assets"
                >
                  <Trash2 className="h-3 w-3 flex-shrink-0" />
                </button>
                <div className="flex-1" />
                {/* Clear selection */}
                <button
                  onClick={() => setSelectedAssetIds(new Set())}
                  className="h-6 w-6 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-zinc-700/60 transition-colors flex-shrink-0"
                  title="Clear selection (Esc)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
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
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {filteredAssets.map(asset => (
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
                      // If multi-selected, drag all selected asset ids
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
                        // Toggle individual asset in selection
                        setSelectedAssetIds(prev => {
                          const next = new Set(prev)
                          if (next.has(asset.id)) next.delete(asset.id)
                          else next.add(asset.id)
                          return next
                        })
                      } else if (e.shiftKey && selectedAssetIds.size > 0) {
                        // Range select: from last selected to this one
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
                        // Single click: select only this asset (deselect others)
                        if (selectedAssetIds.has(asset.id) && selectedAssetIds.size === 1) {
                          setSelectedAssetIds(new Set()) // toggle off if already the only selection
                        } else {
                          setSelectedAssetIds(new Set([asset.id]))
                        }
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      // Double-click: if asset has takes, drill into takes view; otherwise add to timeline
                      if (asset.takes && asset.takes.length > 1) {
                        setTakesViewAssetId(asset.id)
                        setSelectedAssetIds(new Set())
                      } else {
                        addClipToTimeline(asset, 0)
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      // If right-clicking an unselected asset, select just it
                      if (!selectedAssetIds.has(asset.id)) {
                        setSelectedAssetIds(new Set([asset.id]))
                      }
                      setAssetContextMenu({ assetId: asset.id, x: e.clientX, y: e.clientY })
                    }}
                  >
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
                    {/* Selected overlay */}
                    {selectedAssetIds.has(asset.id) && (
                      <div className="absolute inset-0 bg-violet-600/25 pointer-events-none z-[1]" />
                    )}
                    {/* Hover overlay - only when not selected */}
                    {!selectedAssetIds.has(asset.id) && (
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none" />
                    )}
                    {/* Selection checkbox - always visible when anything is selected or on hover */}
                    <div
                      className={`absolute top-1.5 left-1.5 w-5 h-5 rounded border-2 flex items-center justify-center z-10 transition-all ${
                        selectedAssetIds.has(asset.id)
                          ? 'bg-violet-500 border-violet-400 opacity-100 scale-100'
                          : selectedAssetIds.size > 0
                            ? 'bg-zinc-900/80 border-zinc-500 opacity-100 scale-100'
                            : 'bg-zinc-900/80 border-zinc-500 opacity-0 group-hover:opacity-70 scale-90 group-hover:scale-100'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedAssetIds(prev => {
                          const next = new Set(prev)
                          if (next.has(asset.id)) next.delete(asset.id)
                          else next.add(asset.id)
                          return next
                        })
                      }}
                    >
                      {selectedAssetIds.has(asset.id) && (
                        <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    {/* Top-right buttons: regenerate + delete */}
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
                    {/* Regenerating overlay */}
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
                    {/* Takes navigator - always visible if asset has multiple takes */}
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
                    {/* Bin badge */}
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
                ))}
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
        <div className="flex flex-col min-h-0" style={layout.assetsHeight > 0 ? { flex: '1 1 0%' } : { flex: '0 1 40%', minHeight: 100 }}>
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
      
      {/* Left resize handle */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-violet-500/40 active:bg-violet-500/60 transition-colors relative group z-10"
        onMouseDown={(e) => handleResizeDragStart('left', e)}
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
      </div>
      
      {/* Main Editor Area */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Preview */}
        <div
          ref={previewContainerRef}
          className="flex-1 relative overflow-hidden min-h-0 min-w-0"
          style={{ backgroundColor: '#333', ...(previewZoom !== 'fit' ? { cursor: 'grab' } : {}) }}
          onMouseDown={(e) => {
            // Allow panning when zoomed: middle-click always, left-click when zoomed in
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
                transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom / 100})`,
                transformOrigin: 'center center',
              } : undefined}
            >
              {/* Video frame wrapper — black bg with exact 16:9 dimensions so the gray
                  canvas area is visible outside the frame, like in Premiere/DaVinci */}
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
                    {/* Outgoing clip (bottom layer) */}
                    {outgoing.asset?.type === 'video' ? (
                      <video
                        ref={dissolveOutVideoRef}
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
                    
                    {/* Incoming clip (top layer) */}
                    {incoming.asset?.type === 'video' ? (
                      <video
                        ref={previewVideoRef}
                        key={`dissolve-in-${incoming.id}`}
                        src={getClipUrl(incoming) || incoming.asset.url}
                        className="absolute inset-0 w-full h-full object-contain"
                        style={inStyle}
                        playsInline
                      />
                    ) : incoming.asset?.type === 'image' ? (
                      <img
                        ref={previewImageRef}
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
                  {/* Transition background overlay (fade-to-black / fade-to-white only) */}
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
                  {/* Video pool container — pool <video> elements are appended here via DOM */}
                  <div 
                    id="video-pool-container"
                    className={`w-full h-full relative ${activeClip?.asset?.type !== 'video' ? 'hidden' : ''}`}
                    style={activeClip?.asset?.type === 'video' ? getClipEffectStyles(activeClip, clipPlaybackOffset) : undefined}
                  />
                  
                  {activeClip?.asset?.type === 'image' && (
                    <img
                      ref={previewImageRef}
                      src={getClipUrl(activeClip) || activeClip.asset.url}
                      alt=""
                      className="w-full h-full object-contain"
                      style={getClipEffectStyles(activeClip, clipPlaybackOffset)}
                    />
                  )}
                  
                  {!activeClip && (() => {
                    // Check if there's audio playing even though no video/image is visible
                    const audioAtPlayhead = clips.filter(c =>
                      c.type === 'audio' &&
                      currentTime >= c.startTime &&
                      currentTime < c.startTime + c.duration
                    )
                    return audioAtPlayhead.length > 0 ? (
                      <div className="text-center">
                        <div className="w-20 h-20 rounded-full bg-emerald-900/30 border border-emerald-700/30 flex items-center justify-center mx-auto mb-3 animate-pulse">
                          <Music className="h-10 w-10 text-emerald-400" />
                        </div>
                        <p className="text-emerald-400 text-sm font-medium">Audio Playing</p>
                        <p className="text-zinc-500 text-xs mt-1">
                          {audioAtPlayhead.map(c => c.asset?.path || c.importedName || 'Audio').join(', ')}
                        </p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                          <Video className="h-8 w-8 text-zinc-600" />
                        </div>
                        <p className="text-zinc-500 text-sm">No clip at playhead</p>
                        <p className="text-zinc-600 text-xs mt-1">Move playhead over a clip to preview</p>
                      </div>
                    )
                  })()}
                </>
              )}
              
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
                // Calculate bar size based on container vs target aspect ratio.
                // Wider target (e.g. 2.35:1 on 16:9) → black bars on top/bottom (letterbox).
                // Taller target (e.g. 4:3 on 16:9) → black bars on left/right (pillarbox).
                const containerRatio = 16 / 9 // assume 16:9 preview
                const targetRatio = activeLetterbox.ratio
                if (targetRatio >= containerRatio) {
                  // Letterbox: target is wider → black bars on top and bottom
                  // The visible height fraction = containerRatio / targetRatio
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
                  // Pillarbox: target is taller → bars on left and right
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
              
              {previewZoom === 'fit' ? (
                <button
                  onClick={() => { setShuttleSpeed(0); setIsPlaying(!isPlaying) }}
                  className="absolute inset-0 flex items-center justify-center group z-20"
                >
                  <div className={`p-4 rounded-full bg-black/50 transition-opacity ${
                    isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
                  }`}>
                    {isPlaying ? <Pause className="h-8 w-8 text-white" /> : <Play className="h-8 w-8 text-white ml-1" />}
                  </div>
                </button>
              ) : (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
                  onDoubleClick={(e) => { e.stopPropagation(); setShuttleSpeed(0); setIsPlaying(!isPlaying) }}
                >
                  <div className={`p-4 rounded-full bg-black/50 transition-opacity pointer-events-auto cursor-pointer ${
                    isPlaying ? 'opacity-0 hover:opacity-100' : 'opacity-100'
                  }`}
                    onClick={() => { setShuttleSpeed(0); setIsPlaying(!isPlaying) }}
                  >
                    {isPlaying ? <Pause className="h-8 w-8 text-white" /> : <Play className="h-8 w-8 text-white ml-1" />}
                  </div>
                </div>
              )}
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
          </div>
        </div>
        
        {/* Timeline Controls */}
        <div className="h-12 bg-zinc-900 border-t border-zinc-800 flex items-center px-4 gap-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentTime(0)}>
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { setShuttleSpeed(0); setIsPlaying(!isPlaying) }}
              className="h-8 w-8"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setShuttleSpeed(0); setIsPlaying(false) }}>
              <Square className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentTime(totalDuration)}>
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>
          
          <div className="w-px h-6 bg-zinc-700" />
          
          {/* In/Out controls */}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${inPoint !== null ? 'text-yellow-400' : 'text-zinc-500'}`}
              onClick={() => setInPoint(prev => prev !== null && Math.abs(prev - currentTime) < 0.01 ? null : currentTime)}
              title={inPoint !== null ? `In: ${formatTime(inPoint)} (I to move, click to clear)` : 'Set In point (I)'}
            >
              {/* Mark In bracket icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="7,4 4,4 4,20 7,20" />
                <line x1="10" y1="12" x2="20" y2="12" />
                <polyline points="16,8 20,12 16,16" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${outPoint !== null ? 'text-yellow-400' : 'text-zinc-500'}`}
              onClick={() => setOutPoint(prev => prev !== null && Math.abs(prev - currentTime) < 0.01 ? null : currentTime)}
              title={outPoint !== null ? `Out: ${formatTime(outPoint)} (O to move, click to clear)` : 'Set Out point (O)'}
            >
              {/* Mark Out bracket icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="17,4 20,4 20,20 17,20" />
                <line x1="14" y1="12" x2="4" y2="12" />
                <polyline points="8,8 4,12 8,16" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${
                playingInOut ? 'text-yellow-400 bg-yellow-400/10' : 'text-zinc-500'
              } ${inPoint === null || outPoint === null ? 'opacity-30 cursor-not-allowed' : ''}`}
              disabled={inPoint === null || outPoint === null}
              onClick={() => {
                if (inPoint === null || outPoint === null) return
                if (playingInOut) {
                  // Stop loop
                  setPlayingInOut(false)
                  setIsPlaying(false)
                  setShuttleSpeed(0)
                } else {
                  // Start playing from In, loop In→Out
                  setCurrentTime(Math.min(inPoint, outPoint))
                  setShuttleSpeed(0)
                  setPlayingInOut(true)
                  setIsPlaying(true)
                }
              }}
              title={playingInOut ? 'Stop loop playback' : 'Play In to Out (loop)'}
            >
              <Repeat className="h-3.5 w-3.5" />
            </Button>
            {/* Clear In/Out */}
            {(inPoint !== null || outPoint !== null) && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-yellow-400/70 hover:text-red-400"
                onClick={clearInOut}
                title="Clear In/Out points (Alt+X)"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          
          <div className="w-px h-6 bg-zinc-700" />
          
          <div className="text-sm font-mono text-zinc-400 min-w-[140px]">
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </div>
          
          {/* JKL shuttle speed indicator */}
          {shuttleSpeed !== 0 && (
            <div className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
              shuttleSpeed < 0 ? 'bg-orange-600/20 text-orange-400' : 'bg-blue-600/20 text-blue-400'
            }`}>
              {shuttleSpeed < 0 ? '◀' : '▶'}{' '}{Math.abs(shuttleSpeed)}x
            </div>
          )}
          
          <div className="flex-1" />
          
          {selectedClip && (
            <div className="flex items-center gap-1 mr-4">
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8" 
                title="Split at playhead (B)"
                onClick={() => splitClipAtPlayhead(selectedClip.id)}
              >
                <Scissors className="h-4 w-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8" 
                title="Duplicate"
                onClick={() => duplicateClip(selectedClip.id)}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8" 
                title="Reverse"
                onClick={() => updateClip(selectedClip.id, { reversed: !selectedClip.reversed })}
              >
                <ArrowLeftRight className={`h-4 w-4 ${selectedClip.reversed ? 'text-violet-400' : ''}`} />
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8" 
                title={selectedClip.muted ? 'Unmute' : 'Mute'}
                onClick={() => updateClip(selectedClip.id, { muted: !selectedClip.muted })}
              >
                {selectedClip.muted ? <VolumeX className="h-4 w-4 text-red-400" /> : <Volume2 className="h-4 w-4" />}
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 text-red-400" 
                title="Delete (Del)"
                onClick={() => removeClip(selectedClip.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
          
          <div className="flex items-center gap-1.5">
            <button 
              onClick={() => setZoom(Math.max(getMinZoom(), +(zoom - 0.25).toFixed(2)))}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
              title="Zoom out (-)"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="text-[10px] text-zinc-500 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button 
              onClick={() => setZoom(Math.min(4, +(zoom + 0.25).toFixed(2)))}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
              title="Zoom in (+)"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        
        {/* Timeline Tabs */}
        <div className="h-8 bg-zinc-900 border-t border-zinc-800 flex items-center px-1 gap-0.5 overflow-x-auto flex-shrink-0">
          {timelines.filter(tl => openTimelineIds.has(tl.id)).map(tl => (
            <div
              key={tl.id}
              className={`group flex items-center gap-1 pl-3 pr-1 h-6 rounded-t text-xs font-medium cursor-pointer transition-colors flex-shrink-0 ${
                tl.id === activeTimeline?.id
                  ? 'bg-zinc-950 text-white border-t border-l border-r border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
              onClick={() => handleSwitchTimeline(tl.id)}
              onDoubleClick={() => handleStartRename(tl.id, tl.name)}
              onContextMenu={(e) => handleTimelineTabContextMenu(e, tl.id)}
            >
              {renamingTimelineId === tl.id ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleFinishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename()
                    if (e.key === 'Escape') { setRenamingTimelineId(null); setRenameValue('') }
                  }}
                  className="bg-transparent border-b border-violet-500 outline-none text-white text-xs w-20"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate max-w-[120px]">{tl.name}</span>
              )}
              {/* Close tab button */}
              <button
                className={`ml-0.5 p-0.5 rounded transition-colors flex-shrink-0 ${
                  tl.id === activeTimeline?.id
                    ? 'text-zinc-500 hover:text-white hover:bg-zinc-700'
                    : 'text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-300 hover:bg-zinc-700'
                }`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCloseTimelineTab(tl.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          
          {/* Add timeline button */}
          <button
            onClick={handleAddTimeline}
            className="flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors flex-shrink-0"
            title="New timeline"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          
          
          {/* Context menu */}
          {timelineContextMenu && (
            <div 
              ref={timelineContextMenuRef}
              className="fixed bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[140px]"
              style={{ left: timelineContextMenu.x, top: timelineContextMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  const tl = timelines.find(t => t.id === timelineContextMenu.timelineId)
                  if (tl) handleStartRename(tl.id, tl.name)
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              >
                <Pencil className="h-3 w-3" />
                Rename
              </button>
              <button
                onClick={() => handleDuplicateTimeline(timelineContextMenu.timelineId)}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              >
                <Copy className="h-3 w-3" />
                Duplicate
              </button>
              <div className="h-px bg-zinc-700 my-0.5" />
              <button
                onClick={() => {
                  setShowUpscaleDialog({ timelineId: timelineContextMenu.timelineId })
                  setTimelineContextMenu(null)
                }}
                disabled={upscaleTimelineProgress?.active}
                className="w-full text-left px-3 py-1.5 text-xs text-blue-300 hover:bg-zinc-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ZoomIn className="h-3 w-3" />
                {upscaleTimelineProgress?.active ? `Upscaling ${upscaleTimelineProgress.current}/${upscaleTimelineProgress.total}...` : 'Upscale Timeline'}
              </button>
              <div className="h-px bg-zinc-700 my-0.5" />
              <button
                onClick={() => {
                  setShowImportTimelineModal(true)
                  setTimelineContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              >
                <FileUp className="h-3 w-3" />
                Import XML Timeline
              </button>
              <button
                onClick={() => {
                  handleExportTimelineXml()
                  setTimelineContextMenu(null)
                }}
                disabled={clips.length === 0}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 disabled:opacity-40"
              >
                <FileDown className="h-3 w-3" />
                Export as FCP 7 XML
              </button>
              <div className="h-px bg-zinc-700 my-0.5" />
              <button
                onClick={() => {
                  handleCloseTimelineTab(timelineContextMenu.timelineId)
                  setTimelineContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              >
                <X className="h-3 w-3" />
                Close Tab
              </button>
              {timelines.length > 1 && (
                <>
                  <button
                    onClick={() => handleDeleteTimeline(timelineContextMenu.timelineId)}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 flex items-center gap-2"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        
        {/* Timeline resize handle */}
        <div
          className="h-1 flex-shrink-0 cursor-row-resize bg-transparent hover:bg-violet-500/40 active:bg-violet-500/60 transition-colors relative group z-10"
          onMouseDown={(e) => handleResizeDragStart('timeline', e)}
        >
          <div className="absolute inset-x-0 -top-1 -bottom-1" />
        </div>
        
        {/* Timeline with Tools */}
        <div className="bg-zinc-950 border-t border-zinc-800 flex overflow-hidden flex-shrink-0" style={{ height: layout.timelineHeight }}>
          {/* Tools Panel */}
          <div className="w-10 flex-shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
            {TOOLS.map(tool => (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                className={`p-1.5 rounded-lg transition-colors relative group flex-shrink-0 ${
                  activeTool === tool.id 
                    ? 'bg-violet-600 text-white' 
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                }`}
                title={`${tool.label} (${tool.shortcut})`}
              >
                <tool.icon className="h-4 w-4" />
                <div className="absolute left-full ml-2 px-2 py-1 bg-zinc-800 rounded text-xs text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50">
                  {tool.label} <span className="text-zinc-400">({tool.shortcut})</span>
                </div>
              </button>
            ))}
            
            <div className="w-6 h-px bg-zinc-700 my-1 flex-shrink-0" />
            
            <button
              onClick={() => setSnapEnabled(!snapEnabled)}
              className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                snapEnabled 
                  ? 'bg-blue-600 text-white' 
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
              }`}
              title={snapEnabled ? 'Snapping On' : 'Snapping Off'}
            >
              <Magnet className="h-4 w-4" />
            </button>
          </div>
          
          {/* Timeline content */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Ruler row - fixed at top */}
            <div className="flex flex-shrink-0">
              <div className="w-32 h-6 flex-shrink-0 border-b border-r border-zinc-800 bg-zinc-900" />
              <div ref={rulerScrollRef} className="flex-1 overflow-hidden">
                <div 
                  ref={timelineRef}
                  style={{ minWidth: `${totalDuration * pixelsPerSecond}px` }}
                  className={`h-6 bg-zinc-900 border-b border-zinc-800 relative select-none ${
                    activeTool === 'hand' ? 'cursor-grab' : 'cursor-pointer'
                  }`}
                  onMouseDown={handleRulerMouseDown}
                >
                  {(() => {
                    const ticks: React.ReactNode[] = []
                    // Render major + minor ticks up to totalDuration
                    const end = totalDuration + rulerInterval
                    for (let t = 0; t < end; t = +(t + rulerSubInterval).toFixed(4)) {
                      const isMajor = Math.abs(t % rulerInterval) < 0.001 || Math.abs(t % rulerInterval - rulerInterval) < 0.001
                      const leftPx = t * pixelsPerSecond
                      ticks.push(
                        <div
                          key={t}
                          className="absolute top-0 bottom-0"
                          style={{ left: `${leftPx}px` }}
                        >
                          <div className={`h-full border-l ${isMajor ? 'border-zinc-700' : 'border-zinc-800'}`} />
                          {isMajor && (
                            <span className="absolute left-1 bottom-0.5 text-[10px] text-zinc-500 whitespace-nowrap leading-none">
                              {formatTime(t)}
                            </span>
                          )}
                        </div>
                      )
                    }
                    return ticks
                  })()}
                  {/* In/Out range highlight on ruler */}
                  {inPoint !== null && outPoint !== null && (
                    <div
                      className="absolute top-0 bottom-0 bg-yellow-500/15 border-y border-yellow-500/30 pointer-events-none z-10"
                      style={{
                        left: `${Math.min(inPoint, outPoint) * pixelsPerSecond}px`,
                        width: `${Math.abs(outPoint - inPoint) * pixelsPerSecond}px`,
                      }}
                    />
                  )}
                  {/* In point marker */}
                  {inPoint !== null && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-yellow-400 z-[15] pointer-events-none"
                      style={{ left: `${inPoint * pixelsPerSecond}px` }}
                    >
                      <div className="absolute top-0 left-0 text-[7px] font-bold text-yellow-400 bg-yellow-400/20 px-0.5 rounded-br leading-tight">I</div>
                    </div>
                  )}
                  {/* Out point marker */}
                  {outPoint !== null && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-yellow-400 z-[15] pointer-events-none"
                      style={{ left: `${outPoint * pixelsPerSecond}px` }}
                    >
                      <div className="absolute top-0 right-0 text-[7px] font-bold text-yellow-400 bg-yellow-400/20 px-0.5 rounded-bl leading-tight">O</div>
                    </div>
                  )}
                  {/* Playhead (ruler) — position updated by rAF engine during playback */}
                  <div 
                    ref={playheadRulerRef}
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
                    style={{ left: `${currentTime * pixelsPerSecond}px` }}
                  >
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-red-500" />
                  </div>
                </div>
              </div>
            </div>
            
            {/* Tracks body - vertically scrollable */}
            <div className="flex flex-1 min-h-0 flex-col">
              {/* Scrollable tracks area */}
              <div className="flex flex-1 min-h-0">
              {/* Track headers column */}
              <div className="w-32 flex-shrink-0 border-r border-zinc-800 bg-zinc-900 flex flex-col overflow-hidden">
                {/* Add track buttons - pinned above scrollable area */}
                <div className="flex-shrink-0 h-7 flex items-center px-2 gap-1.5 border-b border-zinc-700/50">
                  <button 
                    onClick={() => addTrack('video')}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5"
                    title="Add video track"
                  >
                    <Plus className="h-3 w-3" />
                    V
                  </button>
                  <button 
                    onClick={() => addTrack('audio')}
                    className="text-[10px] text-emerald-500/70 hover:text-emerald-400 flex items-center gap-0.5"
                    title="Add audio track"
                  >
                    <Plus className="h-3 w-3" />
                    A
                  </button>
                  <div className="w-px h-3 bg-zinc-700" />
                  <button 
                    onClick={() => addSubtitleTrack()}
                    className="text-[10px] text-amber-500/70 hover:text-amber-400 flex items-center gap-0.5"
                    title="Add subtitle track"
                  >
                    <MessageSquare className="h-3 w-3" />
                    Subs
                  </button>
                  <div className="w-px h-3 bg-zinc-700" />
                  <button 
                    onClick={() => createAdjustmentLayerAsset()}
                    className="text-[10px] text-violet-400/70 hover:text-violet-300 flex items-center gap-0.5"
                    title="Create adjustment layer asset"
                  >
                    <Layers className="h-3 w-3" />
                    Adj
                  </button>
                </div>
                {/* Scrollable track headers - synced with vertical scroll */}
                <div ref={trackHeadersRef} className="flex-1 overflow-hidden flex flex-col">
                {orderedTracks.map(({ track, realIndex, displayRow }) => (
                  <React.Fragment key={track.id}>
                    {/* Divider between video and audio sections */}
                    {displayRow === audioDividerDisplayRow && (
                      <div className="h-1 flex-shrink-0 bg-zinc-600/60 relative">
                        <span className="absolute left-1/2 -translate-x-1/2 -top-[1px] text-[7px] font-bold text-zinc-400 bg-zinc-800 px-1.5 rounded-sm leading-none">V | A</span>
                      </div>
                    )}
                    <div 
                      className={`group h-14 flex-shrink-0 flex items-center justify-between px-3 border-b border-zinc-800 text-xs ${
                        track.type === 'subtitle' ? 'bg-amber-950/20' : track.kind === 'audio' ? 'bg-emerald-950/10' : ''
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {track.type === 'subtitle' && <MessageSquare className="h-3 w-3 text-amber-500/60 flex-shrink-0" />}
                        <span className={`font-medium truncate ${
                          track.muted ? 'text-zinc-600' 
                          : track.type === 'subtitle' ? 'text-amber-400/80' 
                          : track.kind === 'audio' ? 'text-emerald-400/80'
                          : 'text-zinc-300'
                        }`}>
                          {track.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5">
                        {track.type === 'subtitle' && (
                          <>
                          <button
                            onClick={() => setSubtitleTrackStyleIdx(subtitleTrackStyleIdx === realIndex ? null : realIndex)}
                            className={`p-1 rounded ${subtitleTrackStyleIdx === realIndex ? 'text-amber-400 bg-amber-900/30' : 'text-amber-500/60 hover:text-amber-400'}`}
                            title="Track style settings"
                          >
                            <Palette className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => addSubtitleClip(realIndex)}
                            className="p-1 rounded text-amber-500/60 hover:text-amber-400"
                            title="Add subtitle"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          </>
                        )}
                        <button 
                          onClick={() => setTracks(tracks.map((t, i) => i === realIndex ? {...t, locked: !t.locked} : t))}
                          className={`p-1 rounded ${track.locked ? 'text-yellow-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                          title={track.locked ? 'Unlock' : 'Lock'}
                        >
                          {track.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                        </button>
                        {track.type !== 'subtitle' && (
                          <button 
                            onClick={() => setTracks(tracks.map((t, i) => i === realIndex ? {...t, enabled: !(t.enabled !== false)}: t))}
                            className={`p-1 rounded ${track.enabled === false ? 'text-zinc-600' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title={track.enabled === false ? 'Enable track output' : 'Disable track output'}
                          >
                            {track.enabled === false ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          </button>
                        )}
                        {track.type !== 'subtitle' && (
                          <button 
                            onClick={() => setTracks(tracks.map((t, i) => i === realIndex ? {...t, muted: !t.muted} : t))}
                            className={`p-1 rounded ${track.muted ? 'text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title={track.muted ? 'Unmute' : 'Mute'}
                          >
                            {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                          </button>
                        )}
                        {track.type === 'subtitle' && (
                          <button 
                            onClick={() => setTracks(tracks.map((t, i) => i === realIndex ? {...t, muted: !t.muted} : t))}
                            className={`p-1 rounded ${track.muted ? 'text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title={track.muted ? 'Show subtitles' : 'Hide subtitles'}
                          >
                            {track.muted ? <Eye className="h-3 w-3 opacity-40" /> : <Eye className="h-3 w-3" />}
                          </button>
                        )}
                        {tracks.length > 1 && (
                          <button 
                            onClick={() => deleteTrack(realIndex)}
                            className="p-1 rounded text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete track"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                ))}
                {/* Spacer at bottom of track list */}
                <div className="h-4 flex-shrink-0" />
              </div>{/* end trackHeadersRef */}
              </div>{/* end track headers column */}
              
              {/* Scrollable track content area */}
              <div className="flex-1 flex flex-col min-w-0 relative">
                {/* Full-height playhead line — spans spacer + tracks, positioned on the wrapper */}
                <div
                  ref={playheadOverlayRef}
                  className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none"
                  style={{ left: `${currentTime * pixelsPerSecond - (trackContainerRef.current?.scrollLeft || 0)}px` }}
                />
                {/* Spacer matching the add-track button bar height */}
                <div className="flex-shrink-0 h-7 border-b border-zinc-700/50" />
                <div 
                  ref={trackContainerRef}
                  className="flex-1 overflow-auto"
                  onScroll={handleTimelineScroll}
                >
                <div 
                  style={{ minWidth: `${totalDuration * pixelsPerSecond}px` }}
                  className="relative"
                  onContextMenu={(e) => {
                    // Right-click on background (not on a clip) opens paste menu
                    if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-track-bg]')) {
                      handleTimelineBgContextMenu(e)
                    }
                  }}
                  onMouseDown={(e) => {
                    // Only start lasso on direct click on the tracks area (not on clips)
                    if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-track-bg]')) {
                      setSelectedSubtitleId(null)
                      setEditingSubtitleId(null)
                      setSelectedGap(null)
                      setGapGenerateMode(null)
                      if (activeTool === 'trackForward') {
                        // Track Select Forward: click empty area → select all clips from click time forward
                        const container = trackContainerRef.current
                        if (container) {
                          const rect = container.getBoundingClientRect()
                          const scrollLeft = container.scrollLeft
                          const scrollTop = container.scrollTop
                          const clickX = e.clientX - rect.left + scrollLeft
                          const clickY = e.clientY - rect.top + scrollTop
                          const clickTime = clickX / pixelsPerSecond
                          
                          // Determine which track was clicked using display ordering
                          let clickedRealTrackIndex = -1
                          let accY = 0
                          for (const entry of orderedTracks) {
                            if (entry.displayRow === audioDividerDisplayRow) accY += DIVIDER_H
                            if (clickY >= accY && clickY < accY + TRACK_H) {
                              clickedRealTrackIndex = entry.realIndex
                              break
                            }
                            accY += TRACK_H
                          }
                          
                          const forwardClips = clips.filter(c => {
                            if (e.shiftKey) {
                              return c.startTime >= clickTime - 0.01
                            } else {
                              return c.trackIndex === clickedRealTrackIndex && c.startTime >= clickTime - 0.01
                            }
                          })
                          setSelectedClipIds(new Set(forwardClips.map(c => c.id)))
                        }
                      } else if (activeTool === 'select') {
                        // If not shift-clicking, clear selection first
                        if (!e.shiftKey) {
                          setSelectedClipIds(new Set())
                        }
                        // Start lasso
                        const container = trackContainerRef.current
                        if (container) {
                          const rect = container.getBoundingClientRect()
                          lassoOriginRef.current = {
                            scrollLeft: container.scrollLeft,
                            containerLeft: rect.left,
                            containerTop: rect.top, // ruler is now outside trackContainerRef
                          }
                          setLassoRect({
                            startX: e.clientX,
                            startY: e.clientY,
                            currentX: e.clientX,
                            currentY: e.clientY,
                          })
                        }
                      }
                    }
                  }}
                >
                  {/* In/Out range highlight on tracks */}
                  {inPoint !== null && outPoint !== null && (
                    <div
                      className="absolute top-0 bottom-0 bg-yellow-500/8 pointer-events-none z-5"
                      style={{
                        left: `${Math.min(inPoint, outPoint) * pixelsPerSecond}px`,
                        width: `${Math.abs(outPoint - inPoint) * pixelsPerSecond}px`,
                      }}
                    />
                  )}
                  {/* In point line */}
                  {inPoint !== null && (
                    <div 
                      className="absolute top-0 bottom-0 w-0.5 bg-yellow-400/50 z-[15] pointer-events-none"
                      style={{ left: `${inPoint * pixelsPerSecond}px` }}
                    />
                  )}
                  {/* Out point line */}
                  {outPoint !== null && (
                    <div 
                      className="absolute top-0 bottom-0 w-0.5 bg-yellow-400/50 z-[15] pointer-events-none"
                      style={{ left: `${outPoint * pixelsPerSecond}px` }}
                    />
                  )}
                  {/* Playhead is now rendered as overlay on the column wrapper (playheadOverlayRef) */}
                  
                  {orderedTracks.map(({ track, realIndex, displayRow }) => (
                    <React.Fragment key={track.id}>
                      {/* Divider between video and audio sections */}
                      {displayRow === audioDividerDisplayRow && (
                        <div className="h-1 bg-zinc-600/60" />
                      )}
                      <div 
                        data-track-bg="true"
                        className={`h-14 border-b border-zinc-800 ${
                          track.type === 'subtitle'
                            ? 'bg-amber-950/15'
                            : track.kind === 'audio'
                              ? (displayRow % 2 === 0 ? 'bg-emerald-950/20' : 'bg-emerald-950/10')
                              : displayRow % 2 === 0 ? 'bg-zinc-900/50' : 'bg-zinc-950'
                        } ${track.locked ? 'opacity-50' : ''}`}
                        onDrop={(e) => {
                          if (track.type === 'subtitle') {
                            e.preventDefault()
                            return
                          }
                          handleTrackDrop(e, realIndex)
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDoubleClick={() => {
                          if (track.type === 'subtitle' && !track.locked) {
                            addSubtitleClip(realIndex)
                          }
                        }}
                      />
                    </React.Fragment>
                  ))}
                  
                  {/* Gap indicators between clips */}
                  {timelineGaps.map((gap, i) => {
                    const leftPx = gap.startTime * pixelsPerSecond
                    const widthPx = (gap.endTime - gap.startTime) * pixelsPerSecond
                    const topPx = trackTopPx(gap.trackIndex, 1)
                    const isSelected = selectedGap && 
                      selectedGap.trackIndex === gap.trackIndex && 
                      Math.abs(selectedGap.startTime - gap.startTime) < 0.01 &&
                      Math.abs(selectedGap.endTime - gap.endTime) < 0.01
                    
                    // Only show if gap is wide enough to be clickable
                    if (widthPx < 4) return null
                    
                    return (
                      <div
                        key={`gap-${i}`}
                        className={`absolute cursor-pointer transition-all group/gap ${
                          isSelected
                            ? 'bg-red-500/20 border border-red-500/60 z-10'
                            : 'hover:bg-red-500/10 hover:border hover:border-red-500/30 border border-transparent'
                        }`}
                        style={{
                          left: `${leftPx}px`,
                          top: `${topPx}px`,
                          width: `${widthPx}px`,
                          height: '52px',
                          borderRadius: '4px',
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedGap(gap)
                          setSelectedClipIds(new Set())
                          setSelectedSubtitleId(null)
                          setGapGenerateMode(null)
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setSelectedGap(gap)
                          setSelectedClipIds(new Set())
                          setSelectedSubtitleId(null)
                        }}
                      >
                        {/* Gap label on hover or selected */}
                        <div className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 pointer-events-none ${
                          isSelected ? 'opacity-100' : 'opacity-0 group-hover/gap:opacity-100'
                        } transition-opacity`}>
                          <span className="text-[9px] text-red-400 font-medium">
                            {(gap.endTime - gap.startTime).toFixed(1)}s gap
                          </span>
                          {widthPx > 60 && (
                            <span className="text-[8px] text-red-400/60">
                              {isSelected ? 'Del to close' : 'Click to select'}
                            </span>
                          )}
                        </div>
                        
                        {/* Diagonal hatching pattern for selected gap */}
                        {isSelected && (
                          <div className="absolute inset-0 overflow-hidden rounded pointer-events-none opacity-20">
                            <svg width="100%" height="100%">
                              <defs>
                                <pattern id={`gap-hatch-${i}`} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                                  <line x1="0" y1="0" x2="0" y2="8" stroke="#ef4444" strokeWidth="1.5" />
                                </pattern>
                              </defs>
                              <rect width="100%" height="100%" fill={`url(#gap-hatch-${i})`} />
                            </svg>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  
                  {/* Lasso selection rectangle */}
                  {lassoRect && lassoOriginRef.current && (() => {
                    const origin = lassoOriginRef.current!
                    const container = trackContainerRef.current
                    if (!container) return null
                    const scrollLeft = container.scrollLeft
                    const scrollTop = container.scrollTop
                    const x1 = Math.min(lassoRect.startX, lassoRect.currentX) - origin.containerLeft + scrollLeft
                    const x2 = Math.max(lassoRect.startX, lassoRect.currentX) - origin.containerLeft + scrollLeft
                    const y1 = Math.min(lassoRect.startY, lassoRect.currentY) - origin.containerTop + scrollTop
                    const y2 = Math.max(lassoRect.startY, lassoRect.currentY) - origin.containerTop + scrollTop
                    return (
                      <div
                        className="absolute border border-violet-400 bg-violet-500/10 z-30 pointer-events-none rounded-sm"
                        style={{
                          left: x1,
                          top: y1,
                          width: x2 - x1,
                          height: y2 - y1,
                        }}
                      />
                    )
                  })()}
                  
                  {clips.map(clip => (
                    <div
                      key={clip.id}
                      className={`absolute h-12 rounded border-2 transition-all overflow-hidden ${
                        selectedClipIds.has(clip.id) 
                          ? 'border-violet-500 shadow-lg shadow-violet-500/20' 
                          : 'border-zinc-600 hover:border-zinc-500'
                      } ${clip.type === 'audio' ? 'bg-green-900/50' : clip.type === 'adjustment' ? 'bg-violet-900/40 border-dashed' : 'bg-zinc-800'} ${
                        activeTool === 'select' || activeTool === 'ripple' || activeTool === 'roll' || activeTool === 'trackForward' ? 'cursor-grab' : ''
                      } ${activeTool === 'blade' ? 'cursor-crosshair' : ''} ${
                        activeTool === 'slip' ? 'cursor-ew-resize' : ''
                      } ${activeTool === 'slide' ? 'cursor-col-resize' : ''} ${
                        draggingClip?.clipId === clip.id || (draggingClip && selectedClipIds.has(clip.id)) ? 'opacity-80 cursor-grabbing z-30' : ''
                      } ${slipSlideClip?.clipId === clip.id ? 'opacity-90 ring-2 ring-yellow-500/50 z-30' : ''
                      }`}
                      style={{
                        left: `${clip.startTime * pixelsPerSecond}px`,
                        width: `${clip.duration * pixelsPerSecond}px`,
                        top: `${trackTopPx(clip.trackIndex, 4)}px`,
                      }}
                      onMouseDown={(e) => handleClipMouseDown(e, clip)}
                      onContextMenu={(e) => handleClipContextMenu(e, clip)}
                    >
                      <div className="absolute left-0 top-0 bottom-0 w-4 flex items-center justify-center text-zinc-500 hover:text-white cursor-grab">
                        <GripVertical className="h-3 w-3" />
                      </div>
                      
                      <div className="h-full flex items-center pl-5 pr-2 gap-2">
                        {clip.type === 'adjustment' ? (
                          <div className="h-8 w-8 flex-shrink-0 rounded bg-violet-800/30 border border-violet-600/30 flex items-center justify-center">
                            <Layers className="h-4 w-4 text-violet-400" />
                          </div>
                        ) : clip.type === 'audio' ? (
                          <div className="h-8 w-8 flex-shrink-0 rounded bg-emerald-800/50 flex items-center justify-center">
                            <Music className="h-4 w-4 text-emerald-400" />
                          </div>
                        ) : clip.asset && (
                          clip.asset.type === 'video' ? (
                            <video key={`thumb-${clip.id}-${clip.takeIndex ?? 'default'}`} src={getClipUrl(clip) || clip.asset.url} className="h-8 aspect-video object-cover rounded" muted />
                          ) : (
                            <img key={`thumb-${clip.id}-${clip.takeIndex ?? 'default'}`} src={getClipUrl(clip) || clip.asset.url} alt="" className="h-8 aspect-video object-cover rounded" />
                          )
                        )}
                        <div className="flex-1 min-w-0">
                          <p className={`text-[10px] truncate ${clip.type === 'adjustment' ? 'text-violet-300' : clip.type === 'audio' ? 'text-emerald-300' : 'text-zinc-300'}`}>
                            {clip.type === 'adjustment' ? 'Adjustment Layer' : clip.asset?.prompt?.slice(0, 30) || clip.importedName || 'Clip'}
                          </p>
                          <div className="flex items-center gap-2 text-[9px] text-zinc-500">
                            <span>{clip.duration.toFixed(1)}s</span>
                            {(() => {
                              const resInfo = getClipResolution(clip)
                              if (!resInfo) return null
                              return <span style={{ color: resInfo.color }} className="font-semibold">{resInfo.height >= 2160 ? '4K' : `${resInfo.height}p`}</span>
                            })()}
                            {clip.speed !== 1 && <span className="text-yellow-400">{clip.speed}x</span>}
                            {clip.reversed && <span className="text-blue-400">REV</span>}
                            {clip.muted && <span className="text-red-400">M</span>}
                            {(clip.flipH || clip.flipV) && <span className="text-cyan-400">FLIP</span>}
                            {clip.colorCorrection && Object.values(clip.colorCorrection).some(v => v !== 0) && <span className="text-orange-400">CC</span>}
                            {clip.letterbox?.enabled && <span className="text-violet-400">LB</span>}
                          </div>
                        </div>
                        
                        {/* Take navigation + Regenerate (only for clips with gen params) */}
                        {(() => {
                          const liveAsset = getLiveAsset(clip)
                          if (!liveAsset || clip.duration * pixelsPerSecond <= 60 || clip.type === 'adjustment') return null
                          return (
                            <div className="flex-shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                              {/* Take navigation: prev/next */}
                              {liveAsset.takes && liveAsset.takes.length > 1 && (
                                <>
                                  <button
                                    onClick={() => handleClipTakeChange(clip.id, 'prev')}
                                    className="p-0.5 rounded hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
                                    title="Previous take"
                                  >
                                    <ChevronLeft className="h-3 w-3" />
                                  </button>
                                  <span className="text-[8px] text-zinc-400 min-w-[24px] text-center">
                                    {(clip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes.length - 1)) + 1}/{liveAsset.takes.length}
                                  </span>
                                  <button
                                    onClick={() => handleClipTakeChange(clip.id, 'next')}
                                    className="p-0.5 rounded hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
                                    title="Next take"
                                  >
                                    <ChevronRight className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (confirm(`Delete take ${(clip.takeIndex ?? (liveAsset.activeTakeIndex ?? liveAsset.takes!.length - 1)) + 1}?`)) {
                                        handleDeleteTake(clip.id)
                                      }
                                    }}
                                    className="p-0.5 rounded hover:bg-red-900/50 text-zinc-500 hover:text-red-400 transition-colors"
                                    title="Delete this take"
                                  >
                                    <Trash2 className="h-2.5 w-2.5" />
                                  </button>
                                </>
                              )}
                              <button
                                onClick={() => handleRegenerate(clip.assetId!, clip.id)}
                                disabled={isRegenerating}
                                className={`p-0.5 rounded transition-colors ${
                                  clip.isRegenerating
                                    ? 'text-violet-400'
                                    : 'hover:bg-white/10 text-zinc-500 hover:text-violet-400'
                                }`}
                                title="Regenerate shot"
                              >
                                <RefreshCw className={`h-3 w-3 ${clip.isRegenerating ? 'animate-spin' : ''}`} />
                              </button>
                            </div>
                          )
                        })()}
                      </div>
                      
                      {/* Regenerating overlay on the clip */}
                      {clip.isRegenerating && (
                        <div className="absolute inset-0 bg-violet-900/30 backdrop-blur-[2px] flex items-center justify-center rounded-lg z-10">
                          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-violet-900/80 border border-violet-500/40">
                            <Loader2 className="h-3 w-3 text-violet-300 animate-spin" />
                            <span className="text-[9px] text-violet-200 font-medium">
                              {regenProgress > 0 ? `${regenProgress}%` : 'Regenerating...'}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleCancelRegeneration() }}
                              className="ml-1 px-1.5 py-0.5 rounded bg-zinc-800/80 border border-zinc-600/60 text-[9px] text-zinc-300 hover:text-red-400 hover:border-red-500/50 hover:bg-red-900/30 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {/* Upscaling overlay on the clip */}
                      {upscalingClipIds.has(clip.id) && (
                        <div className="absolute inset-0 bg-blue-900/30 backdrop-blur-[2px] flex items-center justify-center rounded-lg z-10">
                          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-900/80 border border-blue-500/40">
                            <Loader2 className="h-3 w-3 text-blue-300 animate-spin" />
                            <span className="text-[9px] text-blue-200 font-medium">Upscaling...</span>
                          </div>
                        </div>
                      )}
                      
                      {/* Transition in indicator */}
                      {clip.transitionIn?.type !== 'none' && clip.transitionIn?.duration > 0 && (
                        <div
                          className="absolute top-0 bottom-0 left-0 pointer-events-none"
                          style={{
                            width: `${Math.min(clip.transitionIn.duration / clip.duration * 100, 50)}%`,
                            background: 'linear-gradient(to right, rgba(139,92,246,0.4), transparent)',
                          }}
                        />
                      )}
                      {/* Transition out indicator */}
                      {clip.transitionOut?.type !== 'none' && clip.transitionOut?.duration > 0 && (
                        <div
                          className="absolute top-0 bottom-0 right-0 pointer-events-none"
                          style={{
                            width: `${Math.min(clip.transitionOut.duration / clip.duration * 100, 50)}%`,
                            background: 'linear-gradient(to left, rgba(139,92,246,0.4), transparent)',
                          }}
                        />
                      )}
                      
                      {/* Resolution color-code bar at the bottom of the clip */}
                      {(() => {
                        const resInfo = getClipResolution(clip)
                        if (!resInfo) return null
                        return (
                          <div
                            className="absolute bottom-0 left-0 right-0 h-[3px] pointer-events-none"
                            style={{ backgroundColor: resInfo.color }}
                            title={resInfo.label}
                          />
                        )
                      })()}

                      <div 
                        className={`absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize transition-colors flex items-center justify-center ${
                          resizingClip?.clipId === clip.id && resizingClip?.edge === 'left'
                            ? activeTool === 'roll' ? 'bg-yellow-500' : activeTool === 'ripple' ? 'bg-green-500' : 'bg-violet-500'
                            : activeTool === 'roll' ? 'hover:bg-yellow-500/50' : activeTool === 'ripple' ? 'hover:bg-green-500/50' : 'hover:bg-violet-500/50'
                        }`}
                        onMouseDown={(e) => handleResizeStart(e, clip, 'left')}
                      >
                        <div className={`w-0.5 h-6 rounded-full ${
                          activeTool === 'roll' ? 'bg-yellow-300' : activeTool === 'ripple' ? 'bg-green-300' : 'bg-zinc-500'
                        }`} />
                      </div>
                      <div 
                        className={`absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize transition-colors flex items-center justify-center ${
                          resizingClip?.clipId === clip.id && resizingClip?.edge === 'right'
                            ? activeTool === 'roll' ? 'bg-yellow-500' : activeTool === 'ripple' ? 'bg-green-500' : 'bg-violet-500'
                            : activeTool === 'roll' ? 'hover:bg-yellow-500/50' : activeTool === 'ripple' ? 'hover:bg-green-500/50' : 'hover:bg-violet-500/50'
                        }`}
                        onMouseDown={(e) => handleResizeStart(e, clip, 'right')}
                      >
                        <div className={`w-0.5 h-6 rounded-full ${
                          activeTool === 'roll' ? 'bg-yellow-300' : activeTool === 'ripple' ? 'bg-green-300' : 'bg-zinc-500'
                        }`} />
                      </div>
                    </div>
                  ))}
                  
                  {/* Gap indicators between clips */}
                  {timelineGaps.map((gap, i) => {
                    const leftPx = gap.startTime * pixelsPerSecond
                    const widthPx = (gap.endTime - gap.startTime) * pixelsPerSecond
                    const topPx = trackTopPx(gap.trackIndex, 4)
                    const isSelected = selectedGap &&
                      selectedGap.trackIndex === gap.trackIndex &&
                      Math.abs(selectedGap.startTime - gap.startTime) < 0.01 &&
                      Math.abs(selectedGap.endTime - gap.endTime) < 0.01
                    
                    // Only show if wide enough to be useful (at least 8px)
                    if (widthPx < 8) return null
                    
                    return (
                      <div
                        key={`gap-${i}`}
                        className={`absolute h-12 rounded cursor-pointer transition-all group ${
                          isSelected
                            ? 'bg-red-500/20 border-2 border-dashed border-red-400/60 shadow-inner'
                            : 'hover:bg-zinc-700/30 border-2 border-dashed border-transparent hover:border-zinc-600/40'
                        }`}
                        style={{
                          left: `${leftPx}px`,
                          top: `${topPx}px`,
                          width: `${widthPx}px`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedGap(gap)
                          setSelectedClipIds(new Set())
                          setSelectedSubtitleId(null)
                          setGapGenerateMode(null)
                        }}
                      >
                        {/* Gap label */}
                        <div className={`absolute inset-0 flex items-center justify-center ${
                          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        } transition-opacity`}>
                          {widthPx > 50 ? (
                            <span className="text-[9px] text-zinc-400 bg-zinc-900/70 px-1.5 py-0.5 rounded font-mono">
                              {(gap.endTime - gap.startTime).toFixed(1)}s
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                  
                  {/* Subtitle clips on subtitle tracks */}
                  {subtitles.map(sub => {
                    const track = tracks[sub.trackIndex]
                    if (!track || track.type !== 'subtitle') return null
                    const leftPx = sub.startTime * pixelsPerSecond
                    const widthPx = Math.max(20, (sub.endTime - sub.startTime) * pixelsPerSecond)
                    const topPx = trackTopPx(sub.trackIndex, 4)
                    const isSelected = selectedSubtitleId === sub.id
                    const isEditing = editingSubtitleId === sub.id
                    
                    return (
                      <div
                        key={sub.id}
                        className={`absolute h-12 rounded border-2 overflow-hidden cursor-pointer select-none flex items-center ${
                          isSelected
                            ? 'border-amber-400 shadow-lg shadow-amber-500/20 bg-amber-900/60'
                            : 'border-amber-700/50 hover:border-amber-600/70 bg-amber-900/40'
                        } ${track.locked ? 'pointer-events-none opacity-50' : ''}`}
                        style={{
                          left: `${leftPx}px`,
                          top: `${topPx}px`,
                          width: `${widthPx}px`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedSubtitleId(sub.id)
                          setSelectedClipIds(new Set())
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setEditingSubtitleId(sub.id)
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setSelectedSubtitleId(sub.id)
                          setSelectedClipIds(new Set())
                        }}
                        onMouseDown={(e) => {
                          if (track.locked || e.button !== 0) return
                          e.stopPropagation()
                          const startX = e.clientX
                          const origStart = sub.startTime
                          const origEnd = sub.endTime
                          const dur = origEnd - origStart
                          
                          const onMove = (ev: MouseEvent) => {
                            const dx = ev.clientX - startX
                            const dt = dx / pixelsPerSecond
                            const newStart = Math.max(0, origStart + dt)
                            updateSubtitle(sub.id, { startTime: newStart, endTime: newStart + dur })
                          }
                          const onUp = () => {
                            window.removeEventListener('mousemove', onMove)
                            window.removeEventListener('mouseup', onUp)
                          }
                          window.addEventListener('mousemove', onMove)
                          window.addEventListener('mouseup', onUp)
                        }}
                      >
                        {/* Subtitle text */}
                        <div className="flex-1 min-w-0 px-2 py-1">
                          {isEditing ? (
                            <input
                              autoFocus
                              defaultValue={sub.text}
                              className="w-full bg-transparent text-amber-100 text-[10px] leading-tight outline-none border-b border-amber-500/50"
                              onBlur={(e) => {
                                updateSubtitle(sub.id, { text: e.target.value })
                                setEditingSubtitleId(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  updateSubtitle(sub.id, { text: (e.target as HTMLInputElement).value })
                                  setEditingSubtitleId(null)
                                }
                                if (e.key === 'Escape') setEditingSubtitleId(null)
                                e.stopPropagation()
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span className="text-[10px] text-amber-200 leading-tight line-clamp-2 break-all">
                              {sub.text}
                            </span>
                          )}
                        </div>
                        
                        {/* Left resize handle */}
                        <div
                          className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-amber-400/30"
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            const startX = e.clientX
                            const origStart = sub.startTime
                            const onMove = (ev: MouseEvent) => {
                              const dx = ev.clientX - startX
                              const dt = dx / pixelsPerSecond
                              const newStart = Math.max(0, Math.min(sub.endTime - 0.2, origStart + dt))
                              updateSubtitle(sub.id, { startTime: newStart })
                            }
                            const onUp = () => {
                              window.removeEventListener('mousemove', onMove)
                              window.removeEventListener('mouseup', onUp)
                            }
                            window.addEventListener('mousemove', onMove)
                            window.addEventListener('mouseup', onUp)
                          }}
                        />
                        {/* Right resize handle */}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-amber-400/30"
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            const startX = e.clientX
                            const origEnd = sub.endTime
                            const onMove = (ev: MouseEvent) => {
                              const dx = ev.clientX - startX
                              const dt = dx / pixelsPerSecond
                              const newEnd = Math.max(sub.startTime + 0.2, origEnd + dt)
                              updateSubtitle(sub.id, { endTime: newEnd })
                            }
                            const onUp = () => {
                              window.removeEventListener('mousemove', onMove)
                              window.removeEventListener('mouseup', onUp)
                            }
                            window.addEventListener('mousemove', onMove)
                            window.addEventListener('mouseup', onUp)
                          }}
                        />
                      </div>
                    )
                  })}
                  
                  {/* Cut point indicators for cross-dissolve */}
                  {cutPoints.map((cp) => {
                    const leftPx = cp.time * pixelsPerSecond
                    const topPx = trackTopPx(cp.trackIndex, 4)
                    const isHovered = hoveredCutPoint?.leftClipId === cp.leftClip.id && hoveredCutPoint?.rightClipId === cp.rightClip.id
                    const dissolveDur = cp.hasDissolve ? (cp.leftClip.transitionOut?.duration || DEFAULT_DISSOLVE_DURATION) : 0
                    const dissolveWidthPx = dissolveDur * pixelsPerSecond
                    
                    return (
                      <div
                        key={`cut-${cp.leftClip.id}-${cp.rightClip.id}`}
                        className="absolute z-20"
                        style={{
                          left: `${cp.hasDissolve ? leftPx - dissolveWidthPx : leftPx - 10}px`,
                          top: `${topPx - 24}px`,
                          width: `${cp.hasDissolve ? dissolveWidthPx * 2 : 20}px`,
                          height: `${48 + 24}px`, /* extend upward to include popup zone */
                        }}
                        onMouseEnter={() => setHoveredCutPoint({
                          leftClipId: cp.leftClip.id,
                          rightClipId: cp.rightClip.id,
                          time: cp.time,
                          trackIndex: cp.trackIndex,
                        })}
                        onMouseLeave={() => setHoveredCutPoint(null)}
                      >
                        {/* Visible indicator line */}
                        <div 
                          className={`absolute top-6 bottom-0 w-0.5 transition-colors ${
                            isHovered ? 'bg-violet-400' : cp.hasDissolve ? 'bg-violet-500/60' : 'bg-transparent'
                          }`}
                          style={{ left: `${cp.hasDissolve ? dissolveWidthPx : 10}px`, transform: 'translateX(-50%)' }}
                        />
                        
                        {cp.hasDissolve ? (
                          <>
                            {/* Dissolve region visual (gradient bar on the clip area) */}
                            <div
                              className="absolute rounded-sm pointer-events-none"
                              style={{
                                left: 0,
                                top: '24px',
                                width: `${dissolveWidthPx * 2}px`,
                                height: '48px',
                                background: 'linear-gradient(to right, rgba(139,92,246,0.15), rgba(139,92,246,0.3), rgba(139,92,246,0.15))',
                                borderTop: '2px solid rgba(139,92,246,0.5)',
                                borderBottom: '2px solid rgba(139,92,246,0.5)',
                              }}
                            />
                            
                            {/* Dissolve duration label */}
                            <div
                              className="absolute flex items-center justify-center pointer-events-none"
                              style={{
                                left: 0,
                                top: '24px',
                                width: `${dissolveWidthPx * 2}px`,
                                height: '48px',
                              }}
                            >
                              <span className="text-[9px] text-violet-300 font-medium bg-violet-900/60 px-1.5 py-0.5 rounded">
                                {dissolveDur.toFixed(1)}s
                              </span>
                            </div>
                            
                            {/* Left drag handle */}
                            <div
                              className="absolute top-6 bottom-0 w-2 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-30"
                              style={{ left: 0 }}
                              onMouseDown={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                                const startX = e.clientX
                                const startDur = dissolveDur
                                
                                const handleMove = (ev: MouseEvent) => {
                                  const delta = (startX - ev.clientX) / pixelsPerSecond
                                  const newDur = Math.max(0.1, Math.min(cp.leftClip.duration * 0.9, startDur + delta))
                                  setClips(prev => prev.map(c => {
                                    if (c.id === cp.leftClip.id) return { ...c, transitionOut: { ...c.transitionOut, duration: +newDur.toFixed(2) } }
                                    if (c.id === cp.rightClip.id) return { ...c, transitionIn: { ...c.transitionIn, duration: +newDur.toFixed(2) } }
                                    return c
                                  }))
                                }
                                const handleUp = () => {
                                  document.removeEventListener('mousemove', handleMove)
                                  document.removeEventListener('mouseup', handleUp)
                                  document.body.style.cursor = ''
                                  document.body.style.userSelect = ''
                                }
                                pushUndo()
                                document.addEventListener('mousemove', handleMove)
                                document.addEventListener('mouseup', handleUp)
                                document.body.style.cursor = 'ew-resize'
                                document.body.style.userSelect = 'none'
                              }}
                            >
                              <div className="absolute inset-y-0 left-0 w-0.5 bg-violet-400 rounded-full" />
                            </div>
                            
                            {/* Right drag handle */}
                            <div
                              className="absolute top-6 bottom-0 w-2 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-30"
                              style={{ right: 0 }}
                              onMouseDown={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                                const startX = e.clientX
                                const startDur = dissolveDur
                                
                                const handleMove = (ev: MouseEvent) => {
                                  const delta = (ev.clientX - startX) / pixelsPerSecond
                                  const newDur = Math.max(0.1, Math.min(cp.rightClip.duration * 0.9, startDur + delta))
                                  setClips(prev => prev.map(c => {
                                    if (c.id === cp.leftClip.id) return { ...c, transitionOut: { ...c.transitionOut, duration: +newDur.toFixed(2) } }
                                    if (c.id === cp.rightClip.id) return { ...c, transitionIn: { ...c.transitionIn, duration: +newDur.toFixed(2) } }
                                    return c
                                  }))
                                }
                                const handleUp = () => {
                                  document.removeEventListener('mousemove', handleMove)
                                  document.removeEventListener('mouseup', handleUp)
                                  document.body.style.cursor = ''
                                  document.body.style.userSelect = ''
                                }
                                pushUndo()
                                document.addEventListener('mousemove', handleMove)
                                document.addEventListener('mouseup', handleUp)
                                document.body.style.cursor = 'ew-resize'
                                document.body.style.userSelect = 'none'
                              }}
                            >
                              <div className="absolute inset-y-0 right-0 w-0.5 bg-violet-400 rounded-full" />
                            </div>
                            
                            {/* Remove button (shown on hover, positioned inside the zone) */}
                            {isHovered && (
                              <div
                                className="absolute left-1/2 -translate-x-1/2 top-0 whitespace-nowrap z-40"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  className="px-2 py-0.5 rounded bg-red-900/80 border border-red-700 text-[9px] text-red-300 hover:bg-red-800 transition-colors shadow-lg"
                                  onClick={() => removeCrossDissolve(cp.leftClip.id, cp.rightClip.id)}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {/* No dissolve: show add button on hover (positioned inside the zone) */}
                            {isHovered && (
                              <div
                                className="absolute left-1/2 -translate-x-1/2 top-0 whitespace-nowrap z-40"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  className="px-2 py-1 rounded-lg bg-violet-600/90 border border-violet-500 text-[10px] text-white hover:bg-violet-500 transition-colors shadow-lg flex items-center gap-1"
                                  onClick={() => addCrossDissolve(cp.leftClip.id, cp.rightClip.id)}
                                >
                                  <Film className="h-3 w-3" />
                                  Dissolve
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>{/* close relative inner */}
              </div>{/* close trackContainerRef */}
              </div>{/* close content column */}
            </div>{/* close scrollable area row */}
            </div>{/* close tracks body flex-col */}
          </div>
        </div>
        
        {/* Bottom toolbar with zoom bar */}
        <div className="h-9 bg-zinc-900 border-t border-zinc-800 flex items-center px-3 gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" className="h-6 border-zinc-700 text-zinc-400 text-[10px] px-2">
            <Plus className="h-3 w-3 mr-1" />
            Add Clip
          </Button>
          
          {selectedClip && (
            <>
              <div className="w-px h-4 bg-zinc-700" />
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                <Gauge className="h-3 w-3" />
                <select
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
                  className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-white"
                >
                  <option value={0.25}>0.25x</option>
                  <option value={0.5}>0.5x</option>
                  <option value={0.75}>0.75x</option>
                  <option value={1}>1x</option>
                  <option value={1.25}>1.25x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                  <option value={4}>4x</option>
                </select>
              </div>
            </>
          )}
          
          <div className="w-px h-4 bg-zinc-700" />
          
          <Button
            variant="outline"
            size="sm"
            className="h-6 border-zinc-700 text-zinc-400 text-[10px] px-2"
            onClick={() => setShowExportModal(true)}
          >
            <Download className="h-3 w-3 mr-1" />
            Export
          </Button>
          
          <Button
            variant="outline"
            size="sm"
            className="h-6 border-zinc-700 text-zinc-400 text-[10px] px-2"
            onClick={handleResetLayout}
            title="Reset panel sizes to default"
          >
            <Maximize2 className="h-3 w-3 mr-1" />
            Layout
          </Button>
          
          
          {/* Subtitle import/export */}
          {tracks.some(t => t.type === 'subtitle') && (
            <>
              <div className="w-px h-4 bg-zinc-700" />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => subtitleFileInputRef.current?.click()}
                  className="h-6 px-2 rounded bg-amber-900/30 border border-amber-700/30 text-amber-400 hover:bg-amber-900/50 text-[10px] flex items-center gap-1 transition-colors"
                  title="Import SRT subtitles"
                >
                  <FileUp className="h-3 w-3" />
                  Import SRT
                </button>
                <button
                  onClick={handleExportSrt}
                  disabled={subtitles.length === 0}
                  className="h-6 px-2 rounded bg-amber-900/30 border border-amber-700/30 text-amber-400 hover:bg-amber-900/50 text-[10px] flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Export SRT subtitles"
                >
                  <FileDown className="h-3 w-3" />
                  Export SRT
                </button>
              </div>
              <input
                ref={subtitleFileInputRef}
                type="file"
                accept=".srt"
                onChange={handleImportSrt}
                className="hidden"
              />
            </>
          )}
          
          {/* Spacer */}
          <div className="flex-1" />
          
          {/* Zoom slider bar */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { centerOnPlayheadRef.current = true; setZoom(Math.max(getMinZoom(), +(zoom - 0.25).toFixed(2))) }}
              className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Zoom out (-)"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={Math.max(1, Math.round(getMinZoom() * 100))}
              max={400}
              step={5}
              value={Math.round(zoom * 100)}
              onChange={(e) => { centerOnPlayheadRef.current = true; setZoom(Math.max(getMinZoom(), +(parseInt(e.target.value) / 100).toFixed(2))) }}
              className="w-28 h-1 accent-violet-500 cursor-pointer"
              title={`Zoom: ${Math.round(zoom * 100)}%`}
            />
            <button
              onClick={() => { centerOnPlayheadRef.current = true; setZoom(Math.min(4, +(zoom + 0.25).toFixed(2))) }}
              className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Zoom in (+)"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(zoom * 100)}%</span>
            <button
              onClick={handleFitToView}
              className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors ml-0.5"
              title="Fit to view (Ctrl+0)"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      
      {/* Right Panel - Subtitle Properties */}
      {selectedSubtitleId && selectedClipIds.size === 0 && (() => {
        const selectedSub = subtitles.find(s => s.id === selectedSubtitleId)
        if (!selectedSub) return null
        const trackStyle = tracks[selectedSub.trackIndex]?.subtitleStyle || {}
        const subStyle = { ...DEFAULT_SUBTITLE_STYLE, ...trackStyle, ...selectedSub.style }
        return (
          <>
          <div
            className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-amber-500/40 active:bg-amber-500/60 transition-colors relative group z-10"
            onMouseDown={(e) => handleResizeDragStart('right', e)}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
          <div className="flex-shrink-0 border-l border-zinc-800 bg-zinc-900 p-4 overflow-auto" style={{ width: layout.rightPanelWidth }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Subtitle
              </h3>
              <button
                onClick={() => deleteSubtitle(selectedSub.id)}
                className="p-1 rounded hover:bg-red-900/30 text-zinc-500 hover:text-red-400"
                title="Delete subtitle"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            
            <div className="space-y-4">
              {/* Subtitle text */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Text</label>
                <textarea
                  value={selectedSub.text}
                  onChange={(e) => updateSubtitle(selectedSub.id, { text: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-2.5 text-sm text-white resize-none focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30"
                  rows={3}
                  placeholder="Enter subtitle text..."
                />
              </div>
              
              {/* Timing */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Timing</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[9px] text-zinc-500 block mb-1">Start</span>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={parseFloat(selectedSub.startTime.toFixed(2))}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v >= 0 && v < selectedSub.endTime) {
                          updateSubtitle(selectedSub.id, { startTime: v })
                        }
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] text-zinc-500 block mb-1">End</span>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={parseFloat(selectedSub.endTime.toFixed(2))}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v > selectedSub.startTime) {
                          updateSubtitle(selectedSub.id, { endTime: v })
                        }
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                </div>
                <span className="text-[9px] text-zinc-600 mt-1 block">
                  Duration: {(selectedSub.endTime - selectedSub.startTime).toFixed(2)}s
                </span>
              </div>
              
              {/* Style */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Style</label>
                <div className="space-y-2">
                  {/* Font size */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Font Size</span>
                    <input
                      type="number"
                      min={12}
                      max={96}
                      value={subStyle.fontSize}
                      onChange={(e) => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, fontSize: parseInt(e.target.value) || 32 } })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white text-center focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                  
                  {/* Bold / Italic */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, fontWeight: subStyle.fontWeight === 'bold' ? 'normal' : 'bold' } })}
                      className={`px-2.5 py-1 rounded text-[10px] font-bold ${subStyle.fontWeight === 'bold' ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
                    >
                      B
                    </button>
                    <button
                      onClick={() => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, italic: !subStyle.italic } })}
                      className={`px-2.5 py-1 rounded text-[10px] italic ${subStyle.italic ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
                    >
                      I
                    </button>
                  </div>
                  
                  {/* Text color */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Text Color</span>
                    <input
                      type="color"
                      value={subStyle.color}
                      onChange={(e) => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, color: e.target.value } })}
                      className="w-7 h-6 rounded cursor-pointer border border-zinc-700"
                    />
                  </div>
                  
                  {/* Background toggle + color */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Background</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => updateSubtitle(selectedSub.id, { 
                          style: { ...selectedSub.style, backgroundColor: subStyle.backgroundColor === 'transparent' ? '#000000AA' : 'transparent' } 
                        })}
                        className={`px-2 py-0.5 rounded text-[9px] border ${
                          subStyle.backgroundColor !== 'transparent'
                            ? 'bg-amber-600/20 text-amber-300 border-amber-500/40'
                            : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                        }`}
                      >
                        {subStyle.backgroundColor !== 'transparent' ? 'On' : 'Off'}
                      </button>
                      {subStyle.backgroundColor !== 'transparent' && (
                        <input
                          type="color"
                          value={subStyle.backgroundColor.slice(0, 7)}
                          onChange={(e) => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, backgroundColor: e.target.value + 'CC' } })}
                          className="w-7 h-6 rounded cursor-pointer border border-zinc-700"
                        />
                      )}
                    </div>
                  </div>
                  
                  {/* Position */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">Position</span>
                    <select
                      value={subStyle.position}
                      onChange={(e) => updateSubtitle(selectedSub.id, { style: { ...selectedSub.style, position: e.target.value as SubtitleStyle['position'] } })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-amber-500/50"
                    >
                      <option value="bottom">Bottom</option>
                      <option value="center">Center</option>
                      <option value="top">Top</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </>
        )
      })()}
      
      {/* Right Panel - Clip Properties */}
      {selectedClipIds.size > 0 && (
        <>
        {/* Right resize handle */}
        <div
          className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-violet-500/40 active:bg-violet-500/60 transition-colors relative group z-10"
          onMouseDown={(e) => handleResizeDragStart('right', e)}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>
        <div className="flex-shrink-0 border-l border-zinc-800 bg-zinc-900 p-4 overflow-auto" style={{ width: layout.rightPanelWidth }}>
          
          {/* Multi-selection panel */}
          {selectedClipIds.size > 1 && (
            <div>
              <h3 className="text-sm font-semibold text-white mb-4">{selectedClipIds.size} Clips Selected</h3>
              
              <div className="space-y-3">
                <p className="text-xs text-zinc-400">
                  Use <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-mono">Shift</kbd> + click to add/remove clips.
                  Drag to draw a selection rectangle.
                </p>
                
                <div className="space-y-1.5">
                  {clips.filter(c => selectedClipIds.has(c.id)).map(c => (
                    <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-800/50 border border-zinc-700/50">
                      <div className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
                      <span className="text-[11px] text-zinc-300 truncate flex-1">
                        {c.asset?.prompt?.slice(0, 25) || c.importedName || 'Clip'}
                      </span>
                      <span className="text-[10px] text-zinc-500">{c.duration.toFixed(1)}s</span>
                    </div>
                  ))}
                </div>
                
                <div className="pt-3 border-t border-zinc-800 space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-zinc-700"
                    onClick={() => {
                      const selected = clips.filter(c => selectedClipIds.has(c.id))
                      const newClips = selected.map(c => ({
                        ...c,
                        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        startTime: c.startTime + c.duration,
                      }))
                      setClips(prev => [...prev, ...newClips])
                      setSelectedClipIds(new Set(newClips.map(c => c.id)))
                    }}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Duplicate All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-red-900 text-red-400 hover:bg-red-900/20"
                    onClick={() => {
                      setClips(prev => prev.filter(c => !selectedClipIds.has(c.id)))
                      setSelectedClipIds(new Set())
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete {selectedClipIds.size} Clips
                  </Button>
                </div>
                
                <button
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  onClick={() => setSelectedClipIds(new Set())}
                >
                  Clear selection
                </button>
              </div>
            </div>
          )}
          
          {/* Single-selection properties panel */}
          {selectedClip && (
            <>
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
                  {/* Reset button */}
                  <button
                    className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-violet-400 transition-colors"
                    onClick={() => updateClip(selectedClip.id, { colorCorrection: { ...DEFAULT_COLOR_CORRECTION } })}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset All
                  </button>
                  
                  {/* Exposure */}
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

                  {/* Brightness */}
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

                  {/* Contrast */}
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

                  {/* Saturation */}
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

                  {/* Temperature */}
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

                  {/* Tint */}
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

                  {/* Highlights */}
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

                  {/* Shadows */}
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

            <div className="pt-4 border-t border-zinc-800 space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full border-zinc-700"
                onClick={() => splitClipAtPlayhead(selectedClip.id)}
              >
                <Scissors className="h-4 w-4 mr-2" />
                Split at Playhead
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full border-zinc-700"
                onClick={() => duplicateClip(selectedClip.id)}
              >
                <Copy className="h-4 w-4 mr-2" />
                Duplicate
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full border-red-900 text-red-400 hover:bg-red-900/20"
                onClick={() => removeClip(selectedClip.id)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Clip
              </Button>
            </div>
          </>
          )}
        </div>
        </>
      )}
      
      {/* Export Modal */}
      {/* Asset right-click context menu */}
      {assetContextMenu && (() => {
        const asset = assets.find(a => a.id === assetContextMenu.assetId)
        if (!asset) return null
        
        // Determine which assets are targeted: multi-selection or just the one
        const targetIds = selectedAssetIds.size > 0 && selectedAssetIds.has(asset.id)
          ? [...selectedAssetIds]
          : [asset.id]
        const isMulti = targetIds.length > 1
        
        return (
          <div
            ref={assetContextMenuRef}
            className="fixed bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl py-1.5 z-[60] min-w-[180px] text-xs"
            style={{ left: assetContextMenu.x, top: assetContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {isMulti && (
              <div className="px-3 py-1 text-[10px] text-violet-400 font-medium">
                {targetIds.length} assets selected
              </div>
            )}
            
            {!isMulti && (
              <button
                onClick={() => {
                  addClipToTimeline(asset, 0)
                  setAssetContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Plus className="h-3.5 w-3.5 text-zinc-500" />
                <span>Add to Timeline</span>
              </button>
            )}
            
            {!isMulti && asset.generationParams && (
              <>
                {isRegenerating && regeneratingAssetId === asset.id ? (
                  <button
                    onClick={() => {
                      handleCancelRegeneration()
                      setAssetContextMenu(null)
                    }}
                    className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-3"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>Cancel Regeneration</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      handleRegenerate(asset.id)
                      setAssetContextMenu(null)
                    }}
                    disabled={isRegenerating}
                    className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5 text-zinc-500" />
                    <span>Regenerate</span>
                  </button>
                )}
                {/* Take navigation + view all takes */}
                {asset.takes && asset.takes.length > 1 && (
                  <>
                    <div className="px-3 py-1.5 flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500">Take:</span>
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
                        className="p-0.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-white disabled:text-zinc-600 disabled:hover:bg-transparent"
                      >
                        <ChevronLeft className="h-3 w-3" />
                      </button>
                      <span className="text-[10px] text-zinc-300 min-w-[28px] text-center">
                        {(asset.activeTakeIndex ?? 0) + 1}/{asset.takes.length}
                      </span>
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
                        className="p-0.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-white disabled:text-zinc-600 disabled:hover:bg-transparent"
                      >
                        <ChevronRight className="h-3 w-3" />
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        setTakesViewAssetId(asset.id)
                        setSelectedAssetIds(new Set())
                        setAssetContextMenu(null)
                      }}
                      className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                    >
                      <Layers className="h-3.5 w-3.5 text-zinc-500" />
                      <span>View All Takes</span>
                    </button>
                    <button
                      onClick={() => {
                        if (!currentProjectId || !asset.takes) return
                        pushAssetUndoRef.current()
                        // Keep the first take as the current asset, create new assets for the rest
                        asset.takes.slice(1).forEach(take => {
                          addAsset(currentProjectId, {
                            type: asset.type,
                            path: take.path,
                            url: take.url,
                            prompt: asset.prompt,
                            resolution: asset.resolution,
                            duration: asset.duration,
                            thumbnail: take.thumbnail,
                            generationParams: asset.generationParams,
                            takes: [{ url: take.url, path: take.path, thumbnail: take.thumbnail, createdAt: take.createdAt }],
                            activeTakeIndex: 0,
                          })
                        })
                        // Reset the original asset to only have its first take
                        const firstTake = asset.takes[0]
                        updateAsset(currentProjectId, asset.id, {
                          takes: [firstTake],
                          activeTakeIndex: 0,
                          url: firstTake.url,
                          path: firstTake.path,
                          thumbnail: firstTake.thumbnail || asset.thumbnail,
                        })
                        setAssetContextMenu(null)
                      }}
                      className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                    >
                      <GitMerge className="h-3.5 w-3.5 text-zinc-500 rotate-180" />
                      <span>Ungroup Takes</span>
                    </button>
                    <button
                      onClick={() => {
                        const activeIdx = asset.activeTakeIndex ?? 0
                        if (confirm(`Delete take ${activeIdx + 1}?`)) {
                          if (currentProjectId && asset.takes) {
                            pushAssetUndoRef.current()
                            // Update any clips referencing this asset
                            setClips(prev => prev.map(c => {
                              if (c.assetId !== asset.id) return c
                              const cIdx = c.takeIndex ?? (asset.activeTakeIndex ?? asset.takes!.length - 1)
                              if (cIdx === activeIdx) {
                                return { ...c, takeIndex: Math.max(0, activeIdx - 1) }
                              } else if (cIdx > activeIdx) {
                                return { ...c, takeIndex: cIdx - 1 }
                              }
                              return c
                            }))
                            deleteTakeFromAsset(currentProjectId, asset.id, activeIdx)
                          }
                        }
                        setAssetContextMenu(null)
                      }}
                      className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-900/30 flex items-center gap-3"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete Active Take</span>
                    </button>
                  </>
                )}
              </>
            )}
            
            <div className="h-px bg-zinc-700 my-1" />
            
            {/* Move to Bin submenu */}
            <div className="px-3 py-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Move to Bin</div>
            
            <button
              onClick={() => {
                if (currentProjectId) {
                  pushAssetUndoRef.current()
                  targetIds.forEach(id => updateAsset(currentProjectId, id, { bin: undefined }))
                }
                setAssetContextMenu(null)
                setSelectedAssetIds(new Set())
              }}
              className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
            >
              <X className="h-3.5 w-3.5 text-zinc-500" />
              <span>Remove from Bin</span>
            </button>
            
            {bins.map(bin => (
              <button
                key={bin}
                onClick={() => {
                  if (currentProjectId) {
                    pushAssetUndoRef.current()
                    targetIds.forEach(id => updateAsset(currentProjectId, id, { bin }))
                  }
                  setAssetContextMenu(null)
                  setSelectedAssetIds(new Set())
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Folder className="h-3.5 w-3.5 text-zinc-500" />
                <span>{bin}</span>
              </button>
            ))}
            
            <button
              onClick={() => {
                const name = prompt('New bin name:')
                if (name?.trim() && currentProjectId) {
                  pushAssetUndoRef.current()
                  targetIds.forEach(id => updateAsset(currentProjectId, id, { bin: name.trim() }))
                }
                setAssetContextMenu(null)
                setSelectedAssetIds(new Set())
              }}
              className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
            >
              <FolderPlus className="h-3.5 w-3.5 text-zinc-500" />
              <span>New Bin...</span>
            </button>
            
            {isMulti && (
              <>
                <div className="h-px bg-zinc-700 my-1" />
                <button
                  onClick={() => {
                    if (!currentProjectId) return
                    const selectedAssets = assets.filter(a => targetIds.includes(a.id))
                    if (selectedAssets.length < 2) return
                    pushAssetUndoRef.current()
                    const primary = selectedAssets[0]
                    const newTakes = selectedAssets.map(a => ({
                      url: a.url, path: a.path, thumbnail: a.thumbnail, createdAt: a.createdAt,
                    }))
                    updateAsset(currentProjectId, primary.id, { takes: newTakes, activeTakeIndex: 0 })
                    selectedAssets.slice(1).forEach(a => deleteAsset(currentProjectId, a.id))
                    setSelectedAssetIds(new Set())
                    setAssetContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  <span>Group as Takes</span>
                </button>
                <button
                  onClick={() => {
                    setSelectedAssetIds(new Set())
                    setAssetContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
                >
                  <X className="h-3.5 w-3.5 text-zinc-500" />
                  <span>Clear Selection</span>
                </button>
              </>
            )}
            
            <div className="h-px bg-zinc-700 my-1" />
            
            <button
              onClick={() => {
                if (currentProjectId) {
                  pushAssetUndoRef.current()
                  targetIds.forEach(id => deleteAsset(currentProjectId, id))
                }
                setAssetContextMenu(null)
                setSelectedAssetIds(new Set())
              }}
              className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-3"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{isMulti ? `Delete ${targetIds.length} Assets` : 'Delete Asset'}</span>
            </button>
          </div>
        )
      })()}
      
      {/* Take right-click context menu */}
      {takeContextMenu && (() => {
        const tcAsset = assets.find(a => a.id === takeContextMenu.assetId)
        if (!tcAsset?.takes) return null
        const take = tcAsset.takes[takeContextMenu.takeIndex]
        if (!take) return null
        const isActive = (tcAsset.activeTakeIndex ?? 0) === takeContextMenu.takeIndex
        
        return (
          <div
            ref={takeContextMenuRef}
            className="fixed bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl py-1.5 z-[60] min-w-[190px] text-xs"
            style={{ left: takeContextMenu.x, top: takeContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-[10px] text-zinc-500 font-medium">
              Take {takeContextMenu.takeIndex + 1} of {tcAsset.takes.length}
            </div>
            
            {!isActive && (
              <button
                onClick={() => {
                  if (currentProjectId) { pushAssetUndoRef.current(); setAssetActiveTake(currentProjectId, tcAsset.id, takeContextMenu.takeIndex) }
                  setTakeContextMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
              >
                <Eye className="h-3.5 w-3.5 text-zinc-500" />
                <span>Set as Active Take</span>
              </button>
            )}
            
            <button
              onClick={() => {
                addClipToTimeline({ ...tcAsset, url: take.url, path: take.path }, 0)
                setTakeContextMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
            >
              <Plus className="h-3.5 w-3.5 text-zinc-500" />
              <span>Add to Timeline</span>
            </button>
            
            <div className="h-px bg-zinc-700 my-1" />
            
            <button
              onClick={() => {
                if (currentProjectId) {
                  pushAssetUndoRef.current()
                  addAsset(currentProjectId, {
                    type: tcAsset.type,
                    path: take.path,
                    url: take.url,
                    prompt: tcAsset.prompt,
                    resolution: tcAsset.resolution,
                    duration: tcAsset.duration,
                    thumbnail: take.thumbnail,
                    generationParams: tcAsset.generationParams,
                    takes: [{ url: take.url, path: take.path, thumbnail: take.thumbnail, createdAt: take.createdAt }],
                    activeTakeIndex: 0,
                  })
                }
                setTakeContextMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-zinc-700 flex items-center gap-3"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>Create New Asset from Take</span>
            </button>
            
            {tcAsset.takes.length > 1 && (
              <>
                <div className="h-px bg-zinc-700 my-1" />
                <button
                  onClick={() => {
                    if (confirm(`Delete take ${takeContextMenu.takeIndex + 1}?`)) {
                      if (currentProjectId) {
                        pushAssetUndoRef.current()
                        // Update any clips referencing this asset
                        setClips(prev => prev.map(c => {
                          if (c.assetId !== tcAsset.id) return c
                          const cIdx = c.takeIndex ?? (tcAsset.activeTakeIndex ?? tcAsset.takes!.length - 1)
                          if (cIdx === takeContextMenu.takeIndex) {
                            return { ...c, takeIndex: Math.max(0, takeContextMenu.takeIndex - 1) }
                          } else if (cIdx > takeContextMenu.takeIndex) {
                            return { ...c, takeIndex: cIdx - 1 }
                          }
                          return c
                        }))
                        deleteTakeFromAsset(currentProjectId, tcAsset.id, takeContextMenu.takeIndex)
                      }
                    }
                    setTakeContextMenu(null)
                  }}
                  className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-900/30 flex items-center gap-3"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete Take</span>
                </button>
              </>
            )}
          </div>
        )
      })()}
      
      {/* Bin right-click context menu */}
      {binContextMenu && (
        <div
          ref={binContextMenuRef}
          className="fixed bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl py-1.5 z-[60] min-w-[160px] text-xs"
          style={{ left: binContextMenu.x, top: binContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              const newName = prompt('Rename bin:', binContextMenu.bin)
              if (newName?.trim() && currentProjectId && newName.trim() !== binContextMenu.bin) {
                pushAssetUndoRef.current()
                for (const asset of assets.filter(a => a.bin === binContextMenu.bin)) {
                  updateAsset(currentProjectId, asset.id, { bin: newName.trim() })
                }
                if (selectedBin === binContextMenu.bin) setSelectedBin(newName.trim())
              }
              setBinContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Pencil className="h-3.5 w-3.5 text-zinc-500" />
            <span>Rename Bin</span>
          </button>
          <button
            onClick={() => {
              if (currentProjectId) {
                pushAssetUndoRef.current()
                for (const asset of assets.filter(a => a.bin === binContextMenu.bin)) {
                  updateAsset(currentProjectId, asset.id, { bin: undefined })
                }
                if (selectedBin === binContextMenu.bin) setSelectedBin(null)
              }
              setBinContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-zinc-700 flex items-center gap-3"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete Bin</span>
          </button>
        </div>
      )}
      
      {/* Clip right-click context menu */}
      {clipContextMenu && (() => {
        const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
        const isBackground = !contextClip // clipId === '' means background click
        const multiSelected = selectedClipIds.size > 1
        const hasClipboard = clipboardRef.current.length > 0
        
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
                            // Switch filters so the asset is visible in the grid
                            setAssetFilter('all')
                            setSelectedBin(asset.bin ?? null)
                            setTakesViewAssetId(null)
                            // Select the asset
                            setSelectedAssetIds(new Set([asset.id]))
                            // Scroll to it after a tick (so the grid re-renders with the right filters)
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
                      // Get the file path for the current take
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
      })()}
      
      {/* Upscale Timeline Dialog */}
      {showUpscaleDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl p-6 w-[400px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Upscale Timeline</h3>
            <p className="text-sm text-zinc-400 mb-1">
              This will upscale all video clips in the timeline (2x resolution) using the LTX API.
            </p>
            <p className="text-xs text-zinc-500 mb-5">
              Each clip will be sent to the upscale API one at a time. This may take a while depending on the number of clips.
            </p>
            
            <div className="flex flex-col gap-2 mb-4">
              <button
                onClick={() => handleUpscaleTimeline(showUpscaleDialog.timelineId, 'duplicate')}
                className="w-full text-left px-4 py-3 rounded-xl bg-blue-600/20 border border-blue-500/40 hover:bg-blue-600/30 hover:border-blue-500/60 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Copy className="h-4 w-4 text-blue-400" />
                  <div>
                    <div className="text-sm font-medium text-white">Duplicate & Upscale</div>
                    <div className="text-[11px] text-zinc-400">Creates a copy of the timeline with upscaled clips. Original is preserved.</div>
                  </div>
                </div>
                <span className="text-[10px] text-blue-400 font-medium ml-7">Recommended</span>
              </button>
              
              <button
                onClick={() => handleUpscaleTimeline(showUpscaleDialog.timelineId, 'replace')}
                className="w-full text-left px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className="h-4 w-4 text-zinc-400" />
                  <div>
                    <div className="text-sm font-medium text-zinc-300">Replace in Place</div>
                    <div className="text-[11px] text-zinc-500">Upscales clips in the current timeline. Cannot be undone.</div>
                  </div>
                </div>
              </button>
            </div>
            
            <button
              onClick={() => setShowUpscaleDialog(null)}
              className="w-full text-center py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {/* Timeline Upscale Progress Bar */}
      {upscaleTimelineProgress?.active && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-zinc-900 border border-blue-500/40 rounded-xl shadow-2xl px-5 py-3 flex items-center gap-3">
          <Loader2 className="h-4 w-4 text-blue-400 animate-spin flex-shrink-0" />
          <div className="flex flex-col gap-1 min-w-[180px]">
            <span className="text-xs text-white font-medium">
              Upscaling clip {upscaleTimelineProgress.current} of {upscaleTimelineProgress.total}
            </span>
            <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${(upscaleTimelineProgress.current / upscaleTimelineProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}
      
      <ExportModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        clips={clips}
        tracks={tracks}
        timeline={activeTimeline}
        projectName={currentProject?.name || 'Untitled'}
      />
      
      <ImportTimelineModal
        isOpen={showImportTimelineModal}
        onClose={() => setShowImportTimelineModal(false)}
        onImport={handleImportTimeline}
      />
      
      {/* Gap generate modal */}
      {selectedGap && gapGenerateMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  gapGenerateMode === 'text-to-video' ? 'bg-violet-600/20' : 
                  gapGenerateMode === 'image-to-video' ? 'bg-blue-600/20' : 'bg-emerald-600/20'
                }`}>
                  {gapGenerateMode === 'text-to-video' ? <Video className="h-3.5 w-3.5 text-violet-400" /> :
                   gapGenerateMode === 'image-to-video' ? <Film className="h-3.5 w-3.5 text-blue-400" /> :
                   <Image className="h-3.5 w-3.5 text-emerald-400" />}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    {gapGenerateMode === 'text-to-video' ? 'Generate Video' :
                     gapGenerateMode === 'image-to-video' ? 'Image to Video' : 'Generate Image'}
                  </h2>
                  <p className="text-[10px] text-zinc-500">
                    Fill {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s gap on Track {selectedGap.trackIndex + 1}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => { setGapGenerateMode(null); regenReset() }}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            {/* Animated gap fill visualization */}
            {(gapBeforeFrame || gapAfterFrame) && (
              <div className="px-5 pt-4 pb-2">
                <div className="relative h-20 rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 flex">
                  {/* Before frame (left) */}
                  <div className="relative w-1/3 h-full flex-shrink-0 overflow-hidden">
                    {gapBeforeFrame ? (
                      <img src={gapBeforeFrame} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-zinc-600 text-[9px]">No clip</span>
                      </div>
                    )}
                    {/* Fade edge */}
                    <div className="absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-zinc-900/80 to-transparent" />
                  </div>
                  
                  {/* Center: animated "new shot" breathing placeholder */}
                  <div 
                    className="flex-1 relative overflow-hidden"
                    style={{ animation: 'gapBreathe 3s ease-in-out infinite' }}
                  >
                    {/* Background with breathing glow */}
                    <div className="absolute inset-0 bg-zinc-900" />
                    <div 
                      className="absolute inset-0"
                      style={{ animation: 'gapGlow 3s ease-in-out infinite' }}
                    />
                    {/* Shimmer sweep */}
                    <div 
                      className="absolute inset-0"
                      style={{
                        background: 'linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.12) 40%, rgba(139,92,246,0.2) 50%, rgba(139,92,246,0.12) 60%, transparent 100%)',
                        animation: 'gapFillSweep 3s ease-in-out infinite',
                      }}
                    />
                    {/* Border glow pulse */}
                    <div 
                      className="absolute inset-0 border border-violet-500/20 rounded-sm"
                      style={{ animation: 'gapBorderGlow 3s ease-in-out infinite' }}
                    />
                    {/* Label */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
                      <Sparkles className="h-3.5 w-3.5 text-violet-400/50 mb-1.5" />
                      <span className="text-[9px] text-violet-300/60 font-semibold tracking-wide">AI Shot Suggestion</span>
                      <span className="text-[7px] text-zinc-500 mt-0.5 text-center leading-tight">Visually &amp; narratively consistent with your timeline</span>
                    </div>
                  </div>
                  
                  {/* After frame (right) */}
                  <div className="relative w-1/3 h-full flex-shrink-0 overflow-hidden">
                    {gapAfterFrame ? (
                      <img src={gapAfterFrame} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-zinc-600 text-[9px]">No clip</span>
                      </div>
                    )}
                    {/* Fade edge */}
                    <div className="absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-zinc-900/80 to-transparent" />
                  </div>
                </div>
                {/* CSS keyframes for the animation */}
                <style>{`
                  @keyframes gapFillSweep {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                  }
                  @keyframes gapBreathe {
                    0%, 100% { transform: scaleX(0.97); opacity: 0.85; }
                    50% { transform: scaleX(1); opacity: 1; }
                  }
                  @keyframes gapGlow {
                    0%, 100% { background: radial-gradient(ellipse at center, rgba(139,92,246,0.06) 0%, transparent 70%); }
                    50% { background: radial-gradient(ellipse at center, rgba(139,92,246,0.15) 0%, transparent 70%); }
                  }
                  @keyframes gapBorderGlow {
                    0%, 100% { border-color: rgba(139,92,246,0.1); }
                    50% { border-color: rgba(139,92,246,0.35); }
                  }
                `}</style>
              </div>
            )}
            
            {/* Body */}
            <div className="flex-1 overflow-auto p-5 space-y-4">
              {/* Prompt */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Prompt</label>
                  {gapSuggesting && (
                    <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Analyzing timeline context...</span>
                    </div>
                  )}
                  {!gapSuggesting && gapSuggestion && gapPrompt === gapSuggestion && (
                    <div className="flex items-center gap-1 text-[10px] text-emerald-400/70">
                      <Sparkles className="h-3 w-3" />
                      <span>AI-suggested from timeline</span>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <textarea
                    value={gapPrompt}
                    onChange={(e) => setGapPrompt(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={gapSuggesting 
                      ? 'Analyzing surrounding shots for context...'
                      : gapGenerateMode === 'text-to-image' 
                      ? 'Describe the image to generate...' 
                      : 'Describe the video shot to generate...'}
                    className={`w-full bg-zinc-800 border rounded-lg p-3 text-sm text-white resize-none focus:outline-none focus:ring-1 placeholder-zinc-600 ${
                      gapSuggesting 
                        ? 'border-amber-600/40 focus:border-amber-500/50 focus:ring-amber-500/30 animate-pulse' 
                        : 'border-zinc-700 focus:border-violet-500/50 focus:ring-violet-500/30'
                    }`}
                    rows={3}
                  />
                  {gapSuggestion && gapPrompt !== gapSuggestion && !gapSuggesting && (
                    <button
                      onClick={() => setGapPrompt(gapSuggestion)}
                      className="absolute top-1.5 right-1.5 px-2 py-1 rounded-md bg-amber-900/40 border border-amber-700/30 text-amber-300 text-[10px] hover:bg-amber-900/60 transition-colors flex items-center gap-1"
                      title="Use AI-suggested prompt"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      Use suggestion
                    </button>
                  )}
                </div>
              </div>
              
              {/* Image input for I2V */}
              {gapGenerateMode === 'image-to-video' && (
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Input Image</label>
                  {gapImageFile ? (
                    <div className="flex items-center gap-3 bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                      <img 
                        src={URL.createObjectURL(gapImageFile)} 
                        alt="" 
                        className="w-16 h-10 object-cover rounded" 
                      />
                      <span className="text-xs text-zinc-300 flex-1 truncate">{gapImageFile.name}</span>
                      <button 
                        onClick={() => setGapImageFile(null)}
                        className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-red-400"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => gapImageInputRef.current?.click()}
                      className="w-full border-2 border-dashed border-zinc-700 hover:border-blue-500/50 rounded-lg p-4 text-center cursor-pointer transition-colors group"
                    >
                      <Upload className="h-5 w-5 text-zinc-600 group-hover:text-blue-400 mx-auto mb-1 transition-colors" />
                      <p className="text-xs text-zinc-500 group-hover:text-zinc-400">Click to select input image</p>
                    </button>
                  )}
                  <input
                    ref={gapImageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) setGapImageFile(file)
                      if (gapImageInputRef.current) gapImageInputRef.current.value = ''
                    }}
                    className="hidden"
                  />
                </div>
              )}
              
              {/* Settings */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Settings</label>
                <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                  <SettingsPanel
                    settings={gapSettings}
                    onSettingsChange={setGapSettings}
                    disabled={isRegenerating}
                    mode={gapGenerateMode}
                  />
                </div>
              </div>
              
              {/* Progress */}
              {isRegenerating && (
                <div className="bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                  <div className="flex items-center gap-2 mb-2">
                    <Loader2 className="h-3.5 w-3.5 text-violet-400 animate-spin" />
                    <span className="text-xs text-zinc-300">{regenStatusMessage || 'Generating...'}</span>
                  </div>
                  <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-violet-500 rounded-full transition-all duration-300"
                      style={{ width: `${regenProgress * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            
            {/* Footer */}
            <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between">
              <span className="text-[10px] text-zinc-600">
                Duration: {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setGapGenerateMode(null); regenReset() }}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleGapGenerate}
                  disabled={isRegenerating || !gapPrompt.trim() || (gapGenerateMode === 'image-to-video' && !gapImageFile)}
                  className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-500 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {isRegenerating ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" />
                      Generate
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Gap action bar - shown when gap is selected but no generate mode yet */}
      {selectedGap && !gapGenerateMode && (
        <div 
          className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-3"
          style={{
            bottom: '220px',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-zinc-400 font-medium">
              {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s gap selected
            </span>
            <span className="text-[9px] text-zinc-600">
              (Press <kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 text-[8px] font-mono">Del</kbd> to close gap)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => deleteGap(selectedGap)}
              className="px-3 py-1.5 rounded-lg bg-red-900/30 border border-red-800/30 text-red-400 text-[11px] hover:bg-red-900/50 transition-colors flex items-center gap-1.5"
            >
              <Trash2 className="h-3 w-3" />
              Close Gap
            </button>
            <div className="w-px h-5 bg-zinc-700" />
            <span className="text-[10px] text-zinc-500 px-1">Generate:</span>
            <button
              onClick={() => setGapGenerateMode('text-to-video')}
              className="px-3 py-1.5 rounded-lg bg-violet-900/30 border border-violet-700/30 text-violet-400 text-[11px] hover:bg-violet-900/50 transition-colors flex items-center gap-1.5"
            >
              <Video className="h-3 w-3" />
              T2V
            </button>
            <button
              onClick={() => setGapGenerateMode('image-to-video')}
              className="px-3 py-1.5 rounded-lg bg-blue-900/30 border border-blue-700/30 text-blue-400 text-[11px] hover:bg-blue-900/50 transition-colors flex items-center gap-1.5"
            >
              <Film className="h-3 w-3" />
              I2V
            </button>
            <button
              onClick={() => setGapGenerateMode('text-to-image')}
              className="px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 text-[11px] hover:bg-emerald-900/50 transition-colors flex items-center gap-1.5"
            >
              <Image className="h-3 w-3" />
              T2I
            </button>
          </div>
        </div>
      )}
      
      {/* Image-to-Video generation modal */}
      {i2vClipId && (() => {
        const i2vClip = clips.find(c => c.id === i2vClipId)
        if (!i2vClip) return null
        const i2vImageUrl = resolveClipSrc(i2vClip)
        
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-blue-600/20">
                    <Film className="h-3.5 w-3.5 text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-white">Image to Video</h2>
                    <p className="text-[10px] text-zinc-500">
                      Generate video from image clip ({i2vClip.duration.toFixed(1)}s)
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => { setI2vClipId(null); regenReset() }}
                  className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              
              {/* Body */}
              <div className="flex-1 overflow-auto p-5 space-y-4">
                {/* Source image preview */}
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Source Image</label>
                  <div className="rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800">
                    <img 
                      src={i2vImageUrl} 
                      alt="Source" 
                      className="w-full max-h-40 object-contain" 
                    />
                  </div>
                </div>
                
                {/* Prompt */}
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Prompt</label>
                  <textarea
                    value={i2vPrompt}
                    onChange={(e) => setI2vPrompt(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Describe the motion and action for the video..."
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-sm text-white resize-none focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 placeholder-zinc-600"
                    rows={3}
                  />
                </div>
                
                {/* Settings */}
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Settings</label>
                  <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                    <SettingsPanel
                      settings={i2vSettings}
                      onSettingsChange={setI2vSettings}
                      disabled={isRegenerating}
                      mode="image-to-video"
                    />
                  </div>
                </div>
                
                {/* Progress */}
                {isRegenerating && i2vClipId && (
                  <div className="bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                    <div className="flex items-center gap-2 mb-2">
                      <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />
                      <span className="text-xs text-zinc-300">{regenStatusMessage || 'Generating video...'}</span>
                    </div>
                    <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-blue-500 rounded-full transition-all duration-300"
                        style={{ width: `${regenProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              
              {/* Footer */}
              <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between">
                <span className="text-[10px] text-zinc-600">
                  Clip duration: {i2vClip.duration.toFixed(1)}s
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setI2vClipId(null); regenReset() }}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleI2vGenerate}
                    disabled={isRegenerating || !i2vPrompt.trim()}
                    className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-500 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {isRegenerating ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" />
                        Generate Video
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      
      {/* Global subtitle track style editor modal */}
      {subtitleTrackStyleIdx !== null && (() => {
        const stTrack = tracks[subtitleTrackStyleIdx]
        if (!stTrack || stTrack.type !== 'subtitle') return null
        const ts = { ...DEFAULT_SUBTITLE_STYLE, ...stTrack.subtitleStyle }
        const updateTrackStyle = (patch: Partial<SubtitleStyle>) => {
          setTracks(prev => prev.map((t, i) => i === subtitleTrackStyleIdx ? { ...t, subtitleStyle: { ...t.subtitleStyle, ...patch } } : t))
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSubtitleTrackStyleIdx(null)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[380px] max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-amber-600/20">
                    <Palette className="h-3.5 w-3.5 text-amber-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-white">Track Style</h2>
                    <p className="text-[10px] text-zinc-500">{stTrack.name} — applies to all subtitles on this track</p>
                  </div>
                </div>
                <button onClick={() => setSubtitleTrackStyleIdx(null)} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-auto p-5 space-y-3">
                {/* Preview */}
                <div className="bg-zinc-950 rounded-lg p-4 flex items-center justify-center border border-zinc-800 min-h-[60px]">
                  <span
                    className="inline-block text-center rounded px-3 py-1.5 leading-snug"
                    style={{
                      fontSize: `${Math.min(ts.fontSize, 28)}px`,
                      fontFamily: ts.fontFamily,
                      fontWeight: ts.fontWeight,
                      fontStyle: ts.italic ? 'italic' : 'normal',
                      color: ts.color,
                      backgroundColor: ts.backgroundColor,
                      textShadow: '1px 1px 3px rgba(0,0,0,0.8)',
                    }}
                  >
                    Preview subtitle
                  </span>
                </div>

                {/* Font size */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Font Size</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={16} max={72} value={ts.fontSize}
                      onChange={e => updateTrackStyle({ fontSize: parseInt(e.target.value) })}
                      className="w-24 accent-amber-500"
                    />
                    <span className="text-[10px] text-zinc-300 w-8 text-right tabular-nums">{ts.fontSize}px</span>
                  </div>
                </div>

                {/* Font family */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Font</span>
                  <select
                    value={ts.fontFamily}
                    onChange={e => updateTrackStyle({ fontFamily: e.target.value })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-amber-500/50"
                  >
                    <option value="sans-serif">Sans-Serif</option>
                    <option value="serif">Serif</option>
                    <option value="monospace">Monospace</option>
                    <option value="'Arial', sans-serif">Arial</option>
                    <option value="'Helvetica Neue', sans-serif">Helvetica</option>
                    <option value="'Georgia', serif">Georgia</option>
                    <option value="'Courier New', monospace">Courier New</option>
                    <option value="'Times New Roman', serif">Times New Roman</option>
                  </select>
                </div>

                {/* Bold / Italic */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Style</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateTrackStyle({ fontWeight: ts.fontWeight === 'bold' ? 'normal' : 'bold' })}
                      className={`px-2.5 py-1 rounded text-[10px] font-bold ${ts.fontWeight === 'bold' ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
                    >
                      B
                    </button>
                    <button
                      onClick={() => updateTrackStyle({ italic: !ts.italic })}
                      className={`px-2.5 py-1 rounded text-[10px] italic ${ts.italic ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
                    >
                      I
                    </button>
                  </div>
                </div>

                {/* Text color */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Text Color</span>
                  <input type="color" value={ts.color} onChange={e => updateTrackStyle({ color: e.target.value })} className="w-7 h-6 rounded cursor-pointer border border-zinc-700" />
                </div>

                {/* Background toggle + color */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Background</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => updateTrackStyle({ backgroundColor: ts.backgroundColor === 'transparent' ? '#000000AA' : 'transparent' })}
                      className={`px-2 py-0.5 rounded text-[9px] border ${ts.backgroundColor !== 'transparent' ? 'bg-amber-600/20 text-amber-300 border-amber-500/40' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                    >
                      {ts.backgroundColor !== 'transparent' ? 'On' : 'Off'}
                    </button>
                    {ts.backgroundColor !== 'transparent' && (
                      <input type="color" value={ts.backgroundColor.slice(0, 7)} onChange={e => updateTrackStyle({ backgroundColor: e.target.value + 'CC' })} className="w-7 h-6 rounded cursor-pointer border border-zinc-700" />
                    )}
                  </div>
                </div>

                {/* Position */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Position</span>
                  <select
                    value={ts.position}
                    onChange={e => updateTrackStyle({ position: e.target.value as SubtitleStyle['position'] })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-white focus:outline-none focus:border-amber-500/50"
                  >
                    <option value="bottom">Bottom</option>
                    <option value="center">Center</option>
                    <option value="top">Top</option>
                  </select>
                </div>

                <div className="border-t border-zinc-800 pt-3 mt-3">
                  <button
                    onClick={() => {
                      // Apply track style to all existing subtitles on this track (clear per-sub overrides)
                      setSubtitles(prev => prev.map(s => s.trackIndex === subtitleTrackStyleIdx ? { ...s, style: undefined } : s))
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors text-center"
                  >
                    Apply to all subtitles (reset individual overrides)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
