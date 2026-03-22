import { describe, expect, it } from 'vitest'

import type { TimelineClip, Track } from '../../../../types/project'
import {
  analyzeTimelineComplexity,
  createPlaybackBenchmarkScenarios,
  getDecodeWindowPolicy,
  selectPreviewPerformanceTier,
} from '../previewPerformance'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track-${Math.random().toString(36).slice(2)}`,
    name: 'Track',
    muted: false,
    locked: false,
    enabled: true,
    sourcePatched: true,
    kind: 'video',
    ...overrides,
  }
}

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: `clip-${Math.random().toString(36).slice(2)}`,
    assetId: 'asset-1',
    type: 'video',
    startTime: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: 0,
    speed: 1,
    reversed: false,
    muted: false,
    volume: 1,
    trackIndex: 0,
    asset: null,
    flipH: false,
    flipV: false,
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    colorCorrection: {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      exposure: 0,
      highlights: 0,
      shadows: 0,
    },
    opacity: 100,
    ...overrides,
  }
}

describe('previewPerformance', () => {
  it('measures overlap, dissolves, and cut density for a heavy timeline', () => {
    const tracks: Track[] = [
      makeTrack({ id: 'v1', kind: 'video' }),
      makeTrack({ id: 'v2', kind: 'video' }),
      makeTrack({ id: 'a1', kind: 'audio' }),
      makeTrack({ id: 'a2', kind: 'audio' }),
    ]

    const clips: TimelineClip[] = [
      makeClip({ id: 'v1-a', type: 'video', duration: 3, trackIndex: 0, transitionOut: { type: 'dissolve', duration: 0.5 } }),
      makeClip({ id: 'v1-b', type: 'video', startTime: 3, duration: 3, trackIndex: 0, transitionIn: { type: 'dissolve', duration: 0.5 } }),
      makeClip({ id: 'v2-a', type: 'video', startTime: 0.5, duration: 4, trackIndex: 1, opacity: 60 }),
      makeClip({ id: 'a1-a', type: 'audio', startTime: 0, duration: 6, trackIndex: 2 }),
      makeClip({ id: 'a2-a', type: 'audio', startTime: 1, duration: 4, trackIndex: 3 }),
      makeClip({ id: 'a2-b', type: 'audio', startTime: 2, duration: 3, trackIndex: 3 }),
    ]

    const summary = analyzeTimelineComplexity(clips, tracks)

    expect(summary.maxConcurrentAudibleClips).toBe(3)
    expect(summary.dissolveCount).toBe(1)
    expect(summary.maxConcurrentVisualClips).toBe(2)
    expect(summary.cutsPerMinute).toBeGreaterThan(20)
  })

  it('selects an audio-priority tier for low-end high-overlap timelines', () => {
    const tier = selectPreviewPerformanceTier(
      {
        clipCount: 24,
        timelineDuration: 42,
        maxConcurrentAudibleClips: 6,
        maxConcurrentVisualClips: 4,
        cutsPerMinute: 48,
        dissolveCount: 3,
        stackedOpacityClips: 2,
        activeVideoTrackCount: 3,
        activeAudioTrackCount: 4,
      },
      { lowEndDevice: true, gpuAvailable: false },
    )

    expect(tier).toBe('audio-priority')
  })

  it('returns bounded decode budgets that favor audio continuity under load', () => {
    const policy = getDecodeWindowPolicy('audio-priority', true)

    expect(policy.playbackResolution).toBe(0.25)
    expect(policy.maxVideoSources).toBe(2)
    expect(policy.preferPreviewAudioProxy).toBe(true)
    expect(policy.lookAheadSeconds).toBeLessThanOrEqual(3)
  })

  it('defines the required manual benchmark scenarios', () => {
    const scenarioIds = createPlaybackBenchmarkScenarios().map((scenario) => scenario.id)

    expect(scenarioIds).toContain('single-clip-baseline')
    expect(scenarioIds).toContain('many-cuts')
    expect(scenarioIds).toContain('audio-overlap-stack')
    expect(scenarioIds).toContain('dissolve-composite')
    expect(scenarioIds).toContain('low-end-stress')
  })
})
