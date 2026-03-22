import { describe, expect, it } from 'vitest'

import type { TimelineClip, Track } from '../../../../types/project'
import {
  chooseAnchorClip,
  countPreviewExportParityRisks,
  computeClipTargetTime,
  computeMasterGainForActiveClipCount,
  computeRateCorrection,
  computeTimelineTimeFromAnchor,
  getAudiblePreviewClips,
  supportsAudiblePreviewTransport,
} from '../audioPreviewPlanner'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track-${Math.random().toString(36).slice(2)}`,
    name: 'Track',
    muted: false,
    locked: false,
    enabled: true,
    sourcePatched: true,
    kind: 'audio',
    ...overrides,
  }
}

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: `clip-${Math.random().toString(36).slice(2)}`,
    assetId: 'asset-1',
    type: 'audio',
    startTime: 0,
    duration: 4,
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

describe('audioPreviewPlanner', () => {
  it('filters audible preview clips using track mute/enable rules', () => {
    const tracks: Track[] = [
      makeTrack({ id: 'a1', kind: 'audio' }),
      makeTrack({ id: 'a2', kind: 'audio', muted: true }),
      makeTrack({ id: 'a3', kind: 'audio', enabled: false }),
    ]

    const clips: TimelineClip[] = [
      makeClip({ id: 'audible', trackIndex: 0 }),
      makeClip({ id: 'muted-track', trackIndex: 1 }),
      makeClip({ id: 'disabled-track', trackIndex: 2 }),
    ]

    const active = getAudiblePreviewClips(clips, tracks, 1)

    expect(active.map((clip) => clip.id)).toEqual(['audible'])
  })

  it('prefers the dedicated audio clip over the linked video clip so the same source is not mixed twice', () => {
    const tracks: Track[] = [
      makeTrack({ id: 'v1', kind: 'video' }),
      makeTrack({ id: 'a1', kind: 'audio' }),
    ]
    const linkedAudio = makeClip({ id: 'linked-audio', type: 'audio', trackIndex: 1 })
    const linkedVideo = makeClip({ id: 'linked-video', type: 'video', trackIndex: 0, linkedClipIds: ['linked-audio'] })

    const active = getAudiblePreviewClips([linkedVideo, linkedAudio], tracks, 1)

    expect(active.map((clip) => clip.id)).toEqual(['linked-audio'])
  })

  it('computes source target time for forward and reversed clips', () => {
    const forward = makeClip({ trimStart: 1, speed: 2, startTime: 4 })
    const reversed = makeClip({ trimStart: 1, trimEnd: 0.5, speed: 1.5, startTime: 4, reversed: true })

    expect(computeClipTargetTime(forward, 10, 5)).toBe(3)
    expect(computeClipTargetTime(reversed, 10, 5)).toBe(8)
  })

  it('keeps the previous anchor when it is still active', () => {
    const clips = [
      makeClip({ id: 'clip-a' }),
      makeClip({ id: 'clip-b' }),
    ]

    const anchor = chooseAnchorClip(clips, 'clip-b')

    expect(anchor?.id).toBe('clip-b')
  })

  it('maps anchor media time back to timeline time', () => {
    const clip = makeClip({ startTime: 6, trimStart: 1, speed: 2 })

    expect(computeTimelineTimeFromAnchor(clip, 5)).toBe(8)
  })

  it('degrades audible preview for unsupported shuttle transports and adds headroom for overlap', () => {
    expect(supportsAudiblePreviewTransport(0, false)).toBe(true)
    expect(supportsAudiblePreviewTransport(2, false)).toBe(false)
    expect(supportsAudiblePreviewTransport(1, true)).toBe(false)
    expect(computeMasterGainForActiveClipCount(1)).toBe(1)
    expect(computeMasterGainForActiveClipCount(4)).toBeLessThan(1)
  })

  it('counts video clips that export audio but currently lack preview parity', () => {
    const tracks: Track[] = [makeTrack({ id: 'v1', kind: 'video' }), makeTrack({ id: 'a1', kind: 'audio' })]
    const videoWithoutLinkedAudio = makeClip({ id: 'video-risk', type: 'video', trackIndex: 0, linkedClipIds: undefined })
    const videoWithLinkedAudio = makeClip({ id: 'video-safe', type: 'video', trackIndex: 0, linkedClipIds: ['linked-audio'] })
    const linkedAudio = makeClip({ id: 'linked-audio', type: 'audio', trackIndex: 1 })

    expect(countPreviewExportParityRisks([videoWithoutLinkedAudio, videoWithLinkedAudio, linkedAudio], tracks)).toBe(1)
  })

  it('applies bounded playback-rate correction before falling back to hard seeks', () => {
    expect(computeRateCorrection(1, 0.2)).toBeGreaterThan(1)
    expect(computeRateCorrection(1, -0.2)).toBeLessThan(1)
    expect(computeRateCorrection(2, 1)).toBe(2.1)
    expect(computeRateCorrection(2, -1)).toBe(1.9)
  })
})
