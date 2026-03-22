interface AudioPreviewResult {
  url: string
  path: string
  cacheHit: boolean
}

interface PreviewAssetCacheProvider {
  ensureAudioPreview: (sourceUrl: string) => Promise<AudioPreviewResult>
}

export class PreviewAssetCache {
  private readonly provider: PreviewAssetCacheProvider | null

  private readonly audioPreviewUrls = new Map<string, string>()

  private readonly pendingAudioPreviewUrls = new Map<string, Promise<string>>()

  private readonly failedAudioPreviewUrls = new Set<string>()

  constructor(provider: PreviewAssetCacheProvider | null = null) {
    this.provider = provider
  }

  getPreferredAudioUrl(sourceUrl: string, preferPreview: boolean): string {
    if (!preferPreview) return sourceUrl
    return this.audioPreviewUrls.get(sourceUrl) ?? sourceUrl
  }

  warmAudioPreview(sourceUrl: string, preferPreview: boolean): Promise<string> {
    if (!preferPreview || !this.provider) {
      return Promise.resolve(sourceUrl)
    }

    const cachedUrl = this.audioPreviewUrls.get(sourceUrl)
    if (cachedUrl) {
      return Promise.resolve(cachedUrl)
    }

    if (this.failedAudioPreviewUrls.has(sourceUrl)) {
      return Promise.resolve(sourceUrl)
    }

    const pendingUrl = this.pendingAudioPreviewUrls.get(sourceUrl)
    if (pendingUrl) {
      return pendingUrl
    }

    const previewPromise = this.provider.ensureAudioPreview(sourceUrl)
      .then((result) => {
        this.audioPreviewUrls.set(sourceUrl, result.url)
        this.pendingAudioPreviewUrls.delete(sourceUrl)
        return result.url
      })
      .catch(() => {
        this.pendingAudioPreviewUrls.delete(sourceUrl)
        this.failedAudioPreviewUrls.add(sourceUrl)
        return sourceUrl
      })

    this.pendingAudioPreviewUrls.set(sourceUrl, previewPromise)
    return previewPromise
  }
}
