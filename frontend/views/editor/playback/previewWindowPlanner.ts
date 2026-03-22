import type { TimelineClip } from '../../../types/project'
import type { DecodeWindowPolicy } from './previewPerformance'

export function selectBufferedVideoSources(
  clips: TimelineClip[],
  time: number,
  policy: DecodeWindowPolicy,
  resolveClipSrc: (clip: TimelineClip) => string,
): Set<string> {
  const windowStart = Math.max(0, time - policy.lookBehindSeconds)
  const windowEnd = time + policy.lookAheadSeconds

  const ranked = clips
    .filter((clip) => clip.type === 'video')
    .filter((clip) => clip.startTime < windowEnd && clip.startTime + clip.duration > windowStart)
    .map((clip) => {
      const isActive = time >= clip.startTime && time < clip.startTime + clip.duration
      const isFuture = clip.startTime >= time
      const distance = isActive
        ? 0
        : isFuture
          ? clip.startTime - time
          : time - (clip.startTime + clip.duration)
      return { clip, sortBucket: isActive ? 0 : isFuture ? 1 : 2, distance }
    })
    .sort((a, b) => {
      if (a.sortBucket !== b.sortBucket) return a.sortBucket - b.sortBucket
      if (a.distance !== b.distance) return a.distance - b.distance
      return a.clip.startTime - b.clip.startTime
    })

  const selected = new Set<string>()
  for (const { clip } of ranked) {
    const src = resolveClipSrc(clip)
    if (!src) continue
    selected.add(src)
    if (selected.size >= policy.maxVideoSources) break
  }

  return selected
}

export function computeBoundaryGain(clip: TimelineClip, time: number, fadeDurationSeconds: number): number {
  const fade = Math.max(0.001, fadeDurationSeconds)
  const clipStart = clip.startTime
  const clipEnd = clip.startTime + clip.duration
  const fadeIn = Math.max(0, Math.min(1, (time - clipStart) / fade))
  const fadeOut = Math.max(0, Math.min(1, (clipEnd - time) / fade))
  return Number(Math.min(1, fadeIn, fadeOut).toFixed(3))
}
