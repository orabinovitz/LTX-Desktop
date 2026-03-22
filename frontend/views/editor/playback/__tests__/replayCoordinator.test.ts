import { describe, expect, it } from 'vitest'

import {
  buildReplaySessionFingerprint,
  capturePauseSnapshot,
  createReplaySession,
  freezeSessionAudioUrl,
  pickSessionAnchorClipId,
  resolveReplayAudioSourceUrl,
  resolvePausedTransportSync,
  resolveReplayStartMode,
  shouldHoldReplayUntilBusReady,
  shouldDeferPausedTransportSync,
  type PauseSnapshot,
} from '../replayCoordinator'

describe('replayCoordinator', () => {
  it('captures the authoritative pause time even when ui time is stale', () => {
    const snapshot = capturePauseSnapshot({
      authoritativeTime: 12.75,
      uiTimeAtPause: 12.5,
      anchorClipId: 'audio-1',
      sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
    })

    expect(snapshot.authoritativeTime).toBe(12.75)
    expect(snapshot.uiTimeAtPause).toBe(12.5)
    expect(snapshot.uiDriftAtPause).toBe(0.25)
    expect(snapshot.anchorClipId).toBe('audio-1')
    expect(snapshot.sessionFingerprint).toBe('clip-a=file:///original.m4a|proxy=false')
    expect(snapshot.uiSettled).toBe(false)
    expect(snapshot.pausedSeeked).toBe(false)
  })

  it('holds authoritative transport time until ui time catches up after pause', () => {
    const snapshot = capturePauseSnapshot({
      authoritativeTime: 8.2,
      uiTimeAtPause: 7.95,
      anchorClipId: null,
    })

    const firstPausedPass = resolvePausedTransportSync({
      currentTime: 7.95,
      pauseSnapshot: snapshot,
      toleranceSeconds: 0.01,
    })

    expect(firstPausedPass.action).toBe('hold_snapshot')
    expect(firstPausedPass.nextPlaybackTime).toBe(8.2)
    expect(firstPausedPass.nextPauseSnapshot?.uiSettled).toBe(false)

    const settledPass = resolvePausedTransportSync({
      currentTime: 8.2,
      pauseSnapshot: firstPausedPass.nextPauseSnapshot,
      toleranceSeconds: 0.01,
    })

    expect(settledPass.action).toBe('mark_ui_settled')
    expect(settledPass.nextPlaybackTime).toBe(8.2)
    expect(settledPass.nextPauseSnapshot?.uiSettled).toBe(true)
  })

  it('marks later paused time movement as an explicit paused seek instead of stale ui overwrite', () => {
    const settledSnapshot: PauseSnapshot = {
      authoritativeTime: 3.5,
      uiTimeAtPause: 3.5,
      uiDriftAtPause: 0,
      anchorClipId: 'audio-1',
      uiSettled: true,
      pausedSeeked: false,
    }

    const result = resolvePausedTransportSync({
      currentTime: 4.0,
      pauseSnapshot: settledSnapshot,
      toleranceSeconds: 0.01,
    })

    expect(result.action).toBe('mark_paused_seek')
    expect(result.nextPlaybackTime).toBe(4.0)
    expect(result.nextPauseSnapshot?.pausedSeeked).toBe(true)
  })

  it('classifies replay starts into warm, after-seek, await-bus, and cold-start paths', () => {
    expect(
      resolveReplayStartMode({
        pauseSnapshot: capturePauseSnapshot({
          authoritativeTime: 1,
          uiTimeAtPause: 1,
          anchorClipId: null,
          sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
        }),
        sessionFingerprintChanged: false,
        busReady: true,
      }),
    ).toBe('warm_resume')

    expect(
      resolveReplayStartMode({
        pauseSnapshot: {
          authoritativeTime: 1,
          uiTimeAtPause: 1,
          uiDriftAtPause: 0,
          anchorClipId: null,
          sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
          uiSettled: true,
          pausedSeeked: true,
        },
        sessionFingerprintChanged: false,
        busReady: true,
      }),
    ).toBe('replay_after_seek')

    expect(
      resolveReplayStartMode({
        pauseSnapshot: capturePauseSnapshot({
          authoritativeTime: 1,
          uiTimeAtPause: 1,
          anchorClipId: null,
          sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
        }),
        sessionFingerprintChanged: false,
        busReady: false,
      }),
    ).toBe('await_bus_ready')

    expect(
      resolveReplayStartMode({
        pauseSnapshot: null,
        sessionFingerprintChanged: true,
        busReady: true,
      }),
    ).toBe('cold_start')
  })

  it('forces cold start when a pause snapshot exists but its fingerprint is missing', () => {
    expect(
      resolveReplayStartMode({
        pauseSnapshot: capturePauseSnapshot({
          authoritativeTime: 1,
          uiTimeAtPause: 1,
          anchorClipId: null,
        }),
        sessionFingerprintChanged: false,
        busReady: true,
      }),
    ).toBe('cold_start')
  })

  it('freezes audio urls and preserves anchor clip across a replay session', () => {
    const session = createReplaySession({
      replayMode: 'warm_resume',
      pauseSnapshot: capturePauseSnapshot({
        authoritativeTime: 5,
        uiTimeAtPause: 5,
        anchorClipId: 'clip-a',
        frozenAudioUrls: { 'clip-a': 'file:///original.m4a' },
      }),
    })

    expect(freezeSessionAudioUrl(session, 'clip-a', 'file:///preview.m4a')).toBe('file:///original.m4a')
    expect(freezeSessionAudioUrl(session, 'clip-b', 'file:///new-preview.m4a')).toBe('file:///new-preview.m4a')
    expect(pickSessionAnchorClipId(session, ['clip-a', 'clip-b'], 'clip-b')).toBe('clip-a')
    expect(pickSessionAnchorClipId(session, ['clip-b'], 'clip-b')).toBe('clip-b')
  })

  it('prefers the paused session frozen audio url over a newly available live proxy on immediate replay', () => {
    const pauseSnapshot = capturePauseSnapshot({
      authoritativeTime: 5,
      uiTimeAtPause: 5,
      anchorClipId: 'clip-a',
      sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
      frozenAudioUrls: { 'clip-a': 'file:///original.m4a' },
    })

    expect(
      resolveReplayAudioSourceUrl({
        pauseSnapshot,
        clipId: 'clip-a',
        liveUrl: 'file:///proxy.m4a',
      }),
    ).toBe('file:///original.m4a')

    expect(
      resolveReplayAudioSourceUrl({
        pauseSnapshot: null,
        clipId: 'clip-a',
        liveUrl: 'file:///proxy.m4a',
      }),
    ).toBe('file:///proxy.m4a')
  })

  it('builds a stable session fingerprint from frozen audio urls and proxy policy', () => {
    const originalFingerprint = buildReplaySessionFingerprint({
      audioUrlsByClipId: {
        'clip-a': 'file:///original-a.m4a',
        'clip-b': 'file:///original-b.m4a',
      },
      preferPreviewAudioProxy: false,
    })

    const proxyFingerprint = buildReplaySessionFingerprint({
      audioUrlsByClipId: {
        'clip-a': 'file:///proxy-a.m4a',
        'clip-b': 'file:///original-b.m4a',
      },
      preferPreviewAudioProxy: true,
    })

    expect(originalFingerprint).toContain('clip-a=file:///original-a.m4a')
    expect(proxyFingerprint).toContain('proxy=true')
    expect(proxyFingerprint).not.toBe(originalFingerprint)
  })

  it('defers paused transport sync until a fresh pause snapshot is captured', () => {
    expect(shouldDeferPausedTransportSync(true, null)).toBe(true)
    expect(
      shouldDeferPausedTransportSync(
        true,
        capturePauseSnapshot({
          authoritativeTime: 2,
          uiTimeAtPause: 2,
          anchorClipId: null,
          sessionFingerprint: 'clip-a=file:///original.m4a|proxy=false',
        }),
      ),
    ).toBe(false)
    expect(shouldDeferPausedTransportSync(false, null)).toBe(false)
  })

  it('holds replay briefly while waiting for the audio bus, then stops waiting', () => {
    expect(
      shouldHoldReplayUntilBusReady({
        replayStartMode: 'await_bus_ready',
        busReady: false,
        waitedMs: 10,
        maxWaitMs: 40,
      }),
    ).toBe(true)

    expect(
      shouldHoldReplayUntilBusReady({
        replayStartMode: 'await_bus_ready',
        busReady: false,
        waitedMs: 60,
        maxWaitMs: 40,
      }),
    ).toBe(false)

    expect(
      shouldHoldReplayUntilBusReady({
        replayStartMode: 'warm_resume',
        busReady: false,
        waitedMs: 10,
        maxWaitMs: 40,
      }),
    ).toBe(false)
  })
})
