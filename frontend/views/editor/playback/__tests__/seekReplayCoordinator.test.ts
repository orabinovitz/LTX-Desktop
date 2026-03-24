import { describe, expect, it } from 'vitest'

import type { DecodeWindowPolicy } from '../previewPerformance'
import {
  canPromoteSeekReplay,
  canUseAnchorClockAfterSeek,
  computeSeekReplayReadiness,
  mergeSeekReplayWindowPolicy,
  shouldHoldSeekPreroll,
} from '../seekReplayCoordinator'

describe('seekReplayCoordinator', () => {
  it('holds seek preroll until both audio and video are ready or the wait budget expires', () => {
    expect(
      shouldHoldSeekPreroll({
        replayStartMode: 'seek_preroll',
        audioReady: false,
        videoReady: true,
        waitedMs: 15,
        maxWaitMs: 40,
      }),
    ).toBe(true)

    expect(
      shouldHoldSeekPreroll({
        replayStartMode: 'seek_preroll',
        audioReady: true,
        videoReady: true,
        waitedMs: 15,
        maxWaitMs: 40,
      }),
    ).toBe(false)

    expect(
      shouldHoldSeekPreroll({
        replayStartMode: 'seek_preroll',
        audioReady: false,
        videoReady: false,
        waitedMs: 80,
        maxWaitMs: 40,
      }),
    ).toBe(false)
  })

  it('promotes seek preroll into replay-after-seek only when media is ready', () => {
    expect(canPromoteSeekReplay('seek_preroll', true, true)).toBe('replay_after_seek')
    expect(canPromoteSeekReplay('seek_preroll', true, false)).toBe('seek_preroll')
    expect(canPromoteSeekReplay('warm_resume', true, true)).toBe('warm_resume')
  })

  it('keeps the paused decode window alive during seek replay grace periods', () => {
    const pausedPolicy: DecodeWindowPolicy = {
      lookBehindSeconds: 4,
      lookAheadSeconds: 8,
      maxVideoSources: 6,
      playbackResolution: 0.5,
      preferPreviewAudioProxy: false,
    }
    const livePolicy: DecodeWindowPolicy = {
      lookBehindSeconds: 1,
      lookAheadSeconds: 3,
      maxVideoSources: 2,
      playbackResolution: 0.25,
      preferPreviewAudioProxy: true,
    }

    expect(
      mergeSeekReplayWindowPolicy({
        pausedPolicy,
        livePolicy,
        replayStartMode: 'seek_preroll',
        graceActive: true,
      }),
    ).toEqual(pausedPolicy)

    expect(
      mergeSeekReplayWindowPolicy({
        pausedPolicy,
        livePolicy,
        replayStartMode: 'replay_after_seek',
        graceActive: false,
      }),
    ).toEqual(livePolicy)
  })

  it('delays anchor-clock authority until seek-replay media has settled', () => {
    expect(canUseAnchorClockAfterSeek('seek_preroll', true, true)).toBe(false)
    expect(canUseAnchorClockAfterSeek('replay_after_seek', true, true)).toBe(true)
    expect(canUseAnchorClockAfterSeek('replay_after_seek', true, false)).toBe(false)
    expect(canUseAnchorClockAfterSeek('warm_resume', false, false)).toBe(true)
  })

  it('derives readiness from media readyState thresholds', () => {
    expect(computeSeekReplayReadiness({ audioReadyStates: [2, 4], videoReadyState: 2 })).toEqual({
      audioReady: true,
      videoReady: true,
    })
    expect(computeSeekReplayReadiness({ audioReadyStates: [1, 4], videoReadyState: 2 })).toEqual({
      audioReady: false,
      videoReady: true,
    })
    expect(computeSeekReplayReadiness({ audioReadyStates: [3], videoReadyState: 1 })).toEqual({
      audioReady: true,
      videoReady: false,
    })
  })
})
