import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { TimelineClip, Track, SubtitleClip, Asset } from '../../types/project'
import { DEFAULT_COLOR_CORRECTION } from '../../types/project'
import type { GenerationSettings } from '../../components/SettingsPanel'
import { copyToAssetFolder } from '../../lib/asset-copy'

export interface UseGapGenerationParams {
  clips: TimelineClip[]
  tracks: Track[]
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleClip[]>>
  currentProjectId: string | null
  addAsset: (projectId: string, asset: Omit<Asset, 'id' | 'createdAt'>) => Asset
  resolveClipSrc: (clip: TimelineClip | null) => string
  regenGenerate: (prompt: string, imagePath: string | null, settings: GenerationSettings) => Promise<void>
  regenGenerateImage: (prompt: string, settings: GenerationSettings) => Promise<void>
  regenEditImage: (prompt: string, inputImages: File[], settings: GenerationSettings) => Promise<void>
  regenVideoUrl: string | null
  regenVideoPath: string | null
  regenImageUrl: string | null
  isRegenerating: boolean
  regenProgress: number
  regenCancel: () => void
  regenReset: () => void
  regenError: string | null
  assetSavePath: string | undefined | null
}

export function useGapGeneration({
  clips,
  tracks,
  setClips,
  setTracks,
  setSubtitles,
  currentProjectId,
  addAsset,
  resolveClipSrc,
  regenGenerate,
  regenGenerateImage,
  regenEditImage,
  regenVideoUrl,
  regenVideoPath,
  regenImageUrl,
  isRegenerating,
  regenProgress,
  regenCancel,
  regenReset,
  regenError,
  assetSavePath,
}: UseGapGenerationParams) {
  // Gap selection and generation
  const [selectedGap, setSelectedGap] = useState<{ trackIndex: number; startTime: number; endTime: number } | null>(null)
  const [gapGenerateMode, setGapGenerateMode] = useState<'text-to-video' | 'image-to-video' | 'text-to-image' | null>(null)
  const [gapShotType, setGapShotType] = useState<string>('none')
  const [gapCameraAngle, setGapCameraAngle] = useState<string>('none')
  const gapGenerateModeRef = useRef(gapGenerateMode)
  gapGenerateModeRef.current = gapGenerateMode
  const [gapPrompt, setGapPrompt] = useState('')
  const [gapSettings, setGapSettings] = useState<GenerationSettings>({
    model: 'fast',
    duration: 5,
    videoResolution: '540p',
    fps: 24,
    audio: true,
    cameraMotion: 'none',
    imageResolution: '1080p',
    imageAspectRatio: '16:9',
    imageSteps: 30,
  })
  const [gapImageFile, setGapImageFile] = useState<File | null>(null)
  const gapImageInputRef = useRef<HTMLInputElement>(null)
  const [gapApplyAudioToTrack, setGapApplyAudioToTrack] = useState(true)

  // Tracks the gap currently being generated in the background (after modal closes)
  const [generatingGap, setGeneratingGap] = useState<{
    trackIndex: number; startTime: number; endTime: number
    mode: 'text-to-video' | 'image-to-video' | 'text-to-image'
    prompt: string; settings: GenerationSettings
    imageFile: File | null; applyAudio: boolean
  } | null>(null)

  // Gap context-aware prompt suggestion (via Gemini)
  const [gapSuggesting, setGapSuggesting] = useState(false)
  const [gapSuggestion, setGapSuggestion] = useState<string | null>(null)
  const [gapSuggestionError, setGapSuggestionError] = useState(false)
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
    const mode = gapGenerateMode
    const gapDuration = gap.endTime - gap.startTime
    
    // Compose final prompt with shot type and camera angle modifiers
    let finalPrompt = gapPrompt.trim()
    if (mode === 'text-to-image' || mode === 'image-to-video' || mode === 'text-to-video') {
      const modifiers: string[] = []
      if (gapShotType !== 'none') modifiers.push(gapShotType)
      if (gapCameraAngle !== 'none') modifiers.push(gapCameraAngle)
      if (modifiers.length > 0) {
        finalPrompt = `${modifiers.join(', ')} shot. ${finalPrompt}`
      }
    }
    
    const settings: GenerationSettings = {
      ...gapSettings,
      duration: Math.min(Math.max(1, Math.round(gapDuration)), gapSettings.model === 'pro' ? 10 : 20),
    }

    // Save generating gap state so we can show indicator and place result later
    setGeneratingGap({
      trackIndex: gap.trackIndex,
      startTime: gap.startTime,
      endTime: gap.endTime,
      mode,
      prompt: finalPrompt,
      settings,
      imageFile: gapImageFile,
      applyAudio: gapApplyAudioToTrack,
    })

    // Close the modal immediately so user can keep editing
    setSelectedGap(null)
    setGapGenerateMode(null)
    
    try {
      if (mode === 'text-to-image' && gapImageFile) {
        await regenEditImage(finalPrompt, [gapImageFile], settings)
      } else if (mode === 'text-to-image') {
        await regenGenerateImage(finalPrompt, settings)
      } else {
        // Convert File to filesystem path for the JSON-based generate API
        let imagePath: string | null = null
        if (gapImageFile) {
          const electronPath = (gapImageFile as any).path as string | undefined
          if (electronPath) {
            imagePath = electronPath
          } else {
            // In-memory file (e.g. canvas capture) — save to temp file
            const buf = await gapImageFile.arrayBuffer()
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
            const modelsPath = await window.electronAPI.getModelsPath()
            const tmpDir = modelsPath.replace(/[/\\]models$/, '')
            const tmpPath = `${tmpDir}/tmp_gap_image_${Date.now()}.png`
            await window.electronAPI.saveFile(tmpPath, b64, 'base64')
            imagePath = tmpPath
          }
        }
        await regenGenerate(finalPrompt, imagePath, settings)
      }
    } catch (err) {
      console.error('Gap generation failed:', err)
      setGeneratingGap(null)
    }
  }, [selectedGap, gapGenerateMode, gapPrompt, gapShotType, gapCameraAngle, gapSettings, gapImageFile, gapApplyAudioToTrack, currentProjectId, regenGenerate, regenGenerateImage, regenEditImage])

  // When generation completes, place the result in the gap
  useEffect(() => {
    if (!generatingGap || isRegenerating) return
    
    const isImageResult = generatingGap.mode === 'text-to-image'
    const origUrl = isImageResult ? regenImageUrl : regenVideoUrl
    const origPath = regenVideoPath
    if (!origUrl || !currentProjectId) {
      // Generation ended with no result (cancelled or failed) - clean up
      if (!isRegenerating && generatingGap) {
        setGeneratingGap(null)
        if (!regenError) regenReset()
      }
      return
    }

    const gap = generatingGap
    const gapDuration = gap.endTime - gap.startTime
    const type = isImageResult ? 'image' : 'video'

    ;(async () => {
      const { path: finalPath, url: finalUrl } = await copyToAssetFolder(origPath || origUrl, origUrl, assetSavePath)

      const asset = addAsset(currentProjectId, {
        type: type as 'image' | 'video',
        path: finalPath,
        url: finalUrl,
        prompt: gap.prompt,
        resolution: isImageResult ? gap.settings.imageResolution : gap.settings.videoResolution,
        duration: type === 'video' ? gapDuration : undefined,
        generationParams: {
          mode: (isImageResult ? 'text-to-image' : (gap.imageFile ? 'image-to-video' : 'text-to-video')) as 'text-to-video' | 'image-to-video' | 'text-to-image',
          prompt: gap.prompt,
          model: gap.settings.model,
          duration: Math.min(Math.max(1, Math.round(gapDuration)), gap.settings.model === 'pro' ? 10 : 20),
          resolution: isImageResult ? gap.settings.imageResolution : gap.settings.videoResolution,
          fps: gap.settings.fps,
          audio: gap.settings.audio,
          cameraMotion: gap.settings.cameraMotion,
          imageAspectRatio: gap.settings.imageAspectRatio,
          imageSteps: gap.settings.imageSteps,
        },
        takes: [{
          url: finalUrl,
          path: finalPath,
          createdAt: Date.now(),
        }],
        activeTakeIndex: 0,
      })
      
      const videoClipId = `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const audioClipId = `clip-${Date.now()}-a-${Math.random().toString(36).substr(2, 9)}`

      // Determine if we should create a linked audio clip
      const shouldCreateAudio = type === 'video' && gap.applyAudio && gap.settings.audio

      // Find or create an audio track for the linked audio clip
      let audioTrackIndex = -1
      if (shouldCreateAudio) {
        audioTrackIndex = tracks.findIndex(t => t.kind === 'audio' && !t.locked && t.sourcePatched !== false)
        if (audioTrackIndex < 0) {
          const audioTrackCount = tracks.filter(t => t.kind === 'audio').length
          const newAudioTrack: Track = {
            id: `track-${Date.now()}-audio`,
            name: `A${audioTrackCount + 1}`,
            muted: false,
            locked: false,
            kind: 'audio',
          }
          audioTrackIndex = tracks.length
          setTracks(prev => [...prev, newAudioTrack])
        }
      }

      const newClip: TimelineClip = {
        id: videoClipId,
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
        ...(shouldCreateAudio && audioTrackIndex >= 0 ? { linkedClipIds: [audioClipId] } : {}),
      }

      const newClips: TimelineClip[] = [newClip]

      if (shouldCreateAudio && audioTrackIndex >= 0) {
        newClips.push({
          id: audioClipId,
          assetId: asset.id,
          type: 'audio',
          startTime: gap.startTime,
          duration: gapDuration,
          trimStart: 0,
          trimEnd: 0,
          speed: 1,
          reversed: false,
          muted: false,
          volume: 1,
          trackIndex: audioTrackIndex,
          asset,
          flipH: false,
          flipV: false,
          transitionIn: { type: 'none', duration: 0 },
          transitionOut: { type: 'none', duration: 0 },
          colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
          opacity: 100,
          linkedClipIds: [videoClipId],
        })
      }
      
      setClips(prev => [...prev, ...newClips])
      
      // Clean up generating state
      setGeneratingGap(null)
      setGapPrompt('')
      setGapImageFile(null)
      setGapShotType('none')
      setGapCameraAngle('none')
      regenReset()
    })()
    
  }, [regenVideoUrl, regenImageUrl, isRegenerating, generatingGap, regenError])

  // --- Gap context-aware prompt suggestion via Gemini ---
  // Use refs so the async function always reads the latest values without re-creating
  const gapPromptRef = useRef(gapPrompt)
  gapPromptRef.current = gapPrompt
  const selectedGapRef = useRef(selectedGap)
  selectedGapRef.current = selectedGap
  const gapGenerateModeLocalRef = useRef(gapGenerateMode)
  gapGenerateModeLocalRef.current = gapGenerateMode
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const gapImageFileRef = useRef(gapImageFile)
  gapImageFileRef.current = gapImageFile

  // Stable function that never changes identity — reads everything from refs
  const runSuggestion = useCallback(async (forceReplace: boolean = false) => {
    const gap = selectedGapRef.current
    const mode = gapGenerateModeLocalRef.current
    if (!gap || !mode) return
    
    gapSuggestionAbortRef.current?.abort()
    const abortController = new AbortController()
    gapSuggestionAbortRef.current = abortController
    
    try {
      setGapSuggesting(true)
      setGapSuggestion(null)
      setGapSuggestionError(false)
      
      const { extractFrameAsBase64, extractImageAsBase64 } = await import('../../lib/thumbnails')
      
      const trackClips = clipsRef.current
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
      
      // Convert the user's input image to base64 if present (for edit-mode suggestions)
      let inputImageB64 = ''
      const imageFile = gapImageFileRef.current
      if (imageFile && mode && mode.includes('image')) {
        try {
          const arrayBuf = await imageFile.arrayBuffer()
          const bytes = new Uint8Array(arrayBuf)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          inputImageB64 = btoa(binary)
        } catch {}
      }
      
      const backendUrl = await window.electronAPI.getBackendUrl()
      const response = await fetch(`${backendUrl}/api/suggest-gap-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gapDuration: gap.endTime - gap.startTime,
          mode,
          beforePrompt,
          afterPrompt,
          beforeFrame,
          afterFrame,
          ...(inputImageB64 ? { inputImage: inputImageB64 } : {}),
        }),
        signal: abortController.signal,
      })
      
      if (abortController.signal.aborted) return
      
      if (response.ok) {
        const data = await response.json()
        if (data.suggested_prompt && !abortController.signal.aborted) {
          setGapSuggestion(data.suggested_prompt)
          if (forceReplace || !gapPromptRef.current.trim()) {
            setGapPrompt(data.suggested_prompt)
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.warn('Gap prompt suggestion failed:', err)
      setGapSuggestionError(true)
    } finally {
      if (!abortController.signal.aborted) {
        setGapSuggesting(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveClipSrc])

  // Track whether we've already fired the initial suggestion for this gap+mode combo
  const suggestionFiredKeyRef = useRef<string | null>(null)

  // Auto-run suggestion ONCE when the panel opens (gap + mode set)
  useEffect(() => {
    if (!selectedGap || !gapGenerateMode) {
      setGapSuggesting(false)
      setGapSuggestion(null)
      setGapBeforeFrame(null)
      setGapAfterFrame(null)
      gapSuggestionAbortRef.current?.abort()
      suggestionFiredKeyRef.current = null
      return
    }
    
    // Build a key from the gap identity + mode so we only fire once per unique open
    const key = `${selectedGap.trackIndex}:${selectedGap.startTime}:${selectedGap.endTime}:${gapGenerateMode}`
    if (suggestionFiredKeyRef.current === key) return
    suggestionFiredKeyRef.current = key
    
    runSuggestion(false)
    
    return () => { gapSuggestionAbortRef.current?.abort() }
  }, [selectedGap, gapGenerateMode, runSuggestion])

  // Auto re-analyze when the user adds/removes an input image in T2I mode
  const prevImageFileRef = useRef<File | null>(null)
  useEffect(() => {
    const prev = prevImageFileRef.current
    prevImageFileRef.current = gapImageFile
    
    // Only trigger when the image actually changed (not on initial mount) and in image mode
    if (prev === gapImageFile) return
    if (!gapGenerateMode?.includes('image')) return
    if (!selectedGap) return
    
    // Re-run suggestion with force replace since context changed
    runSuggestion(true)
  }, [gapImageFile, gapGenerateMode, selectedGap, runSuggestion])

  // Manual regenerate: force-replaces the prompt with the new suggestion
  const regenerateSuggestion = useCallback(() => {
    runSuggestion(true)
  }, [runSuggestion])

  // Cancel an in-progress gap generation
  const cancelGapGeneration = useCallback(() => {
    regenCancel()
    regenReset()
    setGeneratingGap(null)
  }, [regenCancel, regenReset])

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
    gapSuggestionError,
    gapBeforeFrame,
    gapAfterFrame,
    gapShotType,
    setGapShotType,
    gapCameraAngle,
    setGapCameraAngle,
    gapApplyAudioToTrack,
    setGapApplyAudioToTrack,
    regenerateSuggestion,
    // Background generation tracking
    generatingGap,
    isRegenerating,
    regenProgress,
    cancelGapGeneration,
    // Computed
    timelineGaps,
    // Actions
    deleteGap,
    handleGapGenerate,
  }
}
