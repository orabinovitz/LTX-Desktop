// Project and Asset types for LTX Desktop

// Parameters needed to regenerate a shot
export interface GenerationParams {
  mode: 'text-to-video' | 'image-to-video' | 'text-to-image'
  prompt: string
  model: string
  duration: number
  resolution: string
  fps: number
  audio: boolean
  cameraMotion: string
  imageAspectRatio?: string
  imageSteps?: number
  inputImageUrl?: string // For I2V: the input image used
}

// A single "take" (version) of a generated asset
export interface AssetTake {
  url: string
  path: string
  thumbnail?: string
  createdAt: number
}

export interface Asset {
  id: string
  type: 'image' | 'video' | 'audio' | 'adjustment'
  path: string
  url: string
  prompt: string
  resolution: string
  duration?: number // For videos
  createdAt: number
  thumbnail?: string
  favorite?: boolean
  bin?: string // Bin/folder name for organization (undefined = no bin)
  // Regeneration support
  generationParams?: GenerationParams
  takes?: AssetTake[] // All takes (index 0 = original). If undefined, the asset itself is the only take.
  activeTakeIndex?: number // Which take is currently active (default = 0 / latest)
}

export interface Track {
  id: string
  name: string
  muted: boolean
  locked: boolean
  enabled?: boolean              // Track output toggle: false = clips on this track hidden in preview (default true)
  type?: 'default' | 'subtitle'  // default = media track, subtitle = subtitle track
  kind?: 'video' | 'audio'      // NLE track kind for display ordering (video tracks stack up, audio down)
  subtitleStyle?: Partial<SubtitleStyle>  // Global style for all subtitles on this track (overrides DEFAULT, overridden by per-sub style)
}

// Subtitle styling options
export interface SubtitleStyle {
  fontSize: number         // in px, default 32
  fontFamily: string       // default 'sans-serif'
  fontWeight: 'normal' | 'bold'
  color: string            // hex color, default '#FFFFFF'
  backgroundColor: string  // hex color with alpha, default '#00000099'
  position: 'bottom' | 'top' | 'center'  // vertical position, default 'bottom'
  italic: boolean
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 32,
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  color: '#FFFFFF',
  backgroundColor: 'transparent',
  position: 'bottom',
  italic: false,
}

// A single subtitle cue on the timeline
export interface SubtitleClip {
  id: string
  text: string
  startTime: number
  endTime: number
  trackIndex: number
  style?: Partial<SubtitleStyle>
}

export type TransitionType = 'none' | 'dissolve' | 'fade-to-black' | 'fade-to-white' | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down'

export interface ClipTransition {
  type: TransitionType
  duration: number // in seconds
}

export interface ColorCorrection {
  brightness: number   // -100 to 100, default 0
  contrast: number     // -100 to 100, default 0
  saturation: number   // -100 to 100, default 0
  temperature: number  // -100 to 100, default 0 (negative = cooler/blue, positive = warmer/orange)
  tint: number         // -100 to 100, default 0 (negative = green, positive = magenta)
  exposure: number     // -100 to 100, default 0
  highlights: number   // -100 to 100, default 0
  shadows: number      // -100 to 100, default 0
}

export const DEFAULT_COLOR_CORRECTION: ColorCorrection = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
}

// Letterbox overlay settings for adjustment layers
export interface LetterboxSettings {
  enabled: boolean
  aspectRatio: '2.35:1' | '2.39:1' | '2.76:1' | '1.85:1' | '4:3' | 'custom'
  customRatio?: number  // width / height, used when aspectRatio === 'custom'
  color: string          // default '#000000'
  opacity: number        // 0-100, default 100
}

export const DEFAULT_LETTERBOX: LetterboxSettings = {
  enabled: false,
  aspectRatio: '2.35:1',
  color: '#000000',
  opacity: 100,
}

export interface TimelineClip {
  id: string
  assetId: string | null
  type: 'video' | 'image' | 'audio' | 'adjustment'
  startTime: number
  duration: number
  trimStart: number
  trimEnd: number
  speed: number
  reversed: boolean
  muted: boolean
  volume: number
  trackIndex: number
  asset: Asset | null
  importedUrl?: string
  importedName?: string
  // Effects
  flipH: boolean
  flipV: boolean
  transitionIn: ClipTransition
  transitionOut: ClipTransition
  colorCorrection: ColorCorrection
  opacity: number // 0 to 100, default 100
  // Take management
  takeIndex?: number // Which take to show (overrides asset.activeTakeIndex). undefined = use latest.
  isRegenerating?: boolean // Visual flag: true while a regeneration is in progress for this clip
  // Adjustment layer effects
  letterbox?: LetterboxSettings
}

export interface Timeline {
  id: string
  name: string
  createdAt: number
  tracks: Track[]
  clips: TimelineClip[]
  subtitles?: SubtitleClip[]  // Subtitle cues on subtitle tracks
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  assets: Asset[]
  thumbnail?: string
  timelines: Timeline[]
  activeTimelineId?: string
}

export type ViewType = 'home' | 'project' | 'playground'
export type ProjectTab = 'gen-space' | 'video-editor'

// Default tracks for new timelines
export const DEFAULT_TRACKS: Track[] = [
  { id: 'track-v1', name: 'V1', muted: false, locked: false, kind: 'video' },
  { id: 'track-v2', name: 'V2', muted: false, locked: false, kind: 'video' },
  { id: 'track-v3', name: 'V3', muted: false, locked: false, kind: 'video' },
  { id: 'track-a1', name: 'A1', muted: false, locked: false, kind: 'audio' },
  { id: 'track-a2', name: 'A2', muted: false, locked: false, kind: 'audio' },
]

// Helper to create a new timeline with default tracks
export function createDefaultTimeline(name: string = 'Timeline 1'): Timeline {
  return {
    id: `timeline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    createdAt: Date.now(),
    tracks: DEFAULT_TRACKS.map(t => ({ ...t })),
    clips: [],
  }
}
