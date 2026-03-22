import { describe, expect, it, vi } from 'vitest'

import { PreviewAssetCache } from '../previewAssetCache'

describe('PreviewAssetCache', () => {
  it('returns the original url until a preview has been generated', () => {
    const cache = new PreviewAssetCache({
      ensureAudioPreview: async (sourceUrl) => ({ url: `${sourceUrl}?preview=1`, path: '/tmp/preview.m4a', cacheHit: false }),
    })

    expect(cache.getPreferredAudioUrl('file:///tmp/original.wav', true)).toBe('file:///tmp/original.wav')
  })

  it('deduplicates concurrent preview warmup requests and serves the cached preview afterwards', async () => {
    const ensureAudioPreview = vi.fn(async (sourceUrl: string) => ({
      url: `${sourceUrl}?preview=1`,
      path: '/tmp/preview.m4a',
      cacheHit: false,
    }))

    const cache = new PreviewAssetCache({ ensureAudioPreview })

    const first = cache.warmAudioPreview('file:///tmp/original.wav', true)
    const second = cache.warmAudioPreview('file:///tmp/original.wav', true)

    await Promise.all([first, second])

    expect(ensureAudioPreview).toHaveBeenCalledTimes(1)
    expect(cache.getPreferredAudioUrl('file:///tmp/original.wav', true)).toBe('file:///tmp/original.wav?preview=1')
  })

  it('remembers failed preview generations so playback does not retry every frame', async () => {
    const ensureAudioPreview = vi.fn(async () => {
      throw new Error('ffmpeg failed')
    })

    const cache = new PreviewAssetCache({ ensureAudioPreview })

    await cache.warmAudioPreview('file:///tmp/broken.wav', true)
    await cache.warmAudioPreview('file:///tmp/broken.wav', true)

    expect(ensureAudioPreview).toHaveBeenCalledTimes(1)
    expect(cache.getPreferredAudioUrl('file:///tmp/broken.wav', true)).toBe('file:///tmp/broken.wav')
  })
})
