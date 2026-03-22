import { describe, expect, it } from 'vitest'

import type { TimelineClip } from '../../../../types/project'
import type { DecodeWindowPolicy } from '../previewPerformance'
import { computeBoundaryGain, selectBufferedVideoSources } from '../previewWindowPlanner'

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: `clip-${Math.random().toString(36).slice(2)}`,
    assetId: 'asset-1',
    type: 'video',
    startTime: 0,
    duration: 2,
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

describe('previewWindowPlanner', () => {
  it('limits buffered video sources to the bounded decode window around the playhead', () => {
    const policy: DecodeWindowPolicy = {
      lookBehindSeconds: 1,
      lookAheadSeconds: 3,
      maxVideoSources: 2,
      playbackResolution: 0.25,
      preferPreviewAudioProxy: true,
    }

    const clips = [
      makeClip({ id: 'a', startTime: 0, duration: 2 }),
      makeClip({ id: 'b', startTime: 2, duration: 2 }),
      makeClip({ id: 'c', startTime: 5, duration: 2 }),
      makeClip({ id: 'd', startTime: 7, duration: 2 }),
    ]

    const sources = selectBufferedVideoSources(
      clips,
      2.2,
      policy,
      (clip) => `file://${clip.id}.mp4`,
    )

    expect(Array.from(sources)).toEqual(['file://b.mp4', 'file://c.mp4'])
  })

  it('ramps audio gain at clip boundaries to reduce clicks', () => {
    const clip = makeClip({ startTime: 10, duration: 5 })

    expect(computeBoundaryGain(clip, 10, 0.02)).toBe(0)
    expect(computeBoundaryGain(clip, 10.01, 0.02)).toBe(0.5)
    expect(computeBoundaryGain(clip, 12, 0.02)).toBe(1)
    expect(computeBoundaryGain(clip, 14.99, 0.02)).toBe(0.5)
  })
})
