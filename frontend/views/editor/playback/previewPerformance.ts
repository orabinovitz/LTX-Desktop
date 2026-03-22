import type { TimelineClip, Track } from '../../../types/project'

export type PreviewPerformanceTier = 'full' | 'balanced' | 'audio-priority' | 'proxy-required'

export interface TimelineComplexitySummary {
  clipCount: number
  timelineDuration: number
  maxConcurrentAudibleClips: number
  maxConcurrentVisualClips: number
  cutsPerMinute: number
  dissolveCount: number
  stackedOpacityClips: number
  activeVideoTrackCount: number
  activeAudioTrackCount: number
}

export interface DecodeWindowPolicy {
  lookBehindSeconds: number
  lookAheadSeconds: number
  maxVideoSources: number
  playbackResolution: 1 | 0.5 | 0.25
  preferPreviewAudioProxy: boolean
}

export interface PlaybackBenchmarkScenario {
  id: string
  name: string
  summary: TimelineComplexitySummary
  targetTier: PreviewPerformanceTier
  notes: string
}

function countConcurrentClips(clips: TimelineClip[], isRelevant: (clip: TimelineClip) => boolean): number {
  const events: Array<{ time: number; delta: number }> = []
  for (const clip of clips) {
    if (!isRelevant(clip)) continue
    events.push({ time: clip.startTime, delta: 1 })
    events.push({ time: clip.startTime + clip.duration, delta: -1 })
  }

  // Treat clips as [start, end) intervals so an outgoing clip ending at the exact
  // boundary does not overlap the incoming clip that starts there.
  events.sort((a, b) => (a.time === b.time ? a.delta - b.delta : a.time - b.time))

  let active = 0
  let maxActive = 0
  for (const event of events) {
    active += event.delta
    maxActive = Math.max(maxActive, active)
  }

  return maxActive
}

export function analyzeTimelineComplexity(clips: TimelineClip[], tracks: Track[]): TimelineComplexitySummary {
  const timelineDuration = clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
  const enabledClips = clips.filter((clip) => tracks[clip.trackIndex]?.enabled !== false)
  const audibleClips = enabledClips.filter((clip) => clip.type === 'audio' && !clip.muted && clip.volume > 0 && !tracks[clip.trackIndex]?.muted)
  const visualClips = enabledClips.filter((clip) => clip.type === 'video' || clip.type === 'image')
  const videoTrackIds = new Set(
    enabledClips
      .filter((clip) => (clip.type === 'video' || clip.type === 'image') && tracks[clip.trackIndex]?.kind !== 'audio')
      .map((clip) => clip.trackIndex),
  )
  const audioTrackIds = new Set(
    enabledClips
      .filter((clip) => clip.type === 'audio' || tracks[clip.trackIndex]?.kind === 'audio')
      .map((clip) => clip.trackIndex),
  )
  const cutEvents = enabledClips.filter((clip) => clip.type !== 'audio').length
  const dissolveCount = enabledClips.filter((clip) => clip.transitionOut?.type === 'dissolve' && clip.transitionOut.duration > 0).length
  const stackedOpacityClips = enabledClips.filter((clip) => (clip.type === 'video' || clip.type === 'image') && (clip.opacity ?? 100) < 100).length
  const cutsPerMinute = timelineDuration > 0 ? (cutEvents / timelineDuration) * 60 : 0

  return {
    clipCount: clips.length,
    timelineDuration,
    maxConcurrentAudibleClips: countConcurrentClips(audibleClips, () => true),
    maxConcurrentVisualClips: countConcurrentClips(visualClips, () => true),
    cutsPerMinute,
    dissolveCount,
    stackedOpacityClips,
    activeVideoTrackCount: videoTrackIds.size,
    activeAudioTrackCount: audioTrackIds.size,
  }
}

export function selectPreviewPerformanceTier(
  summary: TimelineComplexitySummary,
  options: { lowEndDevice?: boolean; gpuAvailable?: boolean } = {},
): PreviewPerformanceTier {
  let score = 0

  if (options.lowEndDevice) score += 2
  if (options.gpuAvailable === false) score += 1
  if (summary.clipCount >= 20) score += 1
  if (summary.maxConcurrentAudibleClips >= 4) score += 2
  if (summary.maxConcurrentVisualClips >= 3) score += 1
  if (summary.cutsPerMinute >= 30) score += 1
  if (summary.dissolveCount >= 2) score += 1
  if (summary.stackedOpacityClips >= 2) score += 1

  if (score >= 11) return 'proxy-required'
  if (score >= 6) return 'audio-priority'
  if (score >= 3) return 'balanced'
  return 'full'
}

