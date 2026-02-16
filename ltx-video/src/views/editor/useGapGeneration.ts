import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { TimelineClip, Track, SubtitleClip, Asset } from '../../types/project'
import { DEFAULT_COLOR_CORRECTION } from '../../types/project'
import type { GenerationSettings } from '../../components/SettingsPanel'

export interface UseGapGenerationParams {
  clips: TimelineClip[]
  tracks: Track[]
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleClip[]>>
  currentProjectId: string | null
  addAsset: (projectId: string, asset: Omit<Asset, 'id' | 'createdAt'>) => Asset
  resolveClipSrc: (clip: TimelineClip | null) => string
  regenGenerate: (prompt: string, imageFile: File | null, settings: GenerationSettings) => Promise<void>
  regenGenerateImage: (prompt: string, settings: GenerationSettings) => Promise<void>
  regenVideoUrl: string | null
  regenVideoPath: string | null
  regenImageUrl: string | null
  isRegenerating: boolean
  regenReset: () => void
}

export function useGapGeneration({
  clips,
  tracks,
  setClips,
  setSubtitles,
  currentProjectId,
  addAsset,
  resolveClipSrc,
  regenGenerate,
  regenGenerateImage,
  regenVideoUrl,
  regenVideoPath,
  regenImageUrl,
  isRegenerating,
  regenReset,
}: UseGapGenerationParams) {
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

  // Gap context-aware prompt suggestion (via Gemini)
  const [gapSuggesting, setGapSuggesting] = useState(false)
  const [gapSuggestion, setGapSuggestion] = useState<string | null>(null)
  const gapSuggestionAbortRef = useRef<AbortController | null>(null)
  // Frames extracted from neighboring clips for the gap animation header
  const [gapBeforeFrame, setGapBeforeFrame] = useState<string | null>(null)
  const [gapAfterFrame, setGapAfterFrame] = useState<string | null>(null)

  // --- Gap detection: find empty spaces between clips on each non-subtitle track ---
  const timelineGaps = useMemo(() => {
    const gaps: { trackIndex: number; startTime: number; endTime: number }[] = []
    
    tracks.forEach((track, trackIdx) => {
      if (track.type === 'subtitle') return
      
      const trackClips = clips
        .filter(c => c.trackIndex === trackIdx)
        .sort((a, b) => a.startTime - b.startTime)
      
      if (trackClips.length === 0) return
      
      if (trackClips[0].startTime > 0.05) {
        gaps.push({ trackIndex: trackIdx, startTime: 0, endTime: trackClips[0].startTime })
      }
      
      for (let i = 0; i < trackClips.length - 1; i++) {
        const endOfCurrent = trackClips[i].startTime + trackClips[i].duration
        const startOfNext = trackClips[i + 1].startTime
        if (startOfNext - endOfCurrent > 0.05) {
          gaps.push({ trackIndex: trackIdx, startTime: endOfCurrent, endTime: startOfNext })
        }
      }
    })
    
    return gaps
  }, [clips, tracks])

  // Delete gap: ripple all clips on the same track (and optionally all tracks) to close it
  const deleteGap = useCallback((gap: { trackIndex: number; startTime: number; endTime: number }) => {
    const gapDuration = gap.endTime - gap.startTime
    
    setClips(prev => prev.map(c => {
      if (c.startTime >= gap.endTime) {
        return { ...c, startTime: Math.max(0, c.startTime - gapDuration) }
      }
      return c
    }))
    
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
    
    setSelectedGap(null)
    setGapGenerateMode(null)
    setGapPrompt('')
    setGapImageFile(null)
    regenReset()
    
  }, [regenVideoUrl, regenImageUrl, isRegenerating])

  // --- Gap context-aware prompt suggestion via Gemini ---
  useEffect(() => {
    if (!selectedGap || !gapGenerateMode) {
      setGapSuggesting(false)
      setGapSuggestion(null)
      setGapBeforeFrame(null)
      setGapAfterFrame(null)
      gapSuggestionAbortRef.current?.abort()
      return
    }
    
    if (gapPrompt.trim()) return
    
    const abortController = new AbortController()
    gapSuggestionAbortRef.current = abortController
    
    const suggest = async () => {
      try {
        setGapSuggesting(true)
        setGapSuggestion(null)
        
        const { extractFrameAsBase64, extractImageAsBase64 } = await import('../../lib/thumbnails')
        
        const gap = selectedGap
        const trackClips = clips
          .filter(c => c.trackIndex === gap.trackIndex && c.type !== 'audio')
          .sort((a, b) => a.startTime - b.startTime)
        
        const clipBefore = trackClips.find(c => {
          const clipEnd = c.startTime + c.duration
          return Math.abs(clipEnd - gap.startTime) < 0.05
        })
        
        const clipAfter = trackClips.find(c => {
          return Math.abs(c.startTime - gap.endTime) < 0.05
        })
        
        if (!clipBefore && !clipAfter) {
          setGapSuggesting(false)
          return
        }
        
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
              const seekTime = clipBefore.trimStart + clipBefore.duration * clipBefore.speed - 0.1
              framePromises.push(
                extractFrameAsBase64(clipSrc, Math.max(0, seekTime))
                  .then(b64 => { beforeFrame = b64 })
                  .catch(() => {})
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
        
        if (beforeFrame) setGapBeforeFrame(beforeFrame.startsWith('data:') ? beforeFrame : `data:image/jpeg;base64,${beforeFrame}`)
        if (afterFrame) setGapAfterFrame(afterFrame.startsWith('data:') ? afterFrame : `data:image/jpeg;base64,${afterFrame}`)
        
        if (!beforeFrame && !afterFrame && !beforePrompt && !afterPrompt) {
          setGapSuggesting(false)
          return
        }
        
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
  }, [selectedGap, gapGenerateMode])

  return {
    // State
    selectedGap,
    setSelectedGap,
    gapGenerateMode,
    setGapGenerateMode,
    gapGenerateModeRef,
    gapPrompt,
    setGapPrompt,
    gapSettings,
    setGapSettings,
    gapImageFile,
    setGapImageFile,
    gapImageInputRef,
    gapSuggesting,
    gapSuggestion,
    gapBeforeFrame,
    gapAfterFrame,
    // Computed
    timelineGaps,
    // Actions
    deleteGap,
    handleGapGenerate,
  }
}
