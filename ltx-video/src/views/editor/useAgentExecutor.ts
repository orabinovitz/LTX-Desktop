import { useCallback, useRef } from 'react'
import type { TimelineClip, Track, Asset } from '../../types/project'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCall {
  tool_name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  tool_name: string
  success: boolean
  result: unknown
  error: string | null
}

export interface AgentExecutorDeps {
  clipsRef: React.RefObject<TimelineClip[]>
  tracksRef: React.RefObject<Track[]>
  assetsRef: React.RefObject<Asset[]>
  currentTimeRef: React.RefObject<number>
  splitClipAtPlayhead: (clipId: string, atTime?: number) => void
  removeClip: (clipId: string) => void
  updateClip: (clipId: string, updates: Partial<TimelineClip>) => void
  addClipToTimeline: (asset: Asset, trackIndex?: number, startTime?: number) => void
  setCurrentTime: (time: number) => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentExecutor(deps: AgentExecutorDeps) {
  const {
    clipsRef,
    tracksRef,
    assetsRef,
    currentTimeRef,
    splitClipAtPlayhead,
    removeClip,
    updateClip,
    addClipToTimeline,
    setCurrentTime,
    setClips,
  } = deps

  const snapshotRef = useRef<TimelineClip[] | null>(null)

  // -----------------------------------------------------------------------
  // Tool handlers
  // -----------------------------------------------------------------------

  const handleGetTimelineState = (): ToolResult => {
    const clips = clipsRef.current ?? []
    const tracks = tracksRef.current ?? []
    const currentTime = currentTimeRef.current ?? 0

    return {
      tool_name: 'get_timeline_state',
      success: true,
      result: {
        currentTime,
        trackCount: tracks.length,
        tracks: tracks.map((t, i) => ({
          index: i,
          id: t.id,
          name: t.name,
          kind: t.kind ?? 'video',
          muted: t.muted,
          locked: t.locked,
        })),
        clipCount: clips.length,
        clips: clips.map(c => ({
          id: c.id,
          assetId: c.assetId,
          type: c.type,
          trackIndex: c.trackIndex,
          startTime: c.startTime,
          duration: c.duration,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
          speed: c.speed,
          muted: c.muted,
          volume: c.volume,
          prompt: c.asset?.prompt ?? null,
        })),
      },
      error: null,
    }
  }

  const handleTrimClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'trim_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const clips = clipsRef.current ?? []
    const clip = clips.find(c => c.id === clipId)
    if (!clip) {
      return { tool_name: 'trim_clip', success: false, result: null, error: `Clip not found: ${clipId}` }
    }

    const updates: Partial<TimelineClip> = {}

    if (args.trim_start !== undefined) {
      updates.trimStart = Number(args.trim_start)
    }
    if (args.trim_end !== undefined) {
      updates.trimEnd = Number(args.trim_end)
    }
    if (args.duration !== undefined) {
      updates.duration = Number(args.duration)
    }
    if (args.start_time !== undefined) {
      updates.startTime = Number(args.start_time)
    }

    updateClip(clipId, updates)

    return {
      tool_name: 'trim_clip',
      success: true,
      result: { clipId, updates },
      error: null,
    }
  }

  const handleSplitClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'split_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const time = args.time !== undefined ? Number(args.time) : undefined
    splitClipAtPlayhead(clipId, time)