export function getDecodeWindowPolicy(tier: PreviewPerformanceTier, isPlaying: boolean): DecodeWindowPolicy {
  const stationaryWindow = isPlaying ? 1 : 4

  if (tier === 'proxy-required') {
    return {
      lookBehindSeconds: stationaryWindow,
      lookAheadSeconds: 2,
      maxVideoSources: 1,
      playbackResolution: 0.25,
      preferPreviewAudioProxy: true,
    }
  }

  if (tier === 'audio-priority') {
    return {
      lookBehindSeconds: stationaryWindow,
      lookAheadSeconds: 3,
      maxVideoSources: 2,
      playbackResolution: 0.25,
      preferPreviewAudioProxy: true,
    }
  }

  if (tier === 'balanced') {
    return {
      lookBehindSeconds: stationaryWindow + 1,
      lookAheadSeconds: 5,
      maxVideoSources: 4,
      playbackResolution: 0.5,
      preferPreviewAudioProxy: false,
    }
  }

  return {
    lookBehindSeconds: stationaryWindow + 2,
    lookAheadSeconds: 8,
    maxVideoSources: 6,
    playbackResolution: 1,
    preferPreviewAudioProxy: false,
  }
}

export function createPlaybackBenchmarkScenarios(): PlaybackBenchmarkScenario[] {
  return [
    {
      id: 'single-clip-baseline',
      name: 'Single clip baseline',
      summary: {
        clipCount: 1,
        timelineDuration: 8,
        maxConcurrentAudibleClips: 1,
        maxConcurrentVisualClips: 1,
        cutsPerMinute: 7.5,
        dissolveCount: 0,
        stackedOpacityClips: 0,
        activeVideoTrackCount: 1,
        activeAudioTrackCount: 1,
      },
      targetTier: 'full',
      notes: 'Sanity check for 1x playback with a single video/audio source.',
    },
    {
      id: 'many-cuts',
      name: 'Rapid cut density',
      summary: {
        clipCount: 32,
        timelineDuration: 30,
        maxConcurrentAudibleClips: 2,
        maxConcurrentVisualClips: 1,
        cutsPerMinute: 64,
        dissolveCount: 0,
        stackedOpacityClips: 0,
        activeVideoTrackCount: 1,
        activeAudioTrackCount: 2,
      },
      targetTier: 'balanced',
      notes: 'Detects seek churn and decoder restarts around dense edits.',
    },
    {
      id: 'audio-overlap-stack',
      name: 'Audio overlap stack',
      summary: {
        clipCount: 14,
        timelineDuration: 24,
        maxConcurrentAudibleClips: 6,
        maxConcurrentVisualClips: 2,
        cutsPerMinute: 20,
        dissolveCount: 1,
        stackedOpacityClips: 1,
        activeVideoTrackCount: 2,
        activeAudioTrackCount: 4,
      },
      targetTier: 'audio-priority',
      notes: 'Validates headroom, limiter behavior, and overlap continuity.',
    },
    {
      id: 'dissolve-composite',
      name: 'Dissolve plus compositing',
      summary: {
        clipCount: 18,
        timelineDuration: 40,
        maxConcurrentAudibleClips: 3,
        maxConcurrentVisualClips: 3,
        cutsPerMinute: 27,
        dissolveCount: 4,
        stackedOpacityClips: 3,
        activeVideoTrackCount: 3,
        activeAudioTrackCount: 2,
      },
      targetTier: 'balanced',
      notes: 'Exercises dissolves, opacity stacks, and secondary video sync.',
    },
    {
      id: 'low-end-stress',
      name: 'Low-end stress test',
      summary: {
        clipCount: 48,
        timelineDuration: 60,
        maxConcurrentAudibleClips: 8,
        maxConcurrentVisualClips: 4,
        cutsPerMinute: 48,
        dissolveCount: 6,
        stackedOpacityClips: 4,
        activeVideoTrackCount: 4,
        activeAudioTrackCount: 5,
      },
      targetTier: 'proxy-required',
      notes: 'Reference worst case for low-end laptops and adaptive degradation.',
    },
  ]
}
