import React from 'react'
import {
  MousePointer2, ChevronRight, Scissors, Hand,
  ArrowLeftRight, GitMerge, MoveHorizontal, Gauge,
} from 'lucide-react'
import { formatKeyCombo, type ActionId, type KeyboardLayout } from '../../lib/keyboard-shortcuts'
import type { TimelineClip, TransitionType, Track } from '../../types/project'
import { DEFAULT_COLOR_CORRECTION } from '../../types/project'

// ── Tool types & definitions ────────────────────────────────────────

export type ToolType = 'select' | 'trackForward' | 'blade' | 'hand' | 'slip' | 'slide' | 'ripple' | 'roll'

export type ToolDef = { id: ToolType; icon: any; label: string; actionId: ActionId }

export const PRIMARY_TOOLS: ToolDef[] = [
  { id: 'select', icon: MousePointer2, label: 'Selection Tool', actionId: 'tool.select' },
  { id: 'trackForward', icon: ChevronRight, label: 'Track Select Forward', actionId: 'tool.trackForward' },
  { id: 'blade', icon: Scissors, label: 'Blade Tool', actionId: 'tool.blade' },
  { id: 'hand', icon: Hand, label: 'Hand Tool', actionId: 'tool.hand' },
]

export const TRIM_TOOLS: ToolDef[] = [
  { id: 'ripple', icon: ArrowLeftRight, label: 'Ripple Trim', actionId: 'tool.ripple' },
  { id: 'roll', icon: GitMerge, label: 'Roll Trim (A/B)', actionId: 'tool.roll' },
  { id: 'slip', icon: MoveHorizontal, label: 'Slip Tool', actionId: 'tool.slip' },
  { id: 'slide', icon: Gauge, label: 'Slide Tool', actionId: 'tool.slide' },
]

// ── Constants ────────────────────────────────────────────────────────

/** Debounce delay for auto-saving timeline changes to context (ms) */
export const AUTOSAVE_DELAY = 500

/** Max number of undo steps */
export const MAX_UNDO_HISTORY = 50

/** Undo action types */
export type UndoAction =
  | { type: 'clips'; clips: TimelineClip[] }
  | { type: 'assets'; assets: import('../../types/project').Asset[] }

/** Tolerance in seconds for detecting adjacent clips (cut points) */
export const CUT_POINT_TOLERANCE = 0.05

/** Default cross-dissolve duration in seconds */
export const DEFAULT_DISSOLVE_DURATION = 0.5

// ── Resizable layout constants ───────────────────────────────────────

export const LAYOUT_STORAGE_KEY = 'ltx-video-editor-layout'

export interface EditorLayout {
  leftPanelWidth: number   // px
  rightPanelWidth: number  // px
  timelineHeight: number   // px
  assetsHeight: number     // px – height of assets section in left panel (timelines gets the rest)
}

export const DEFAULT_LAYOUT: EditorLayout = {
  leftPanelWidth: 288,   // w-72
  rightPanelWidth: 256,   // w-64
  timelineHeight: 224,    // h-56
  assetsHeight: 0,        // 0 = auto (use flex proportions)
}

export const LAYOUT_LIMITS = {
  leftPanelWidth:  { min: 180, max: 480 },
  rightPanelWidth: { min: 200, max: 480 },
  timelineHeight:  { min: 120, max: 600 },
  assetsHeight:    { min: 120, max: 800 },
}

// ── Pure helper functions ────────────────────────────────────────────

/** Get the display shortcut string for an action from the active layout */
export function getShortcutLabel(layout: KeyboardLayout, actionId: ActionId): string {
  const combos = layout[actionId]
  if (!combos || combos.length === 0) return ''
  return formatKeyCombo(combos[0])
}

/**
 * Overwrite helper: given a moved/placed clip, trim or split any clips
 * on the same track that it overlaps. Returns the updated clips array.
 * `movedIds` = IDs of the clip(s) being moved (they should not be trimmed).
 */
export function resolveOverlaps(
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
      if (movedIds.has(c.id)) { next.push(c); continue }
      if (c.trackIndex !== moved.trackIndex) { next.push(c); continue }

      const cStart = c.startTime
      const cEnd = c.startTime + c.duration

      if (cEnd <= movedStart || cStart >= movedEnd) { next.push(c); continue }
      if (cStart >= movedStart && cEnd <= movedEnd) continue

      if (cStart < movedStart && cEnd > movedStart && cEnd <= movedEnd) {
        const newDuration = movedStart - cStart
        next.push({ ...c, duration: newDuration })
        continue
      }

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

      if (cStart < movedStart && cEnd > movedEnd) {
        const leftDuration = movedStart - cStart
        next.push({ ...c, duration: leftDuration })

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

      next.push(c)
    }

    result = next
  }

  return result
}

export function loadLayout(): EditorLayout {
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

export function saveLayout(layout: EditorLayout) {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
}

export function clampVal(val: number, limits: { min: number; max: number }): number {
  return Math.max(limits.min, Math.min(limits.max, val))
}

/** Migrate old clips that don't have new effect fields */
export function migrateClip(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    flipH: clip.flipH ?? false,
    flipV: clip.flipV ?? false,
    transitionIn: clip.transitionIn ?? { type: 'none', duration: 0.5 },
    transitionOut: clip.transitionOut ?? { type: 'none', duration: 0.5 },
    colorCorrection: clip.colorCorrection ?? { ...DEFAULT_COLOR_CORRECTION },
    opacity: clip.opacity ?? 100,
    isRegenerating: false,
  }
}