    return {
      tool_name: 'split_clip',
      success: true,
      result: { clipId, time },
      error: null,
    }
  }

  const handleDeleteClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'delete_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const ripple = Boolean(args.ripple)
    const clips = clipsRef.current ?? []
    const clip = clips.find(c => c.id === clipId)

    if (!clip) {
      return { tool_name: 'delete_clip', success: false, result: null, error: `Clip not found: ${clipId}` }
    }

    const removedDuration = clip.duration
    const removedStart = clip.startTime
    const trackIndex = clip.trackIndex

    removeClip(clipId)

    // Ripple: shift subsequent clips on the same track to the left
    if (ripple) {
      setClips(prev =>
        prev.map(c => {
          if (c.trackIndex === trackIndex && c.startTime > removedStart) {
            return { ...c, startTime: c.startTime - removedDuration }
          }
          return c
        }),
      )
    }

    return {
      tool_name: 'delete_clip',
      success: true,
      result: { clipId, ripple },
      error: null,
    }
  }

  const handleMoveClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'move_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const updates: Partial<TimelineClip> = {}
    if (args.start_time !== undefined) {
      updates.startTime = Number(args.start_time)
    }
    if (args.track_index !== undefined) {
      updates.trackIndex = Number(args.track_index)
    }

    updateClip(clipId, updates)

    return {
      tool_name: 'move_clip',
      success: true,
      result: { clipId, updates },
      error: null,
    }
  }

  const handleAddClipToTimeline = (args: Record<string, unknown>): ToolResult => {
    const assetId = args.asset_id as string | undefined
    if (!assetId) {
      return { tool_name: 'add_clip_to_timeline', success: false, result: null, error: 'Missing asset_id' }
    }

    const assets = assetsRef.current ?? []
    const asset = assets.find(a => a.id === assetId)
    if (!asset) {
      return { tool_name: 'add_clip_to_timeline', success: false, result: null, error: `Asset not found: ${assetId}` }
    }

    const trackIndex = args.track_index !== undefined ? Number(args.track_index) : undefined
    const startTime = args.start_time !== undefined ? Number(args.start_time) : undefined

    addClipToTimeline(asset, trackIndex, startTime)

    return {
      tool_name: 'add_clip_to_timeline',
      success: true,
      result: { assetId, trackIndex, startTime },
      error: null,
    }
  }

  const handleSetPlayhead = (args: Record<string, unknown>): ToolResult => {
    if (args.time === undefined) {
      return { tool_name: 'set_playhead', success: false, result: null, error: 'Missing time' }
    }

    const time = Number(args.time)
    setCurrentTime(time)

    return {
      tool_name: 'set_playhead',
      success: true,
      result: { time },
      error: null,
    }
  }

  const handleDuplicateTimeline = (): ToolResult => {
    const clips = clipsRef.current ?? []
    snapshotRef.current = JSON.parse(JSON.stringify(clips))

    return {
      tool_name: 'duplicate_timeline',
      success: true,
      result: { snapshotClipCount: clips.length },
      error: null,
    }
  }

  const handleGetProjectAssets = (): ToolResult => {
    const assets = assetsRef.current ?? []

    return {
      tool_name: 'get_project_assets',
      success: true,
      result: {
        assetCount: assets.length,
        assets: assets.map(a => ({
          id: a.id,
          type: a.type,
          prompt: a.prompt,
          duration: a.duration ?? null,
          resolution: a.resolution,
          path: a.path,
          favorite: a.favorite ?? false,
          bin: a.bin ?? null,
        })),
      },
      error: null,
    }
  }

  // -----------------------------------------------------------------------
  // Dispatcher
  // -----------------------------------------------------------------------

  const executeTool = useCallback(
    async (call: ToolCall): Promise<ToolResult> => {
      try {
        switch (call.tool_name) {
          case 'get_timeline_state':
            return handleGetTimelineState()
          case 'trim_clip':
            return handleTrimClip(call.arguments)
          case 'split_clip':
            return handleSplitClip(call.arguments)
          case 'delete_clip':
            return handleDeleteClip(call.arguments)
          case 'move_clip':
            return handleMoveClip(call.arguments)
          case 'add_clip_to_timeline':
            return handleAddClipToTimeline(call.arguments)
          case 'set_playhead':
            return handleSetPlayhead(call.arguments)
          case 'duplicate_timeline':
            return handleDuplicateTimeline()
          case 'get_project_assets':
            return handleGetProjectAssets()
          default:
            return {
              tool_name: call.tool_name,
              success: false,
              result: null,
              error: `Unknown tool: ${call.tool_name}`,
            }
        }
      } catch (err) {
        return {
          tool_name: call.tool_name,
          success: false,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
    [
      clipsRef,
      tracksRef,
      assetsRef,
      currentTimeRef,
      splitClipAtPlayhead,
      removeClip,
      updateClip,
      addClipToTimeline,
      setCurrentTime,
      setClips,
    ],
  )

  // -----------------------------------------------------------------------
  // Snapshot restore
  // -----------------------------------------------------------------------

  const restoreSnapshot = useCallback((): boolean => {
    if (!snapshotRef.current) return false
    setClips(snapshotRef.current)
    snapshotRef.current = null
    return true
  }, [setClips])

  return { executeTool, restoreSnapshot }
}
