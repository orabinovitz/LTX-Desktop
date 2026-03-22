export interface PlaybackDiagnosticEvent {
  type: string
  clipId?: string
  value?: number
}

export interface PlaybackDiagnosticsSnapshot {
  driftSamples: number
  p95DriftSeconds: number
  pauseBoundaryDriftSeconds: number
  pausedRefHolds: number
  pausedScrubSeeks: number
  sessionFingerprintInvalidations: number
  warmResumes: number
  replayAfterSeekStarts: number
  coldStarts: number
  awaitBusReadyStarts: number
  audioHardSeeks: number
  videoHardSeeks: number
  playRetries: number
  longTasks: number
  underruns: number
  audibleSources: number
  videoSources: number
}

export class PlaybackDiagnosticsStore {
  private readonly maxRecentEvents: number

  private readonly driftValues: number[] = []

  private readonly events: PlaybackDiagnosticEvent[] = []

  private audioHardSeekCount = 0

  private videoHardSeekCount = 0

  private pauseBoundaryDriftSeconds = 0

  private pausedRefHoldCount = 0

  private pausedScrubSeekCount = 0

  private sessionFingerprintInvalidationCount = 0

  private warmResumeCount = 0

  private replayAfterSeekCount = 0

  private coldStartCount = 0

  private awaitBusReadyCount = 0

  private playRetryCount = 0

  private longTaskCount = 0

  private underrunCount = 0

  private audibleSourceCount = 0

  private videoSourceCount = 0

  constructor(options: { maxRecentEvents?: number } = {}) {
    this.maxRecentEvents = options.maxRecentEvents ?? 50
  }

  private pushEvent(event: PlaybackDiagnosticEvent): void {
    this.events.push(event)
    if (this.events.length > this.maxRecentEvents) {
      this.events.splice(0, this.events.length - this.maxRecentEvents)
    }
  }

  recordDrift(seconds: number): void {
    this.driftValues.push(seconds)
    this.pushEvent({ type: 'drift', value: seconds })
  }

  recordHardSeek(kind: 'audio' | 'video', driftSeconds: number): void {
    if (kind === 'audio') {
      this.audioHardSeekCount += 1
    } else {
      this.videoHardSeekCount += 1
    }
    this.pushEvent({ type: `${kind}-hard-seek`, value: driftSeconds })
  }

  recordPauseBoundary(driftSeconds: number): void {
    this.pauseBoundaryDriftSeconds = driftSeconds
    this.pushEvent({ type: 'pause-boundary', value: driftSeconds })
  }

  recordPausedRefHold(): void {
    this.pausedRefHoldCount += 1
    this.pushEvent({ type: 'paused-ref-hold' })
  }

  recordPausedScrubSeek(clipId: string): void {
    this.pausedScrubSeekCount += 1
    this.pushEvent({ type: 'paused-scrub-seek', clipId })
  }

  recordSessionFingerprintInvalidation(): void {
    this.sessionFingerprintInvalidationCount += 1
    this.pushEvent({ type: 'session-fingerprint-invalidation' })
  }

  recordReplayStartMode(mode: 'warm_resume' | 'replay_after_seek' | 'cold_start' | 'await_bus_ready'): void {
    if (mode === 'warm_resume') this.warmResumeCount += 1
    if (mode === 'replay_after_seek') this.replayAfterSeekCount += 1
    if (mode === 'cold_start') this.coldStartCount += 1
    if (mode === 'await_bus_ready') this.awaitBusReadyCount += 1
    this.pushEvent({ type: `replay-${mode}` })
  }

  recordPlayRetry(clipId: string): void {
    this.playRetryCount += 1
    this.pushEvent({ type: 'play-retry', clipId })
  }

  recordLongTask(durationMs: number): void {
    this.longTaskCount += 1
    this.pushEvent({ type: 'long-task', value: durationMs })
  }

  recordUnderrun(clipId: string): void {
    this.underrunCount += 1
    this.pushEvent({ type: 'underrun', clipId })
  }

  setActiveCounts(counts: { audibleSources: number; videoSources: number }): void {
    this.audibleSourceCount = counts.audibleSources
    this.videoSourceCount = counts.videoSources
  }

  private percentile(values: number[], ratio: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
    return sorted[index]
  }

  snapshot(): PlaybackDiagnosticsSnapshot {
    return {
      driftSamples: this.driftValues.length,
      p95DriftSeconds: this.percentile(this.driftValues, 0.95),
      pauseBoundaryDriftSeconds: this.pauseBoundaryDriftSeconds,
      pausedRefHolds: this.pausedRefHoldCount,
      pausedScrubSeeks: this.pausedScrubSeekCount,
      sessionFingerprintInvalidations: this.sessionFingerprintInvalidationCount,
      warmResumes: this.warmResumeCount,
      replayAfterSeekStarts: this.replayAfterSeekCount,
      coldStarts: this.coldStartCount,
      awaitBusReadyStarts: this.awaitBusReadyCount,
      audioHardSeeks: this.audioHardSeekCount,
      videoHardSeeks: this.videoHardSeekCount,
      playRetries: this.playRetryCount,
      longTasks: this.longTaskCount,
      underruns: this.underrunCount,
      audibleSources: this.audibleSourceCount,
      videoSources: this.videoSourceCount,
    }
  }

  recentEvents(): PlaybackDiagnosticEvent[] {
    return [...this.events]
  }
}
