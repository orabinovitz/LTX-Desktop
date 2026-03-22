import { describe, expect, it } from 'vitest'

import { PlaybackDiagnosticsStore } from '../playbackDiagnostics'

describe('PlaybackDiagnosticsStore', () => {
  it('aggregates drift, seek, retry, and long-task metrics into a snapshot', () => {
    const store = new PlaybackDiagnosticsStore({ maxRecentEvents: 5 })

    store.recordDrift(0.02)
    store.recordDrift(0.04)
    store.recordDrift(0.1)
    store.recordHardSeek('audio', 0.12)
    store.recordHardSeek('video', 0.34)
    store.recordPlayRetry('clip-a')
    store.recordPlayRetry('clip-a')
    store.recordLongTask(67)
    store.recordUnderrun('clip-a')
    store.setActiveCounts({ audibleSources: 3, videoSources: 2 })

    const snapshot = store.snapshot()

    expect(snapshot.driftSamples).toBe(3)
    expect(snapshot.p95DriftSeconds).toBe(0.1)
    expect(snapshot.audioHardSeeks).toBe(1)
    expect(snapshot.videoHardSeeks).toBe(1)
    expect(snapshot.playRetries).toBe(2)
    expect(snapshot.longTasks).toBe(1)
    expect(snapshot.underruns).toBe(1)
    expect(snapshot.audibleSources).toBe(3)
    expect(snapshot.videoSources).toBe(2)
  })

  it('caps recent events and keeps the newest measurements', () => {
    const store = new PlaybackDiagnosticsStore({ maxRecentEvents: 3 })

    store.recordPlayRetry('clip-a')
    store.recordPlayRetry('clip-b')
    store.recordPlayRetry('clip-c')
    store.recordPlayRetry('clip-d')

    const events = store.recentEvents()

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.clipId)).toEqual(['clip-b', 'clip-c', 'clip-d'])
  })
})
