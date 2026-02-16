import { useState, useRef, useEffect, useCallback } from 'react'
import type { Asset, TimelineClip, Track } from '../../types/project'
import { DEFAULT_COLOR_CORRECTION } from '../../types/project'
import { resolveOverlaps } from './video-editor-utils'

interface UseSourceMonitorParams {
  currentTime: number
  tracks: Track[]
  pushUndo: () => void
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
}

export function useSourceMonitor({ currentTime, tracks, pushUndo, setClips }: UseSourceMonitorParams) {
  const [sourceAsset, setSourceAsset] = useState<Asset | null>(null)
  const [sourceTime, setSourceTime] = useState(0)
  const [sourceIsPlaying, setSourceIsPlaying] = useState(false)
  const [sourceIn, setSourceIn] = useState<number | null>(null)
  const [sourceOut, setSourceOut] = useState<number | null>(null)
  const [showSourceMonitor, setShowSourceMonitor] = useState(false)
  const [activePanel, setActivePanel] = useState<'source' | 'timeline'>('timeline')
  const [sourceSplitPercent, setSourceSplitPercent] = useState(50)
  const sourceVideoRef = useRef<HTMLVideoElement>(null)
  const sourceAnimRef = useRef<number>(0)
  const sourceTimeRef = useRef(0)
  sourceTimeRef.current = sourceTime
  const sourceIsPlayingRef = useRef(false)
  sourceIsPlayingRef.current = sourceIsPlaying

  const loadSourceAsset = useCallback((asset: Asset) => {
    setSourceAsset(asset)
    setSourceTime(0)
    setSourceIn(null)
    setSourceOut(null)
    setSourceIsPlaying(false)
    setShowSourceMonitor(true)
  }, [])

  // --- Source Monitor: playback loop ---
  useEffect(() => {
    if (!sourceIsPlaying || !sourceVideoRef.current) {
      cancelAnimationFrame(sourceAnimRef.current)
      return
    }
    const video = sourceVideoRef.current
    const tick = () => {
      setSourceTime(video.currentTime)
      if (sourceOut !== null && video.currentTime >= sourceOut) {
        video.pause()
        setSourceIsPlaying(false)
        setSourceTime(sourceOut)
        return
      }
      if (!video.paused) sourceAnimRef.current = requestAnimationFrame(tick)
    }
    video.play().catch(() => {})
    sourceAnimRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(sourceAnimRef.current)
  }, [sourceIsPlaying, sourceOut])

  // --- 3-Point Editing: Insert Edit ---
  const handleInsertEdit = useCallback(() => {
    if (!sourceAsset) return
    const sIn = sourceIn ?? 0
    const sDuration = sourceAsset.duration || 5
    const sOut = sourceOut ?? sDuration
    const insertDuration = sOut - sIn
    if (insertDuration <= 0) return

    pushUndo()

    const isAudio = sourceAsset.type === 'audio'
    const targetTrack = tracks.find(t => !t.locked && (isAudio ? t.kind === 'audio' : t.kind === 'video'))
    if (!targetTrack) return
    const targetTrackIndex = tracks.indexOf(targetTrack)

    const rippleAmount = insertDuration
    setClips(prev => {
      const rippled = prev.map(c => {
        if (c.trackIndex === targetTrackIndex && c.startTime >= currentTime) {
          return { ...c, startTime: c.startTime + rippleAmount }
        }
        return c
      })

      const newClip: TimelineClip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        assetId: sourceAsset.id,
        type: sourceAsset.type === 'video' ? 'video' : sourceAsset.type === 'audio' ? 'audio' : 'image',
        startTime: currentTime,
        duration: insertDuration,
        trimStart: sIn,
        trimEnd: sDuration - sOut,
        speed: 1,
        reversed: false,
        muted: false,
        volume: 1,
        trackIndex: targetTrackIndex,
        asset: sourceAsset,
        flipH: false,
        flipV: false,
        transitionIn: { type: 'none', duration: 0.5 },
        transitionOut: { type: 'none', duration: 0.5 },
        colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
        opacity: 100,
      }
      return [...rippled, newClip]
    })
  }, [sourceAsset, sourceIn, sourceOut, currentTime, tracks, pushUndo])

  // --- 3-Point Editing: Overwrite Edit ---
  const handleOverwriteEdit = useCallback(() => {
    if (!sourceAsset) return
    const sIn = sourceIn ?? 0
    const sDuration = sourceAsset.duration || 5
    const sOut = sourceOut ?? sDuration
    const insertDuration = sOut - sIn
    if (insertDuration <= 0) return

    pushUndo()

    const isAudio = sourceAsset.type === 'audio'
    const targetTrack = tracks.find(t => !t.locked && (isAudio ? t.kind === 'audio' : t.kind === 'video'))
    if (!targetTrack) return
    const targetTrackIndex = tracks.indexOf(targetTrack)

    const newClip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      assetId: sourceAsset.id,
      type: sourceAsset.type === 'video' ? 'video' : sourceAsset.type === 'audio' ? 'audio' : 'image',
      startTime: currentTime,
      duration: insertDuration,
      trimStart: sIn,
      trimEnd: sDuration - sOut,
      speed: 1,
      reversed: false,
      muted: false,
      volume: 1,
      trackIndex: targetTrackIndex,
      asset: sourceAsset,
      flipH: false,
      flipV: false,
      transitionIn: { type: 'none', duration: 0.5 },
      transitionOut: { type: 'none', duration: 0.5 },
      colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
      opacity: 100,
    }

    setClips(prev => resolveOverlaps([...prev, newClip], new Set([newClip.id])))
  }, [sourceAsset, sourceIn, sourceOut, currentTime, tracks, pushUndo])

  return {
    sourceAsset, setSourceAsset,
    sourceTime, setSourceTime,
    sourceIsPlaying, setSourceIsPlaying,
    sourceIn, setSourceIn,
    sourceOut, setSourceOut,
    showSourceMonitor, setShowSourceMonitor,
    activePanel, setActivePanel,
    sourceSplitPercent, setSourceSplitPercent,
    sourceVideoRef, sourceAnimRef, sourceTimeRef, sourceIsPlayingRef,
    loadSourceAsset,
    handleInsertEdit,
    handleOverwriteEdit,
  }
}
