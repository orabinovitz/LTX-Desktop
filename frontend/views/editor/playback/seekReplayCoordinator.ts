import type { DecodeWindowPolicy } from './previewPerformance'
import type { ReplayStartMode } from './replayCoordinator'

export function shouldHoldSeekPreroll(_input: {
  replayStartMode: ReplayStartMode
  audioReady: boolean
  videoReady: boolean
  waitedMs: number
  maxWaitMs: number
}): boolean {
  return _input.replayStartMode === 'seek_preroll'
    && (!_input.audioReady || !_input.videoReady)
    && _input.waitedMs < _input.maxWaitMs
}

export function canPromoteSeekReplay(
  replayStartMode: ReplayStartMode,
  audioReady: boolean,
  videoReady: boolean,
): ReplayStartMode {
  if (replayStartMode === 'seek_preroll' && audioReady && videoReady) {
    return 'replay_after_seek'
  }
  return replayStartMode
}

export function mergeSeekReplayWindowPolicy(input: {
  pausedPolicy: DecodeWindowPolicy
  livePolicy: DecodeWindowPolicy
  replayStartMode: ReplayStartMode
  graceActive: boolean
}): DecodeWindowPolicy {
  if (input.graceActive && (input.replayStartMode === 'seek_preroll' || input.replayStartMode === 'replay_after_seek')) {
    return input.pausedPolicy
  }
  return input.livePolicy
}

export function canUseAnchorClockAfterSeek(
  replayStartMode: ReplayStartMode,
  audioReady: boolean,
  videoReady: boolean,
): boolean {
  if (replayStartMode === 'seek_preroll') return false
  if (replayStartMode === 'replay_after_seek') return audioReady && videoReady
  return true
}

export function computeSeekReplayReadiness(input: {
  audioReadyStates: number[]
  videoReadyState: number | null
}): { audioReady: boolean; videoReady: boolean } {
  return {
    audioReady: input.audioReadyStates.length === 0 || input.audioReadyStates.every((readyState) => readyState >= 2),
    videoReady: input.videoReadyState === null || input.videoReadyState >= 2,
  }
}
