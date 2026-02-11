/**
 * Thumbnail generation and video frame extraction utilities.
 *
 * Uses an off-screen <video> + <canvas> to capture a single frame
 * and return it as a small JPEG blob URL, suitable for fast grid thumbnails.
 */

const THUMB_WIDTH = 320 // px – sufficient for 2-col grid at ~160px card width
const THUMB_QUALITY = 0.7

/** Cache: videoUrl → thumbnailBlobUrl  (avoids regenerating on re-render) */
const thumbnailCache = new Map<string, string>()

/**
 * Extract a single frame from a video URL at the given time (default 0 s)
 * and return a lightweight blob: URL pointing to a JPEG snapshot.
 *
 * The result is cached so subsequent calls with the same `videoUrl` are instant.
 */
export function generateThumbnail(
  videoUrl: string,
  seekTime = 0.1, // slight offset avoids occasional black first-frame
): Promise<string> {
  const cached = thumbnailCache.get(videoUrl)
  if (cached) return Promise.resolve(cached)

  return new Promise<string>((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true

    const cleanup = () => {
      video.removeAttribute('src')
      video.load() // release resources
    }

    const onSeeked = () => {
      try {
        const canvas = document.createElement('canvas')
        const aspect = video.videoWidth / video.videoHeight
        canvas.width = THUMB_WIDTH
        canvas.height = Math.round(THUMB_WIDTH / aspect) || THUMB_WIDTH
        const ctx = canvas.getContext('2d')
        if (!ctx) { cleanup(); reject(new Error('canvas 2d context unavailable')); return }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          (blob) => {
            cleanup()
            if (!blob) { reject(new Error('toBlob returned null')); return }
            const blobUrl = URL.createObjectURL(blob)
            thumbnailCache.set(videoUrl, blobUrl)
            resolve(blobUrl)
          },
          'image/jpeg',
          THUMB_QUALITY,
        )
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    const onError = () => {
      cleanup()
      reject(new Error(`Failed to load video for thumbnail: ${videoUrl}`))
    }

    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })

    video.addEventListener(
      'loadeddata',
      () => {
        // Seek to the requested time (clamped to duration)
        video.currentTime = Math.min(seekTime, video.duration || 0)
      },
      { once: true },
    )

    video.src = videoUrl
  })
}

/**
 * Batch-generate thumbnails for multiple video URLs.
 * Returns a map of videoUrl → blobUrl for all that succeeded.
 * Failures are silently skipped (the caller can fall back to the original URL).
 *
 * Limits concurrency to avoid overwhelming the browser's media decoder.
 */
export async function generateThumbnailsBatch(
  videoUrls: string[],
  concurrency = 3,
): Promise<Map<string, string>> {
  const results = new Map<string, string>()
  const queue = [...videoUrls]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()!
      try {
        const thumb = await generateThumbnail(url)
        results.set(url, thumb)
      } catch {
        // skip – caller will fall back to original url
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
  return results
}

/**
 * Look up a cached thumbnail. Returns undefined if not yet generated.
 */
export function getCachedThumbnail(videoUrl: string): string | undefined {
  return thumbnailCache.get(videoUrl)
}

/**
 * Warm the cache for a single URL (fire-and-forget).
 * Safe to call multiple times – subsequent calls are no-ops.
 */
export function warmThumbnail(videoUrl: string): void {
  if (thumbnailCache.has(videoUrl)) return
  generateThumbnail(videoUrl).catch(() => {})
}

/**
 * Extract a single frame from a video at a specific time and return it as a
 * base64-encoded JPEG string (without the data: prefix). Suitable for sending
 * to APIs like Gemini that accept inline image data.
 */
export function extractFrameAsBase64(
  videoUrl: string,
  seekTime: number,
  width = 512,
  quality = 0.8,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true

    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
    }

    const onSeeked = () => {
      try {
        const canvas = document.createElement('canvas')
        const aspect = video.videoWidth / video.videoHeight || 16 / 9
        canvas.width = width
        canvas.height = Math.round(width / aspect)
        const ctx = canvas.getContext('2d')
        if (!ctx) { cleanup(); reject(new Error('canvas 2d unavailable')); return }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        cleanup()
        // Strip the "data:image/jpeg;base64," prefix
        const base64 = dataUrl.split(',')[1]
        if (!base64) { reject(new Error('toDataURL returned empty')); return }
        resolve(base64)
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', () => { cleanup(); reject(new Error('video load failed')) }, { once: true })
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.max(0, Math.min(seekTime, video.duration || 0))
    }, { once: true })

    video.src = videoUrl
  })
}

/**
 * Extract a frame from an image URL and return it as base64-encoded JPEG.
 * Works for <img>-compatible URLs including file:// in Electron.
 */
export function extractImageAsBase64(
  imageUrl: string,
  width = 512,
  quality = 0.8,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const aspect = img.naturalWidth / img.naturalHeight || 16 / 9
        canvas.width = width
        canvas.height = Math.round(width / aspect)
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('canvas 2d unavailable')); return }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const base64 = dataUrl.split(',')[1]
        if (!base64) { reject(new Error('toDataURL returned empty')); return }
        resolve(base64)
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => reject(new Error('image load failed'))
    img.src = imageUrl
  })
}
