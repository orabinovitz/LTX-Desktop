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
  // Linked-clip helper: collect the target clip + all linked siblings
  // -----------------------------------------------------------------------

  const getLinkedGroup = (clipId: string): TimelineClip[] => {
    const clips = clipsRef.current ?? []
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return []
    if (!clip.linkedClipIds?.length) return [clip]

    const ids = new Set<string>([clipId, ...clip.linkedClipIds])
    return clips.filter(c => ids.has(c.id))
  }

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

    const group = getLinkedGroup(clipId)
    if (group.length === 0) {
      return { tool_name: 'trim_clip', success: false, result: null, error: `Clip not found: ${clipId}` }
    }

    // Apply relative deltas (matching tool_registry.py definition)
    const trimStartDelta = Number(args.trim_start_delta ?? 0)
    const trimEndDelta = Number(args.trim_end_delta ?? 0)

    const trimmed: string[] = []
    for (const clip of group) {
      const newTrimStart = Math.max(0, clip.trimStart + trimStartDelta)
      const newTrimEnd = Math.max(0, clip.trimEnd + trimEndDelta)
      const newDuration = Math.max(0.1, clip.duration - trimStartDelta - trimEndDelta)

      updateClip(clip.id, {
        trimStart: newTrimStart,
        trimEnd: newTrimEnd,
        duration: newDuration,
      })
      trimmed.push(clip.id)
    }

    return {
      tool_name: 'trim_clip',
      success: true,
      result: { trimmedClips: trimmed, trimStartDelta, trimEndDelta },
      error: null,
    }
  }

  const handleSplitClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'split_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const time = args.time !== undefined ? Number(args.time) : undefined
    const group = getLinkedGroup(clipId)

    // Split all linked clips at the same time
    const splitIds: string[] = []
    for (const clip of group) {
      splitClipAtPlayhead(clip.id, time)
      splitIds.push(clip.id)
    }

    return {
      tool_name: 'split_clip',
      success: true,
      result: { splitClips: splitIds, time },
      error: null,
    }
  }

  const handleDeleteClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'delete_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const ripple = Boolean(args.ripple)
    const group = getLinkedGroup(clipId)

    if (group.length === 0) {
      return { tool_name: 'delete_clip', success: false, result: null, error: `Clip not found: ${clipId}` }
    }

    // Collect info for ripple before removal
    const removedDuration = group[0].duration
    const removedStart = group[0].startTime
    const affectedTracks = new Set(group.map(c => c.trackIndex))
    const removedIds = new Set(group.map(c => c.id))

    // Remove all clips in the linked group
    for (const clip of group) {
      removeClip(clip.id)
    }

    // Ripple: shift subsequent clips on affected tracks to the left
    if (ripple) {
      setClips(prev =>
        prev.map(c => {
          if (affectedTracks.has(c.trackIndex) && !removedIds.has(c.id) && c.startTime > removedStart) {
            return { ...c, startTime: c.startTime - removedDuration }
          }
          return c
        }),
      )
    }

    return {
      tool_name: 'delete_clip',
      success: true,
      result: { deletedClips: Array.from(removedIds), ripple },
      error: null,
    }
  }

  const handleMoveClip = (args: Record<string, unknown>): ToolResult => {
    const clipId = args.clip_id as string | undefined
    if (!clipId) {
      return { tool_name: 'move_clip', success: false, result: null, error: 'Missing clip_id' }
    }

    const group = getLinkedGroup(clipId)
    if (group.length === 0) {
      return { tool_name: 'move_clip', success: false, result: null, error: `Clip not found: ${clipId}` }
    }

    const primary = group.find(c => c.id === clipId)!
    const timeDelta = args.new_start_time !== undefined ? Number(args.new_start_time) - primary.startTime : 0
    const trackDelta = args.new_track_index !== undefined ? Number(args.new_track_index) - primary.trackIndex : 0

    const moved: string[] = []
    for (const clip of group) {
      const updates: Partial<TimelineClip> = {}
      if (timeDelta !== 0) updates.startTime = clip.startTime + timeDelta
      if (trackDelta !== 0) updates.trackIndex = clip.trackIndex + trackDelta
      updateClip(clip.id, updates)
      moved.push(clip.id)
    }

    return {
      tool_name: 'move_clip',
      success: true,
      result: { movedClips: moved, timeDelta, trackDelta },
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

  const sanitizeArgs = (args: Record<string, unknown>): Record<string, unknown> => {
    const sanitized = { ...args }
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === 'number' && isNaN(value)) {
        sanitized[key] = 0
      }
    }
    return sanitized
  }

  // -----------------------------------------------------------------------
  // Dispatcher
  // -----------------------------------------------------------------------

  const executeTool = useCallback(
    async (call: ToolCall): Promise<ToolResult> => {
      try {
        const args = sanitizeArgs(call.arguments)
        const safe = { ...call, arguments: args }

        switch (safe.tool_name) {
          case 'get_timeline_state':
            return handleGetTimelineState()
          case 'trim_clip':
            return handleTrimClip(safe.arguments)
          case 'split_clip':
            return handleSplitClip(safe.arguments)
          case 'delete_clip':
            return handleDeleteClip(safe.arguments)
          case 'move_clip':
            return handleMoveClip(safe.arguments)
          case 'add_clip_to_timeline':
            return handleAddClipToTimeline(safe.arguments)
          case 'set_playhead':
            return handleSetPlayhead(safe.arguments)
          case 'duplicate_timeline':
            return handleDuplicateTimeline()
          case 'get_project_assets':
            return handleGetProjectAssets()
          default:
            return {
              tool_name: safe.tool_name,
              success: false,
              result: null,
              error: `Unknown tool: ${safe.tool_name}`,
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
