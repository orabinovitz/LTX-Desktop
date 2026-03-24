import { useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineClip, Track, Asset } from '../../types/project'
import {
  analyzeTimelineComplexity,
  getDecodeWindowPolicy,
  selectPreviewPerformanceTier,
  type DecodeWindowPolicy,
  type PreviewPerformanceTier,
  type TimelineComplexitySummary,
} from './playback/previewPerformance'
import {
  chooseAnchorClip,
  computeMasterGainForActiveClipCount,
  computeRateCorrection,
  computeTimelineTimeFromAnchor,
  countPreviewExportParityRisks,
  getAudiblePreviewClips,
  supportsAudiblePreviewTransport,
} from './playback/audioPreviewPlanner'
import {
  PlaybackDiagnosticsStore,
  type PlaybackDiagnosticsSnapshot,
} from './playback/playbackDiagnostics'
import {
  computeBoundaryGain,
  selectBufferedVideoSources,
} from './playback/previewWindowPlanner'
import { PreviewAudioBus } from './playback/previewAudioBus'
import { PreviewAssetCache } from './playback/previewAssetCache'
import {
  buildReplaySessionFingerprint,
  capturePauseSnapshot,
  createReplaySession,
  freezeSessionAudioUrl,
  pickSessionAnchorClipId,
  resolveReplayAudioSourceUrl,
  resolvePausedTransportSync,
  resolveReplayStartMode,
  shouldDeferPausedTransportSync,
  shouldHoldReplayUntilBusReady,
  type PauseSnapshot,
  type ReplaySession,
  type ReplayStartMode,
} from './playback/replayCoordinator'
import {
  canPromoteSeekReplay,
  canUseAnchorClockAfterSeek,
  computeSeekReplayReadiness,
  mergeSeekReplayWindowPolicy,
  shouldHoldSeekPreroll,
} from './playback/seekReplayCoordinator'

export interface UsePlaybackEngineParams {
  isPlaying: boolean
  setIsPlaying: (v: boolean) => void
  gpuAvailable: boolean | null
  shuttleSpeed: number
  setShuttleSpeed: React.Dispatch<React.SetStateAction<number>>
  currentTime: number
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>
  duration: number
  pixelsPerSecond: number
  clips: TimelineClip[]
  tracks: Track[]
  assets: Asset[]
  activeClip: TimelineClip | null
  crossDissolveState: any
  playbackResolution: number
  playingInOut: boolean
  setPlayingInOut: (v: boolean) => void
  resolveClipSrc: (clip: TimelineClip) => string
  // Refs
  videoPoolRef: React.MutableRefObject<Map<string, HTMLVideoElement>>
  playbackTimeRef: React.MutableRefObject<number>
  isPlayingRef: React.MutableRefObject<boolean>
  activePoolSrcRef: React.MutableRefObject<string>
  previewVideoRef: React.RefObject<HTMLVideoElement | null>
  dissolveOutVideoRef: React.RefObject<HTMLVideoElement | null>
  trackContainerRef: React.RefObject<HTMLDivElement>
  rulerScrollRef: React.RefObject<HTMLDivElement>
  centerOnPlayheadRef: React.MutableRefObject<boolean>
  clipsRef: React.MutableRefObject<TimelineClip[]>
  tracksRef: React.MutableRefObject<Track[]>
  assetsRef: React.MutableRefObject<Asset[]>
  playheadOverlayRef: React.RefObject<HTMLDivElement>
  playheadRulerRef: React.RefObject<HTMLDivElement>
  lastStateUpdateRef: React.MutableRefObject<number>
  preSeekDoneRef: React.MutableRefObject<string | null>
  rafActiveClipIdRef: React.MutableRefObject<string | null>
  inPoint: number | null
  outPoint: number | null
  totalDuration: number
  zoom: number
  setPlaybackActiveClipId: React.Dispatch<React.SetStateAction<string | null>>
}

export interface PlaybackTelemetry {
  diagnostics: PlaybackDiagnosticsSnapshot
  performanceTier: PreviewPerformanceTier
  decodeWindowPolicy: DecodeWindowPolicy
  previewExportParityRisks: number
  timelineComplexity: TimelineComplexitySummary
}

const EMPTY_DIAGNOSTICS: PlaybackDiagnosticsSnapshot = {
  driftSamples: 0,
  p95DriftSeconds: 0,
  pauseBoundaryDriftSeconds: 0,
  pausedRefHolds: 0,
  pausedScrubSeeks: 0,
  sessionFingerprintInvalidations: 0,
  seekPrerollStarts: 0,
  seekPrerollWaits: 0,
  seekPrerollTimeouts: 0,
  seekReplayUnreadyAudio: 0,
  seekReplayUnreadyVideo: 0,
  seekWindowPolicyHolds: 0,
  warmResumes: 0,
  replayAfterSeekStarts: 0,
  coldStarts: 0,
  awaitBusReadyStarts: 0,
  audioHardSeeks: 0,
  videoHardSeeks: 0,
  playRetries: 0,
  longTasks: 0,
  underruns: 0,
  audibleSources: 0,
  videoSources: 0,
}

