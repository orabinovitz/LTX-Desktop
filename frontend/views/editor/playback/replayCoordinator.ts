export interface PauseSnapshot {
  authoritativeTime: number
  uiTimeAtPause: number
  uiDriftAtPause: number
  anchorClipId: string | null
  sessionFingerprint?: string
  uiSettled: boolean
  pausedSeeked: boolean
  frozenAudioUrls?: Record<string, string>
}

export type PausedTransportSyncAction =
  | 'hold_snapshot'
  | 'mark_ui_settled'
  | 'mark_paused_seek'
  | 'sync_ui_time'

export interface PausedTransportSyncResult {
  action: PausedTransportSyncAction
  nextPlaybackTime: number
  nextPauseSnapshot: PauseSnapshot | null
}

export type ReplayStartMode =
  | 'warm_resume'
  | 'seek_preroll'
  | 'replay_after_seek'
  | 'await_bus_ready'
  | 'cold_start'

export interface ReplaySession {
  replayMode: ReplayStartMode
  sessionFingerprint: string | null
  frozenAudioUrls: Map<string, string>
  frozenAnchorClipId: string | null
}

export function capturePauseSnapshot(input: {
  authoritativeTime: number
  uiTimeAtPause: number
  anchorClipId: string | null
  sessionFingerprint?: string
  frozenAudioUrls?: Record<string, string>
}): PauseSnapshot {
  return {
    authoritativeTime: input.authoritativeTime,
    uiTimeAtPause: input.uiTimeAtPause,
    uiDriftAtPause: Math.abs(input.authoritativeTime - input.uiTimeAtPause),
    anchorClipId: input.anchorClipId,
    sessionFingerprint: input.sessionFingerprint,
    uiSettled: false,
    pausedSeeked: false,
    frozenAudioUrls: input.frozenAudioUrls,
  }
}

export function resolvePausedTransportSync(input: {
  currentTime: number
  pauseSnapshot: PauseSnapshot | null
  toleranceSeconds: number
}): PausedTransportSyncResult {
  if (!input.pauseSnapshot) {
    return {
      action: 'sync_ui_time',
      nextPlaybackTime: input.currentTime,
      nextPauseSnapshot: null,
    }
  }

  const drift = Math.abs(input.currentTime - input.pauseSnapshot.authoritativeTime)

  if (!input.pauseSnapshot.uiSettled) {
    if (drift <= input.toleranceSeconds) {
      return {
        action: 'mark_ui_settled',
        nextPlaybackTime: input.pauseSnapshot.authoritativeTime,
        nextPauseSnapshot: {
          ...input.pauseSnapshot,
          uiSettled: true,
        },
      }
    }

    return {
      action: 'hold_snapshot',
      nextPlaybackTime: input.pauseSnapshot.authoritativeTime,
      nextPauseSnapshot: input.pauseSnapshot,
    }
  }

  if (drift > input.toleranceSeconds) {
    return {
      action: 'mark_paused_seek',
      nextPlaybackTime: input.currentTime,
      nextPauseSnapshot: {
        ...input.pauseSnapshot,
        pausedSeeked: true,
      },
    }
  }

  return {
    action: 'sync_ui_time',
    nextPlaybackTime: input.currentTime,
    nextPauseSnapshot: input.pauseSnapshot,
  }
}

export function resolveReplayStartMode(input: {
  pauseSnapshot: PauseSnapshot | null
  sessionFingerprintChanged: boolean
  busReady: boolean
}): ReplayStartMode {
  if (!input.pauseSnapshot || !input.pauseSnapshot.sessionFingerprint || input.sessionFingerprintChanged) return 'cold_start'
  if (!input.busReady) return 'await_bus_ready'
  if (input.pauseSnapshot.pausedSeeked) return 'seek_preroll'
  return 'warm_resume'
}

export function createReplaySession(input: {
  replayMode: ReplayStartMode
  pauseSnapshot: PauseSnapshot | null
  sessionFingerprint?: string
}): ReplaySession {
  return {
    replayMode: input.replayMode,
    sessionFingerprint: input.sessionFingerprint ?? input.pauseSnapshot?.sessionFingerprint ?? null,
    frozenAudioUrls: new Map(Object.entries(input.pauseSnapshot?.frozenAudioUrls ?? {})),
    frozenAnchorClipId: input.pauseSnapshot?.anchorClipId ?? null,
  }
}

export function buildReplaySessionFingerprint(input: {
  audioUrlsByClipId: Record<string, string>
  preferPreviewAudioProxy: boolean
}): string {
  const orderedEntries = Object.entries(input.audioUrlsByClipId)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([clipId, url]) => `${clipId}=${url}`)

  return `${orderedEntries.join('|')}|proxy=${input.preferPreviewAudioProxy}`
}

export function shouldDeferPausedTransportSync(
  pauseSnapshotPending: boolean,
  pauseSnapshot: PauseSnapshot | null,
): boolean {
  return pauseSnapshotPending && pauseSnapshot === null
}

export function shouldHoldReplayUntilBusReady(input: {
  replayStartMode: ReplayStartMode
  busReady: boolean
  waitedMs: number
  maxWaitMs: number
}): boolean {
  return input.replayStartMode === 'await_bus_ready'
    && !input.busReady
    && input.waitedMs < input.maxWaitMs
}

export function freezeSessionAudioUrl(session: ReplaySession, clipId: string, liveUrl: string): string {
  const existing = session.frozenAudioUrls.get(clipId)
  if (existing) return existing
  session.frozenAudioUrls.set(clipId, liveUrl)
  return liveUrl
}

export function resolveReplayAudioSourceUrl(input: {
  pauseSnapshot: PauseSnapshot | null
  clipId: string
  liveUrl: string
}): string {
  return input.pauseSnapshot?.frozenAudioUrls?.[input.clipId] ?? input.liveUrl
}

export function pickSessionAnchorClipId(
  session: ReplaySession,
  activeClipIds: string[],
  proposedAnchorClipId: string | null,
): string | null {
  if (session.frozenAnchorClipId && activeClipIds.includes(session.frozenAnchorClipId)) {
    return session.frozenAnchorClipId
  }
  session.frozenAnchorClipId = proposedAnchorClipId
  return proposedAnchorClipId
}