/**
 * Migrate tracks from old format (no kind) to new NLE layout.
 * Heuristic: if a track has no `kind`, infer from its name or position.
 */
export function migrateTracks(tracks: Track[]): Track[] {
  return tracks.map(t => {
    if (t.kind) return t
    if (t.type === 'subtitle') return t
    if (/^A\d/i.test(t.name)) return { ...t, kind: 'audio' as const }
    if (/^V\d/i.test(t.name)) return { ...t, kind: 'video' as const }
    return { ...t, kind: 'video' as const }
  })
}

/** Build CSS filter + transform strings from clip effects */
export function getClipEffectStyles(clip: TimelineClip, timeInClip?: number): React.CSSProperties {
  const cc = clip.colorCorrection || DEFAULT_COLOR_CORRECTION
  const filters: string[] = []

  if (cc.brightness !== 0) filters.push(`brightness(${1 + cc.brightness / 100})`)
  if (cc.contrast !== 0) filters.push(`contrast(${1 + cc.contrast / 100})`)
  if (cc.saturation !== 0) filters.push(`saturate(${1 + cc.saturation / 100})`)
  if (cc.exposure !== 0) filters.push(`brightness(${1 + cc.exposure / 200})`)
  if (cc.temperature !== 0) {
    const t = cc.temperature
    if (t > 0) {
      filters.push(`sepia(${t / 200})`)
      filters.push(`hue-rotate(-${t * 0.1}deg)`)
    } else {
      filters.push(`hue-rotate(${Math.abs(t) * 0.4}deg)`)
    }
  }
  if (cc.tint !== 0) {
    filters.push(`hue-rotate(${cc.tint * 1.2}deg)`)
  }
  if (cc.highlights !== 0) filters.push(`brightness(${1 + cc.highlights / 300})`)
  if (cc.shadows !== 0) filters.push(`contrast(${1 + cc.shadows / 300})`)

  if (clip.effects) {
    for (const fx of clip.effects) {
      if (!fx.enabled) continue
      const p = fx.params
      switch (fx.type) {
        case 'blur':
          if (p.amount > 0) filters.push(`blur(${p.amount}px)`)
          break
        case 'sharpen': {
          const s = p.amount / 100
          if (s > 0) filters.push(`contrast(${1 + s * 0.3})`)
          break
        }
        case 'glow': {
          const intensity = p.amount / 100
          const radius = p.radius || 10
          if (intensity > 0) {
            filters.push(`brightness(${1 + intensity * 0.3})`)
            filters.push(`drop-shadow(0 0 ${radius * intensity}px rgba(255,255,255,${intensity * 0.4}))`)
          }
          break
        }
        case 'vignette':
        case 'grain':
          break
        case 'lut-cinematic': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`contrast(${1 + 0.1 * t})`)
            filters.push(`saturate(${1 - 0.15 * t})`)
            filters.push(`sepia(${0.15 * t})`)
            filters.push(`brightness(${1 - 0.05 * t})`)
          }
          break
        }
        case 'lut-vintage': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`sepia(${0.4 * t})`)
            filters.push(`contrast(${1 - 0.1 * t})`)
            filters.push(`saturate(${1 - 0.2 * t})`)
            filters.push(`brightness(${1 + 0.05 * t})`)
          }
          break
        }
        case 'lut-bw': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) filters.push(`grayscale(${t})`)
          break
        }
        case 'lut-cool': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`hue-rotate(${10 * t}deg)`)
            filters.push(`saturate(${1 - 0.1 * t})`)
            filters.push(`brightness(${1 + 0.02 * t})`)
          }
          break
        }
        case 'lut-warm': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`sepia(${0.2 * t})`)
            filters.push(`hue-rotate(${-5 * t}deg)`)
            filters.push(`saturate(${1 + 0.1 * t})`)
          }
          break
        }
        case 'lut-muted': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`saturate(${1 - 0.5 * t})`)
            filters.push(`contrast(${1 - 0.05 * t})`)
          }
          break
        }
        case 'lut-vivid': {
          const t = (p.intensity ?? 100) / 100
          if (t > 0) {
            filters.push(`saturate(${1 + 0.6 * t})`)
            filters.push(`contrast(${1 + 0.1 * t})`)
          }
          break
        }
      }
    }
  }

  const transforms: string[] = []
  if (clip.flipH) transforms.push('scaleX(-1)')
  if (clip.flipV) transforms.push('scaleY(-1)')

  let opacity = (clip.opacity ?? 100) / 100
  if (timeInClip !== undefined) {
    const tIn = clip.transitionIn
    const tOut = clip.transitionOut
    if (tIn && tIn.duration > 0 && timeInClip < tIn.duration) {
      if (tIn.type === 'fade-to-black' || tIn.type === 'fade-to-white') {
        opacity = Math.min(opacity, timeInClip / tIn.duration)
      }
    }
    if (tOut && tOut.duration > 0) {
      const timeFromEnd = clip.duration - timeInClip
      if (timeFromEnd < tOut.duration) {
        if (tOut.type === 'fade-to-black' || tOut.type === 'fade-to-white') {
          opacity = Math.min(opacity, timeFromEnd / tOut.duration)
        }
      }
    }
  }

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

export function getWipeClipPath(type: TransitionType, progress: number, isIn: boolean): string {
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

/** Get the background color for transition overlay */
export function getTransitionBgColor(type: TransitionType): string | null {
  if (type === 'fade-to-black') return 'black'
  if (type === 'fade-to-white') return 'white'
  return null
}

/** Format seconds into MM:SS:FF timecode */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const frames = Math.floor((seconds % 1) * 24)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`
}