export function usePlaybackEngine(params: UsePlaybackEngineParams) {
  const {
    isPlaying, setIsPlaying, gpuAvailable, shuttleSpeed, setShuttleSpeed,
    currentTime, setCurrentTime, pixelsPerSecond,
    clips, tracks, assets, activeClip, crossDissolveState,
    playbackResolution, playingInOut, setPlayingInOut,
    resolveClipSrc,
    videoPoolRef, playbackTimeRef, isPlayingRef, activePoolSrcRef,
    previewVideoRef, trackContainerRef, rulerScrollRef,
    centerOnPlayheadRef, clipsRef, tracksRef, assetsRef,
    playheadOverlayRef, playheadRulerRef, lastStateUpdateRef,
    preSeekDoneRef, rafActiveClipIdRef, setPlaybackActiveClipId,
    inPoint, outPoint, totalDuration, zoom,
  } = params

  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const diagnosticsStoreRef = useRef(new PlaybackDiagnosticsStore())
  const audioBusRef = useRef(new PreviewAudioBus())
  const audioAnchorClipIdRef = useRef<string | null>(null)
  const previewAssetCacheRef = useRef<PreviewAssetCache | null>(null)
  const currentTimeRef = useRef(currentTime)
  const shuttleSpeedRef = useRef(shuttleSpeed)
  const totalDurationRef = useRef(totalDuration)
  const playingInOutRef = useRef(playingInOut)
  const inPointRef = useRef(inPoint)
  const outPointRef = useRef(outPoint)
  const zoomRef = useRef(zoom)
  const decodeWindowPolicyRef = useRef<DecodeWindowPolicy>({
    lookBehindSeconds: 0,
    lookAheadSeconds: 0,
    maxVideoSources: 0,
    playbackResolution: 1,
    preferPreviewAudioProxy: false,
  })
  const pauseSnapshotRef = useRef<PauseSnapshot | null>(null)
  const pauseSnapshotPendingRef = useRef(false)
  const pausedSeekedAtReplayStartRef = useRef(false)
  const replaySessionRef = useRef<ReplaySession | null>(null)
  const replayStartModeRef = useRef<ReplayStartMode>('cold_start')
  const replayBusGateStartedAtRef = useRef<number | null>(null)
  const seekPrerollStartedAtRef = useRef<number | null>(null)
  const pausedDecodeWindowPolicyRef = useRef<DecodeWindowPolicy | null>(null)
  const seekWindowGraceActiveRef = useRef(false)
  const lastReplaySessionFingerprintRef = useRef('')
  const lastFrozenAudioUrlsRef = useRef<Record<string, string>>({})
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<PlaybackDiagnosticsSnapshot>(EMPTY_DIAGNOSTICS)
  const [seekReplayPolicyVersion, setSeekReplayPolicyVersion] = useState(0)
  if (previewAssetCacheRef.current === null) {
    const previewProvider = typeof window !== 'undefined' && window.electronAPI?.ensureAudioPreview
      ? { ensureAudioPreview: window.electronAPI.ensureAudioPreview }
      : null
    previewAssetCacheRef.current = new PreviewAssetCache(previewProvider)
  }
  const lowEndDevice = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const cpuCount = navigator.hardwareConcurrency ?? 8
    const memoryGiB = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8)
    return cpuCount <= 8 || memoryGiB <= 8
  }, [])
  const timelineComplexity = useMemo(() => analyzeTimelineComplexity(clips, tracks), [clips, tracks])
  const performanceTier = useMemo(
    () => selectPreviewPerformanceTier(timelineComplexity, { lowEndDevice, gpuAvailable: gpuAvailable ?? true }),
    [gpuAvailable, lowEndDevice, timelineComplexity],
  )
  const decodeWindowPolicy = useMemo(
    () => getDecodeWindowPolicy(performanceTier, isPlaying),
    [isPlaying, performanceTier],
  )
  const effectivePlaybackResolution = useMemo(
    () => Math.min(playbackResolution, decodeWindowPolicy.playbackResolution) as 1 | 0.5 | 0.25,
    [decodeWindowPolicy.playbackResolution, playbackResolution],
  )
  const previewExportParityRisks = useMemo(
    () => countPreviewExportParityRisks(clips, tracks),
    [clips, tracks],
  )

  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])
  useEffect(() => { shuttleSpeedRef.current = shuttleSpeed }, [shuttleSpeed])
  useEffect(() => { totalDurationRef.current = totalDuration }, [totalDuration])
  useEffect(() => { playingInOutRef.current = playingInOut }, [playingInOut])
  useEffect(() => { inPointRef.current = inPoint }, [inPoint])
  useEffect(() => { outPointRef.current = outPoint }, [outPoint])
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { decodeWindowPolicyRef.current = decodeWindowPolicy }, [decodeWindowPolicy])
  useEffect(() => {
    if (!isPlaying) {
      pausedDecodeWindowPolicyRef.current = decodeWindowPolicy
    }
  }, [decodeWindowPolicy, isPlaying])

  const buildReplayFingerprintInputs = (audioClips: TimelineClip[], resolveUrl: (clip: TimelineClip) => string): Record<string, string> => {
    const descriptors: Record<string, string> = {}
    for (const clip of audioClips) {
      const url = resolveUrl(clip)
      descriptors[clip.id] = [
        url,
        `start=${clip.startTime.toFixed(3)}`,
        `duration=${clip.duration.toFixed(3)}`,
        `trimStart=${clip.trimStart.toFixed(3)}`,
        `trimEnd=${clip.trimEnd.toFixed(3)}`,
        `speed=${clip.speed.toFixed(3)}`,
        `reversed=${clip.reversed}`,
        `track=${clip.trackIndex}`,
      ].join('|')
    }
    return descriptors
  }

  useEffect(() => {
    if (!isPlaying || typeof PerformanceObserver === 'undefined') return

    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          diagnosticsStoreRef.current.recordLongTask(entry.duration)
        }
      })
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit)
    } catch {
      return
    }

    return () => observer?.disconnect()
  }, [isPlaying])

  useEffect(() => {
    if (!isPlaying) return

    const previousPauseSnapshot = pauseSnapshotRef.current
    pauseSnapshotPendingRef.current = true
    pausedSeekedAtReplayStartRef.current = previousPauseSnapshot?.pausedSeeked ?? false
    audioAnchorClipIdRef.current = null
    replayBusGateStartedAtRef.current = null

    const replayAudibleClips = getAudiblePreviewClips(clips, tracks, playbackTimeRef.current)
      .filter((clip) => supportsAudiblePreviewTransport(shuttleSpeed, clip.reversed))
    const replayAudioFingerprintInputs = buildReplayFingerprintInputs(replayAudibleClips, (clip) => {
      const sourceUrl = resolveClipSrc(clip)
      const preferredUrl =
        previewAssetCacheRef.current?.getPreferredAudioUrl(sourceUrl, decodeWindowPolicy.preferPreviewAudioProxy)
        ?? sourceUrl
      return resolveReplayAudioSourceUrl({
        pauseSnapshot: previousPauseSnapshot,
        clipId: clip.id,
        liveUrl: preferredUrl,
      })
    })
    const currentSessionFingerprint = buildReplaySessionFingerprint({
      audioUrlsByClipId: replayAudioFingerprintInputs,
      preferPreviewAudioProxy: decodeWindowPolicy.preferPreviewAudioProxy,
    })
    const sessionFingerprintChanged = previousPauseSnapshot?.sessionFingerprint !== currentSessionFingerprint
    const replayStartMode = resolveReplayStartMode({
      pauseSnapshot: previousPauseSnapshot,
      sessionFingerprintChanged,
      busReady: audioBusRef.current.isReady(),
    })
    seekWindowGraceActiveRef.current = replayStartMode === 'seek_preroll'
    seekPrerollStartedAtRef.current = null
    if (seekWindowGraceActiveRef.current) {
      diagnosticsStoreRef.current.recordSeekWindowPolicyHold()
    }
    if (sessionFingerprintChanged && previousPauseSnapshot?.sessionFingerprint) {
      diagnosticsStoreRef.current.recordSessionFingerprintInvalidation()
    }
    replayStartModeRef.current = replayStartMode
    diagnosticsStoreRef.current.recordReplayStartMode(replayStartMode)
    replaySessionRef.current = createReplaySession({
      replayMode: replayStartMode,
      pauseSnapshot: previousPauseSnapshot,
      sessionFingerprint: currentSessionFingerprint,
    })
    lastReplaySessionFingerprintRef.current = currentSessionFingerprint
    pauseSnapshotRef.current = null
    setSeekReplayPolicyVersion((version) => version + 1)
    void audioBusRef.current.ensureReady()
  }, [isPlaying])

  useEffect(() => {
    if (isPlaying) return
    if (shouldDeferPausedTransportSync(pauseSnapshotPendingRef.current, pauseSnapshotRef.current)) return

    const syncResult = resolvePausedTransportSync({
      currentTime,
      pauseSnapshot: pauseSnapshotRef.current,
      toleranceSeconds: 0.01,
    })

    if (syncResult.action === 'hold_snapshot') {
      diagnosticsStoreRef.current.recordPausedRefHold()
    }
    if (syncResult.action === 'mark_paused_seek') {
      diagnosticsStoreRef.current.recordPausedScrubSeek('transport')
    }

    playbackTimeRef.current = syncResult.nextPlaybackTime
    pauseSnapshotRef.current = syncResult.nextPauseSnapshot
    setDiagnosticsSnapshot(diagnosticsStoreRef.current.snapshot())
  }, [currentTime, isPlaying, playbackTimeRef])

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
          clip.type !== 'audio' && clip.type !== 'adjustment' && clip.type !== 'text' &&
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
        if (c.type === 'audio' || c.type === 'adjustment' || c.type === 'text') continue
        if (c.asset?.type !== 'video') continue
        if (c.startTime >= endTime - 0.01) {
          if (!best || c.startTime < best.startTime) best = c
        }
      }
      return best
    }
    
    // Detect dissolve region at a given time (inline, no React dependency)
    const getDissolveAtTime = (time: number): { outgoing: TimelineClip; incoming: TimelineClip; progress: number } | null => {
      const all = clipsRef.current
      for (const clipA of all) {
        if (clipA.transitionOut?.type !== 'dissolve' || clipA.transitionOut.duration <= 0) continue
        const clipAEnd = clipA.startTime + clipA.duration
        const dissolveStart = clipAEnd - clipA.transitionOut.duration
        if (time < dissolveStart || time >= clipAEnd) continue
        const clipB = all.find((c: TimelineClip) =>
          c.id !== clipA.id &&
          c.trackIndex === clipA.trackIndex &&
          c.transitionIn?.type === 'dissolve' &&
          Math.abs(c.startTime - clipAEnd) < 0.05
        )
        if (!clipB) continue
        const dissolveDuration = clipA.transitionOut.duration
        const timeIntoDissolve = time - dissolveStart
        const progress = Math.max(0, Math.min(1, timeIntoDissolve / dissolveDuration))
        return { outgoing: clipA, incoming: clipB, progress }
      }
      return null
    }
    
    const STATE_UPDATE_INTERVAL = 250 // ~4fps for React state updates (playhead/video/audio are smooth via rAF+DOM, this is only for timecode display)
    const DISSOLVE_STATE_UPDATE_INTERVAL = 33 // ~30fps during dissolves for smooth crossfade
    lastStateUpdateRef.current = 0
    const recordVideoSeek = (driftSeconds: number) => {
      diagnosticsStoreRef.current.recordHardSeek('video', driftSeconds)
    }
    const recordAudioSeek = (driftSeconds: number) => {
      diagnosticsStoreRef.current.recordHardSeek('audio', driftSeconds)
    }
    
    const tick = (timestamp: number) => {
      if (lastTimestamp === null) {
        lastTimestamp = timestamp
        lastStateUpdateRef.current = timestamp
        // Fall through with deltaMs = 0 so video sync still runs on the first frame
      }

      const busReadyNow = audioBusRef.current.isReady()
      if (replayStartModeRef.current === 'await_bus_ready') {
        if (replayBusGateStartedAtRef.current === null) {
          replayBusGateStartedAtRef.current = timestamp
        }
        const waitedMs = timestamp - replayBusGateStartedAtRef.current
        if (shouldHoldReplayUntilBusReady({
          replayStartMode: replayStartModeRef.current,
          busReady: busReadyNow,
          waitedMs,
          maxWaitMs: 40,
        })) {
          lastTimestamp = timestamp
          animFrameId = requestAnimationFrame(tick)
          return
        }

        replayStartModeRef.current = busReadyNow
          ? (pausedSeekedAtReplayStartRef.current ? 'seek_preroll' : 'warm_resume')
          : 'cold_start'
        if (replayStartModeRef.current === 'seek_preroll') {
          diagnosticsStoreRef.current.recordReplayStartMode('seek_preroll')
          seekWindowGraceActiveRef.current = true
          seekPrerollStartedAtRef.current = null
          diagnosticsStoreRef.current.recordSeekWindowPolicyHold()
        }
        setSeekReplayPolicyVersion((version) => version + 1)
        replayBusGateStartedAtRef.current = null
      } else {
        replayBusGateStartedAtRef.current = null
      }

      if (replayStartModeRef.current === 'seek_preroll' && seekPrerollStartedAtRef.current === null) {
        seekPrerollStartedAtRef.current = timestamp
      }
      if (
        replayStartModeRef.current === 'replay_after_seek'
        && seekWindowGraceActiveRef.current
        && seekPrerollStartedAtRef.current !== null
        && timestamp - seekPrerollStartedAtRef.current > 150
      ) {
        seekWindowGraceActiveRef.current = false
        setSeekReplayPolicyVersion((version) => version + 1)
      }
      
      const deltaMs = timestamp - lastTimestamp
      lastTimestamp = timestamp
      const effectiveSpeed = shuttleSpeedRef.current !== 0 ? shuttleSpeedRef.current : 1
      const allowMediaPlaybackThisTick = replayStartModeRef.current !== 'seek_preroll'
      const deltaSec = allowMediaPlaybackThisTick ? (deltaMs / 1000) * effectiveSpeed : 0
      
      // ── 1. Advance time ──
      let next = playbackTimeRef.current + deltaSec
      let stopped = false
      
      // In/Out loop
      if (playingInOutRef.current && inPointRef.current !== null && outPointRef.current !== null) {
        const loopStart = Math.min(inPointRef.current, outPointRef.current)
        const loopEnd = Math.max(inPointRef.current, outPointRef.current)
        if (next >= loopEnd) next = loopStart
        else if (next <= loopStart) next = loopEnd
      } else {
        if (next >= totalDurationRef.current) { next = 0; stopped = true }
        else if (next < 0) { next = 0; stopped = true }
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
      
      // Track which clip the rAF is actively displaying (for audio dedup)
      rafActiveClipIdRef.current = syncClip?.id ?? null
      
      // Check if we're in a dissolve region
      const dissolveInfo = getDissolveAtTime(next)
      
      // Show/hide the video pool container via DOM to avoid React dependency on throttled activeClip
      const poolContainer = document.getElementById('video-pool-container')
      
      if (dissolveInfo) {
        // During dissolve: the pool continues showing the OUTGOING clip (with fading opacity via React).
        // We keep the pool visible and let it play normally for the outgoing clip.
        if (poolContainer) poolContainer.classList.remove('hidden')
        
        // Ensure pool video for outgoing clip is playing and in sync
        const outClip = dissolveInfo.outgoing
        const outSrc = resolveClipSrcRef(outClip)
        if (outSrc) {
          let outVid = pool.get(outSrc)
          if (outVid) {
            const container = document.getElementById('video-pool-container')
            if (container && !outVid.parentElement) container.appendChild(outVid)
            if (outSrc !== activePoolSrcRef.current) {
              const oldVid = pool.get(activePoolSrcRef.current)
              if (oldVid) { oldVid.style.opacity = '0'; oldVid.style.zIndex = '0'; oldVid.pause() }
              activePoolSrcRef.current = outSrc
            }
            outVid.style.opacity = '1'
            outVid.style.zIndex = '1'
            outVid.muted = true
            outVid.volume = 0
            if (outVid.readyState >= 2) {
              outVid.playbackRate = outClip.reversed ? 1 : outClip.speed
              const timeInClip = next - outClip.startTime
              const vd = outVid.duration
              if (!isNaN(vd)) {
                const usable = vd - outClip.trimStart - outClip.trimEnd
                const tt = outClip.reversed
                  ? Math.max(0, Math.min(vd, outClip.trimStart + usable - timeInClip * outClip.speed))
                  : Math.max(0, Math.min(vd, outClip.trimStart + timeInClip * outClip.speed))
                if (outClip.reversed) {
                  if (!outVid.paused) outVid.pause()
                  if (!isNaN(tt) && Math.abs(outVid.currentTime - tt) > 0.04) {
                    recordVideoSeek(Math.abs(outVid.currentTime - tt))
                    outVid.currentTime = tt
                  }
                } else {
                  if (!isNaN(tt) && Math.abs(outVid.currentTime - tt) > 0.3) {
                    recordVideoSeek(Math.abs(outVid.currentTime - tt))
                    outVid.currentTime = tt
                  }
                  if (allowMediaPlaybackThisTick && outVid.paused) outVid.play().catch(() => {})
                }
              }
            }
          }
        }
        
        // Seek the incoming video overlay (rendered as JSX by ProgramMonitor)
        const inVid = previewVideoRef.current
        if (inVid && dissolveInfo.incoming.asset?.type === 'video') {
          inVid.muted = true
          inVid.volume = 0
          if (inVid.duration && !isNaN(inVid.duration)) {
            const clip = dissolveInfo.incoming
            const videoDuration = inVid.duration
            const usableMedia = videoDuration - clip.trimStart - clip.trimEnd
            const timeInClip = Math.max(0, next - clip.startTime)
            const targetTime = clip.reversed
              ? Math.max(0, Math.min(videoDuration, clip.trimStart + usableMedia - timeInClip * clip.speed))
              : Math.max(0, Math.min(videoDuration, clip.trimStart + timeInClip * clip.speed))
            if (!inVid.paused) inVid.pause()
            if (!isNaN(targetTime) && Math.abs(inVid.currentTime - targetTime) > 0.04) {
              recordVideoSeek(Math.abs(inVid.currentTime - targetTime))
              inVid.currentTime = targetTime
            }
          }
        }
        
        // Pre-load the incoming clip's video in the pool for seamless transition when dissolve ends
        if (dissolveInfo.incoming.asset?.type === 'video') {
          const inSrc = resolveClipSrcRef(dissolveInfo.incoming)
          if (inSrc && !pool.has(inSrc)) {
            const v = document.createElement('video')
            v.preload = 'auto'
            v.playsInline = true
            v.muted = true
            v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;z-index:0;'
            v.src = inSrc
            v.load()
            pool.set(inSrc, v)
            const container = document.getElementById('video-pool-container')
            if (container) container.appendChild(v)
          }
        }
        
      } else if (syncClip && syncClip.asset?.type === 'video') {
        if (poolContainer) poolContainer.classList.remove('hidden')
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
            activePoolSrcRef.current = clipSrc
            preSeekDoneRef.current = null // reset pre-seek tracker on clip change
          }
          // Always ensure the current video is visible — handles edge case where
          // the scrub sync couldn't fully initialize before playback took over
          if (video) {
            video.style.opacity = '1'
            video.style.zIndex = '1'
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
                    recordVideoSeek(Math.abs(v.currentTime - targetTime))
                    if (typeof (v as any).fastSeek === 'function') (v as any).fastSeek(targetTime)
                    else v.currentTime = targetTime
                  }
                } else {
                  v.playbackRate = syncClip.speed
                  if (!isNaN(targetTime) && Math.abs(v.currentTime - targetTime) > 0.3) {
                    recordVideoSeek(Math.abs(v.currentTime - targetTime))
                    if (typeof (v as any).fastSeek === 'function') (v as any).fastSeek(targetTime)
                    else v.currentTime = targetTime
                  }
                  if (allowMediaPlaybackThisTick && v.paused) v.play().catch(() => {})
                }
                
                // Always mute video elements — audio comes exclusively from audio tracks
                v.muted = true
                v.volume = 0
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
            if (remainingInCurrent < Math.max(1.5, decodeWindowPolicyRef.current.lookAheadSeconds) && remainingInCurrent > 0) {
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
      } else {
        // No video clip at this time — pause current pool video (keep last frame), hide pool
        if (poolContainer) poolContainer.classList.add('hidden')
        const curVid = pool.get(activePoolSrcRef.current)
        if (curVid && !curVid.paused) curVid.pause()
      }
      
      // ── 3b. Sync hidden audio elements directly (no React dependency) ──
      // Audio preview plays only from dedicated audio-track clips.
      // Video elements stay muted and linked video/audio imports are heard exactly once
      // from their audio track counterpart.
      // KEY PRINCIPLES:
      //   1. Once audio is playing at the correct speed, DON'T touch it.
      //   2. Never set playbackRate unless it actually changed (avoids re-buffer).
      //   3. Don't spam play() on auto-paused elements — use backoff.
      //   4. Keep audio elements alive (just pause) so buffers are preserved.
      {
        const audioMap = audioElementsRef.current
        const allClips = clipsRef.current
        const trks = tracksRef.current
        const previewAssetCache = previewAssetCacheRef.current
        const activeAudioClips = getAudiblePreviewClips(allClips, trks, next)
          .filter((clip) => supportsAudiblePreviewTransport(shuttleSpeed, clip.reversed))
        const activeAudioIds = new Set(activeAudioClips.map((clip) => clip.id))
        const masterGain = computeMasterGainForActiveClipCount(activeAudioIds.size)
        diagnosticsStoreRef.current.setActiveCounts({
          audibleSources: activeAudioIds.size,
          videoSources: pool.size,
        })
        const busActive = audioBusRef.current.isReady()
        const replaySession = replaySessionRef.current
        const replayStartMode = replayStartModeRef.current
        const replayRetryBackoffMs = replayStartMode === 'warm_resume' || replayStartMode === 'replay_after_seek' ? 50 : 500
        const activeReplayFingerprintInputs: Record<string, string> = {}
        
        // Pause clips no longer active (but keep the element for fast resume)
        for (const [id, el] of audioMap) {
          if (!activeAudioIds.has(id)) {
            if (!el.paused) el.pause()
            ;(el as any).__audioPlaying = false
          }
        }
        
        // Sync active audio clips
        for (const c of activeAudioClips) {
          const sourceUrl = resolveClipSrcRef(c)
          if (!sourceUrl) continue
          void previewAssetCache?.warmAudioPreview(sourceUrl, decodeWindowPolicyRef.current.preferPreviewAudioProxy)
          const preferredUrl = previewAssetCache?.getPreferredAudioUrl(sourceUrl, decodeWindowPolicyRef.current.preferPreviewAudioProxy) ?? sourceUrl
          const url = replaySession
            ? freezeSessionAudioUrl(replaySession, c.id, preferredUrl)
            : preferredUrl
          if (!url) continue
          activeReplayFingerprintInputs[c.id] = [
            url,
            `start=${c.startTime.toFixed(3)}`,
            `duration=${c.duration.toFixed(3)}`,
            `trimStart=${c.trimStart.toFixed(3)}`,
            `trimEnd=${c.trimEnd.toFixed(3)}`,
            `speed=${c.speed.toFixed(3)}`,
            `reversed=${c.reversed}`,
            `track=${c.trackIndex}`,
          ].join('|')
          
          let el = audioMap.get(c.id)
          let isNew = false
          if (!el) {
            el = document.createElement('audio')
            el.src = url
            ;(el as any).__intendedSrc = url
            el.preload = 'auto'
            audioMap.set(c.id, el)
            isNew = true
          } else if ((el as any).__intendedSrc !== url && url) {
            el.src = url
            ;(el as any).__intendedSrc = url
            ;(el as any).__audioPlaying = false
            isNew = true
          }
          
          const trackObj = trks[c.trackIndex]
          const targetGain = c.volume * masterGain * computeBoundaryGain(c, next, 0.02)
          el.muted = c.muted || trackObj?.muted || false
          const routedThroughBus = busActive
            && audioBusRef.current.syncClip(c.id, el, el.muted ? 0 : targetGain)
          if (routedThroughBus) {
            el.muted = false
            el.volume = 1
          } else {
            el.volume = el.muted ? 0 : targetGain
          }
          
          const computeTarget = (audioEl: HTMLAudioElement, atTime: number) => {
            const assetDur = audioEl.duration || c.duration
            const timeInClip = atTime - c.startTime
            return c.reversed
              ? Math.max(0, assetDur - c.trimEnd - timeInClip * c.speed)
              : Math.max(0, c.trimStart + timeInClip * c.speed)
          }
          
          const desiredRate = c.speed
          
          if (el.readyState >= 2) {
            if (!(el as any).__audioPlaying || isNew) {
              // First sync: seek to correct position, set speed, and start playing
              const target = computeTarget(el, next)
              const initialDrift = Math.abs(el.currentTime - target)
              if (initialDrift > 0.04) {
                diagnosticsStoreRef.current.recordDrift(initialDrift)
              }
              const canWarmResume =
                (replayStartMode === 'warm_resume' || replayStartMode === 'replay_after_seek')
                && !isNew
                && initialDrift <= 0.04
              if (!canWarmResume) {
                el.currentTime = target
              }
              el.playbackRate = desiredRate
              if (allowMediaPlaybackThisTick) {
                el.play().catch(() => {})
                ;(el as any).__audioPlaying = true
                ;(el as any).__lastPlayRetry = 0
              } else {
                ;(el as any).__audioPlaying = false
              }
            } else {
              const target = computeTarget(el, next)
              const driftSigned = target - el.currentTime
              const drift = Math.abs(driftSigned)
              diagnosticsStoreRef.current.recordDrift(drift)
              if (drift > 0.2) {
                recordAudioSeek(drift)
                el.currentTime = target
                el.playbackRate = desiredRate
              } else {
                const correctedRate = drift > 0.04
                  ? computeRateCorrection(desiredRate, driftSigned)
                  : desiredRate
                if (el.playbackRate !== correctedRate) {
                  el.playbackRate = correctedRate
                }
              }
              // Resume if browser auto-paused — but with backoff to avoid choppiness
              if (allowMediaPlaybackThisTick && el.paused) {
                const now = timestamp
                const lastRetry = (el as any).__lastPlayRetry || 0
                if (now - lastRetry > replayRetryBackoffMs) {
                  ;(el as any).__lastPlayRetry = now
                  diagnosticsStoreRef.current.recordPlayRetry(c.id)
                  el.play().catch(() => {})
                  if (el.paused) {
                    diagnosticsStoreRef.current.recordUnderrun(c.id)
                  }
                }
              }
            }
          } else if (!(el as any).__awaitingCanplay) {
            diagnosticsStoreRef.current.recordUnderrun(c.id);
            (el as any).__awaitingCanplay = true
            const onCanPlay = () => {
              el!.removeEventListener('canplay', onCanPlay)
              ;(el as any).__awaitingCanplay = false
              if (!isPlayingRef.current) return
              const freshTime = playbackTimeRef.current
              const target = computeTarget(el!, freshTime)
              el!.currentTime = target
              el!.playbackRate = desiredRate
              if (replayStartModeRef.current !== 'seek_preroll') {
                el!.play().catch(() => {})
                ;(el as any).__audioPlaying = true
                ;(el as any).__lastPlayRetry = 0
              } else {
                ;(el as any).__audioPlaying = false
              }
            }
            el.addEventListener('canplay', onCanPlay)
          }
        }

        if (replaySession) {
          replaySession.sessionFingerprint = buildReplaySessionFingerprint({
            audioUrlsByClipId: activeReplayFingerprintInputs,
            preferPreviewAudioProxy: decodeWindowPolicyRef.current.preferPreviewAudioProxy,
          })
          lastReplaySessionFingerprintRef.current = replaySession.sessionFingerprint
          lastFrozenAudioUrlsRef.current = Object.fromEntries(replaySession.frozenAudioUrls)
        }

        const audioReadyStates = activeAudioClips.map((clip) => audioMap.get(clip.id)?.readyState ?? 0)
        const activeVideoReadyState = syncClip?.asset?.type === 'video'
          ? (resolveClipSrcRef(syncClip) ? pool.get(resolveClipSrcRef(syncClip))?.readyState ?? 0 : 0)
          : null
        const seekReplayReadiness = computeSeekReplayReadiness({
          audioReadyStates,
          videoReadyState: activeVideoReadyState,
        })

        if (replayStartModeRef.current === 'seek_preroll') {
          if (!seekReplayReadiness.audioReady) {
            diagnosticsStoreRef.current.recordSeekReplayUnreadyAudio()
          }
          if (!seekReplayReadiness.videoReady) {
            diagnosticsStoreRef.current.recordSeekReplayUnreadyVideo()
          }
          const waitedMs = timestamp - (seekPrerollStartedAtRef.current ?? timestamp)
          if (shouldHoldSeekPreroll({
            replayStartMode: replayStartModeRef.current,
            audioReady: seekReplayReadiness.audioReady,
            videoReady: seekReplayReadiness.videoReady,
            waitedMs,
            maxWaitMs: 80,
          })) {
            diagnosticsStoreRef.current.recordSeekPrerollWait()
            setDiagnosticsSnapshot(diagnosticsStoreRef.current.snapshot())
            animFrameId = requestAnimationFrame(tick)
            return
          }

          if (!seekReplayReadiness.audioReady || !seekReplayReadiness.videoReady) {
            diagnosticsStoreRef.current.recordSeekPrerollTimeout()
            diagnosticsStoreRef.current.recordReplayStartMode('cold_start')
            replayStartModeRef.current = 'cold_start'
            seekWindowGraceActiveRef.current = false
            setSeekReplayPolicyVersion((version) => version + 1)
          } else {
            const promotedReplayMode = canPromoteSeekReplay(
              replayStartModeRef.current,
              seekReplayReadiness.audioReady,
              seekReplayReadiness.videoReady,
            )
            if (promotedReplayMode !== replayStartModeRef.current) {
              diagnosticsStoreRef.current.recordReplayStartMode(promotedReplayMode)
            }
            replayStartModeRef.current = promotedReplayMode
            setSeekReplayPolicyVersion((version) => version + 1)
          }
        }

        const anchorAllowed = busActive && canUseAnchorClockAfterSeek(
          replayStartModeRef.current,
          seekReplayReadiness.audioReady,
          seekReplayReadiness.videoReady,
        )

        if (anchorAllowed) {
          audioBusRef.current.muteInactive(activeAudioIds)
          const proposedAnchor = chooseAnchorClip(activeAudioClips, audioAnchorClipIdRef.current)
          const anchorClipId = replaySession
            ? pickSessionAnchorClipId(replaySession, activeAudioClips.map((clip) => clip.id), proposedAnchor?.id ?? null)
            : proposedAnchor?.id ?? null
          const anchorClip = activeAudioClips.find((clip) => clip.id === anchorClipId) ?? null
          audioAnchorClipIdRef.current = anchorClipId
          if (anchorClip) {
            const anchorCurrentTime = audioBusRef.current.getElementCurrentTime(anchorClip.id)
            if (anchorCurrentTime !== null && !Number.isNaN(anchorCurrentTime)) {
              const authoritativeTime = computeTimelineTimeFromAnchor(anchorClip, anchorCurrentTime)
              const audioClockDrift = Math.abs(authoritativeTime - next)
              diagnosticsStoreRef.current.recordDrift(audioClockDrift)
              if (audioClockDrift > 0.5) {
                recordAudioSeek(audioClockDrift)
              }
              if (Number.isFinite(authoritativeTime)) {
                playbackTimeRef.current = authoritativeTime
              }
            }
          }
        } else {
          audioAnchorClipIdRef.current = null
        }
      }
      
      // ── 4. Direct DOM updates for playhead (no React re-render) ──
      const pps = zoomRef.current * 100 // pixelsPerSecond
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
      
      // ── 6. Throttled React state sync for UI ──
      // During dissolves, update React state much more frequently (~30fps) so the
      // crossDissolveState opacity crossfade is smooth. Otherwise use ~4fps.
      const updateInterval = dissolveInfo ? DISSOLVE_STATE_UPDATE_INTERVAL : STATE_UPDATE_INTERVAL
      if (timestamp - lastStateUpdateRef.current >= updateInterval) {
        lastStateUpdateRef.current = timestamp
        setCurrentTime(next)
        // Push active clip id to React so the monitor visibility stays correct
        setPlaybackActiveClipId(rafActiveClipIdRef.current)
        setDiagnosticsSnapshot(diagnosticsStoreRef.current.snapshot())
      }
      
      animFrameId = requestAnimationFrame(tick)
    }
    
    animFrameId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(animFrameId)
      const replaySession = replaySessionRef.current
      pauseSnapshotRef.current = capturePauseSnapshot({
        authoritativeTime: playbackTimeRef.current,
        uiTimeAtPause: currentTimeRef.current,
        anchorClipId: replaySession?.frozenAnchorClipId ?? audioAnchorClipIdRef.current,
        sessionFingerprint: replaySession?.sessionFingerprint || lastReplaySessionFingerprintRef.current,
        frozenAudioUrls: replaySession
          ? Object.fromEntries(replaySession.frozenAudioUrls)
          : lastFrozenAudioUrlsRef.current,
      })
      pauseSnapshotPendingRef.current = false
      diagnosticsStoreRef.current.recordPauseBoundary(pauseSnapshotRef.current.uiDriftAtPause)
      // Final sync: push authoritative time to React state
      setCurrentTime(playbackTimeRef.current)
      setPlaybackActiveClipId(null) // reset so React falls back to activeClip
      rafActiveClipIdRef.current = null
      diagnosticsStoreRef.current.setActiveCounts({ audibleSources: 0, videoSources: videoPoolRef.current.size })
      setDiagnosticsSnapshot(diagnosticsStoreRef.current.snapshot())
      // Pause all hidden audio elements and reset sync flags
      for (const [, el] of audioElementsRef.current) {
        if (!el.paused) el.pause()
        ;(el as any).__audioPlaying = false
      }
      replaySessionRef.current = null
    }
  }, [isPlaying])
  
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
  // --- Video pool management for gapless playback ---
  // Keep the video pool bounded to a small window around the playhead so lower-end
  // machines do not try to decode the whole timeline at once.
  const timelineVideoSources = useMemo(() => {
    const seekReplayGraceActive =
      seekWindowGraceActiveRef.current
      || (isPlaying && pauseSnapshotRef.current?.pausedSeeked === true)
    const effectiveWindowPolicy = mergeSeekReplayWindowPolicy({
      pausedPolicy: pausedDecodeWindowPolicyRef.current ?? decodeWindowPolicy,
      livePolicy: decodeWindowPolicy,
      replayStartMode: replayStartModeRef.current,
      graceActive: seekReplayGraceActive,
    })
    const srcSet = selectBufferedVideoSources(clips, currentTime, effectiveWindowPolicy, resolveClipSrc)

    const monitorClipSrc = activeClip ? resolveClipSrc(activeClip) : ''
    if (monitorClipSrc) srcSet.add(monitorClipSrc)

    if (crossDissolveState) {
      const outgoingSrc = resolveClipSrc(crossDissolveState.outgoing)
      const incomingSrc = resolveClipSrc(crossDissolveState.incoming)
      if (outgoingSrc) srcSet.add(outgoingSrc)
      if (incomingSrc) srcSet.add(incomingSrc)
    }

    return srcSet
  }, [clips, currentTime, decodeWindowPolicy, resolveClipSrc, activeClip, crossDissolveState, isPlaying, seekReplayPolicyVersion])
  
  // Maintain the video pool for the bounded decode window only.
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
      if (effectivePlaybackResolution < 1) {
        // Scale the video element down, then scale the container up via CSS transform
        // This reduces actual pixel decode work
        video.style.width = `${effectivePlaybackResolution * 100}%`
        video.style.height = `${effectivePlaybackResolution * 100}%`
        video.style.transform = `scale(${1 / effectivePlaybackResolution})`
        video.style.transformOrigin = 'top left'
      } else {
        video.style.width = '100%'
        video.style.height = '100%'
        video.style.transform = ''
        video.style.transformOrigin = ''
      }
    }
  }, [effectivePlaybackResolution, timelineVideoSources]) // re-apply when pool changes
  
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
    
    // During cross-dissolve, sync the incoming video overlay (previewVideoRef).
    // The outgoing clip continues to be handled by the pool below.
    if (crossDissolveState) {
      const { incoming } = crossDissolveState
      if (incoming.asset?.type === 'video') {
        const video = previewVideoRef.current
        if (video) {
          const incomingSrc = resolveClipSrc(incoming)
          if (incomingSrc && video.src !== incomingSrc && !video.src.endsWith(incomingSrc)) {
            video.src = incomingSrc
            video.load()
          }
          
          const timeInClip = Math.max(0, currentTime - incoming.startTime)
          
          const syncIncoming = () => {
            if (!video || !video.duration || isNaN(video.duration)) return
            const videoDuration = video.duration
            const usableMedia = videoDuration - incoming.trimStart - incoming.trimEnd
            const targetTime = incoming.reversed
              ? Math.max(0, Math.min(videoDuration, incoming.trimStart + usableMedia - timeInClip * incoming.speed))
              : Math.max(0, Math.min(videoDuration, incoming.trimStart + timeInClip * incoming.speed))
            
            if (!video.paused) video.pause()
            video.muted = true
            if (!isNaN(targetTime) && Math.abs(video.currentTime - targetTime) > 0.04) {
              video.currentTime = targetTime
            }
          }
          
          if (video.readyState >= 2) {
            syncIncoming()
          } else {
            video.addEventListener('loadeddata', () => syncIncoming(), { once: true })
          }
        }
      }
      // Don't return — fall through to sync the outgoing clip via the pool
    }
    
    const pool = videoPoolRef.current
    
    // Determine which clip to sync
    const syncClip = activeClip
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
    const isNewSource = clipSrc !== activePoolSrcRef.current
    if (isNewSource) {
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
    
    // During dissolve, previewVideoRef points to the incoming JSX video — don't overwrite it
    if (!crossDissolveState) {
      ;(previewVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = video
    }
    
    const timeInClip = currentTime - syncClip.startTime
    
    const syncVideo = (forceSeek: boolean) => {
      if (!video) return
      
      // Always mute video elements — audio comes exclusively from audio tracks
      video.muted = true
      video.volume = 0
      
      // If duration isn't available yet, force a brief play/pause to render the first frame
      if (!video.duration || isNaN(video.duration)) {
        if (forceSeek) {
          video.play().then(() => { video.pause() }).catch(() => {})
        }
        return
      }
      
      const videoDuration = video.duration
      const usableMediaDuration = videoDuration - syncClip.trimStart - syncClip.trimEnd
      
      const targetTime = syncClip.reversed 
        ? Math.max(0, Math.min(videoDuration, syncClip.trimStart + usableMediaDuration - timeInClip * syncClip.speed))
        : Math.max(0, Math.min(videoDuration, syncClip.trimStart + timeInClip * syncClip.speed))
      
      if (syncClip.reversed) {
        if (!video.paused) video.pause()
        video.playbackRate = 1
        if (!isNaN(targetTime) && (forceSeek || Math.abs(video.currentTime - targetTime) > 0.04)) {
          // Nudge by a tiny amount when at the exact same position to force Chromium to decode the frame
          if (forceSeek && Math.abs(video.currentTime - targetTime) < 0.001) {
            video.currentTime = targetTime + 0.001
          }
          video.currentTime = targetTime
        }
      } else {
        video.playbackRate = syncClip.speed
        if (!isNaN(targetTime) && (forceSeek || Math.abs(video.currentTime - targetTime) > 0.3)) {
          if (forceSeek && Math.abs(video.currentTime - targetTime) < 0.001) {
            video.currentTime = targetTime + 0.001
          }
          video.currentTime = targetTime
        }
        if (!video.paused) video.pause()
      }
    }
    
    if (video.readyState >= 2) {
      syncVideo(isNewSource)
    } else {
      // Always force seek when video just loaded — ensures first frame renders
      const onLoaded = () => syncVideo(true)
      video.addEventListener('loadeddata', onLoaded, { once: true })
      if (container) {
        for (const [, v] of pool) {
          if (!v.parentElement) container.appendChild(v)
        }
      }
      // Store ref for cleanup
      ;(video as any).__syncOnLoad = onLoaded
    }
    
    return () => {
      if (video && (video as any).__syncOnLoad) {
        video.removeEventListener('loadeddata', (video as any).__syncOnLoad)
        delete (video as any).__syncOnLoad
      }
    }
  }, [currentTime, isPlaying, activeClip, crossDissolveState, tracks, resolveClipSrc])
  
  // Outgoing dissolve clip is handled by the video pool — no separate sync needed.
  
  // Sync audio for ALL layers: audio clips + video clips with audio content.
  // All audio plays through hidden <audio> elements (video <video> elements stay muted).
  // This effect only handles scrubbing / seeking (when NOT playing).
  
  useEffect(() => {
    // During playback, the rAF loop handles audio sync directly for zero-latency.
    // This effect only handles scrubbing / seeking (when NOT playing).
    if (isPlaying) return
    const scrubTime = playbackTimeRef.current
    
    // Pause all audio elements when not playing and reset sync flags.
    // IMPORTANT: Don't destroy elements (no el.src = '') — keep buffers alive
    // so playback can resume instantly without reloading.
    for (const [, el] of audioElementsRef.current) {
      if (!el.paused) el.pause()
      ;(el as any).__audioPlaying = false
    }
    audioBusRef.current.muteInactive(new Set())
    diagnosticsStoreRef.current.setActiveCounts({ audibleSources: 0, videoSources: videoPoolRef.current.size })
    setDiagnosticsSnapshot(diagnosticsStoreRef.current.snapshot())
    
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
    
    // Pre-create audio elements only for dedicated audio clips.
    // Video clips stay visually active but never contribute direct preview audio;
    // linked video/audio imports should be heard exactly once from their audio track.
    const scrubWindowStart = Math.max(0, scrubTime - decodeWindowPolicy.lookBehindSeconds)
    const scrubWindowEnd = scrubTime + decodeWindowPolicy.lookAheadSeconds
    const allAudioClips = clips.filter(c => {
      if (c.type === 'adjustment' || c.type === 'text' || c.type === 'image') return false
      if (!getAudioClipUrl(c)) return false
      if (c.type !== 'audio') return false
      if (c.startTime >= scrubWindowEnd || c.startTime + c.duration <= scrubWindowStart) return false
      return true
    })
    const allAudioClipIds = new Set(allAudioClips.map(c => c.id))
    
    // Remove elements for clips that no longer exist on the timeline
    for (const [id, el] of audioElementsRef.current) {
      if (!allAudioClipIds.has(id)) {
        el.pause()
        el.src = ''
        audioElementsRef.current.delete(id)
      }
    }
    
    // Pre-create / seek audio elements
    for (const clip of allAudioClips) {
      const clipUrl = getAudioClipUrl(clip)!
      void previewAssetCacheRef.current?.warmAudioPreview(clipUrl, decodeWindowPolicy.preferPreviewAudioProxy)
      const preferredClipUrl =
        previewAssetCacheRef.current?.getPreferredAudioUrl(clipUrl, decodeWindowPolicy.preferPreviewAudioProxy)
        ?? clipUrl
      let el = audioElementsRef.current.get(clip.id)
      
      if (!el) {
        el = document.createElement('audio')
        el.src = preferredClipUrl
        ;(el as any).__intendedSrc = preferredClipUrl
        el.preload = 'auto'
        audioElementsRef.current.set(clip.id, el)
      } else if ((el as any).__intendedSrc !== preferredClipUrl && preferredClipUrl) {
        el.src = preferredClipUrl
        ;(el as any).__intendedSrc = preferredClipUrl
      }
      
      const isAtPlayhead = scrubTime >= clip.startTime && scrubTime < clip.startTime + clip.duration
      if (!isAtPlayhead) continue
      
      const liveAsset = clip.assetId ? assets.find(a => a.id === clip.assetId) : null
      const assetDuration = liveAsset?.duration || clip.asset?.duration || clip.duration
      const timeInClip = scrubTime - clip.startTime
      const targetTime = clip.reversed
        ? Math.max(0, assetDuration - clip.trimEnd - timeInClip * clip.speed)
        : Math.max(0, clip.trimStart + timeInClip * clip.speed)
      
      const anySoloedScrub = tracks.some(t => t.solo)
      const scrubTrack = tracks[clip.trackIndex]
      const isSoloMutedScrub = anySoloedScrub && !scrubTrack?.solo
      el.muted = clip.muted || scrubTrack?.muted || isSoloMutedScrub || false
      el.volume = clip.volume
      
      // Seek to correct position (paused — only for scrub preview)
      if (el.readyState >= 2 && Math.abs(el.currentTime - targetTime) > 0.05) {
        el.currentTime = targetTime
      }
    }
  }, [currentTime, isPlaying, clips, tracks, assets, decodeWindowPolicy, playbackTimeRef])
  
  // Clean up all audio elements on unmount
  useEffect(() => {
    return () => {
      void audioBusRef.current.destroy()
      for (const [, el] of audioElementsRef.current) {
        el.pause()
        el.src = ''
      }
      audioElementsRef.current.clear()
    }
  }, [])

  return {
    audioElementsRef,
    playbackTelemetry: {
      diagnostics: diagnosticsSnapshot,
      performanceTier,
      decodeWindowPolicy,
      previewExportParityRisks,
      timelineComplexity,
    },
  }
}
