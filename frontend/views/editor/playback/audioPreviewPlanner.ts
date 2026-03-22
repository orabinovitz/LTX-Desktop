import type { TimelineClip, Track } from '../../../types/project'

function hasLinkedAudioClip(clip: TimelineClip, allClips: TimelineClip[]): boolean {
  return Boolean(
    clip.linkedClipIds?.some((linkedClipId) => allClips.some((candidate) => candidate.id === linkedClipId && candidate.type === 'audio')),
  )
}

export function getAudiblePreviewClips(clips: TimelineClip[], tracks: Track[], time: number): TimelineClip[] {
  const anySoloed = tracks.some((track) => track.solo)
  return clips.filter((clip) => {
    if (clip.type === 'adjustment' || clip.type === 'text' || clip.type === 'image') return false
    if (time < clip.startTime || time >= clip.startTime + clip.duration) return false

    const track = tracks[clip.trackIndex]
    if (!track || track.enabled === false || track.muted) return false
    if (anySoloed && !track.solo) return false
    if (clip.muted || clip.volume <= 0) return false
    if (clip.type !== 'audio') return false

    return true
  })
}

export function computeClipTargetTime(clip: TimelineClip, assetDuration: number, timelineTime: number): number {
  const timeInClip = timelineTime - clip.startTime
  if (clip.reversed) {
    return Math.max(0, assetDuration - clip.trimEnd - timeInClip * clip.speed)
  }
  return Math.max(0, clip.trimStart + timeInClip * clip.speed)
}

export function chooseAnchorClip(activeClips: TimelineClip[], previousAnchorClipId?: string | null): TimelineClip | null {
  if (previousAnchorClipId) {
    return activeClips.find((clip) => clip.id === previousAnchorClipId) ?? null
  }
  return [...activeClips].sort((a, b) => {
    if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex
    return a.startTime - b.startTime
  })[0] ?? null
}

export function computeTimelineTimeFromAnchor(clip: TimelineClip, currentTime: number): number {
  if (clip.reversed) {
    const estimatedAssetDuration = clip.asset?.duration ?? (clip.duration * clip.speed + clip.trimStart + clip.trimEnd)
    return clip.startTime + (estimatedAssetDuration - clip.trimEnd - currentTime) / clip.speed
  }

  return clip.startTime + (currentTime - clip.trimStart) / clip.speed
}

export function supportsAudiblePreviewTransport(shuttleSpeed: number, reversed: boolean): boolean {
  return shuttleSpeed === 0 && !reversed
}

export function computeMasterGainForActiveClipCount(activeClipCount: number): number {
  if (activeClipCount <= 1) return 1
  return Number(Math.min(1, 1 / Math.sqrt(activeClipCount)).toFixed(3))
}

export function countPreviewExportParityRisks(clips: TimelineClip[], tracks: Track[]): number {
  return clips.filter((clip) => {
    if (clip.type !== 'video') return false
    if (clip.muted || clip.volume <= 0) return false

    const track = tracks[clip.trackIndex]
    if (!track || track.enabled === false || track.muted) return false

    return !hasLinkedAudioClip(clip, clips)
  }).length
}

export function computeRateCorrection(desiredRate: number, driftSeconds: number): number {
  const correction = Math.max(-0.1, Math.min(0.1, driftSeconds * 0.5))
  return Number((desiredRate + correction).toFixed(3))
}
