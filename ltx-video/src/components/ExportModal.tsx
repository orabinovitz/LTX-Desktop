import { useState, useRef, useCallback, useEffect } from 'react'
import { X, Download, FolderOpen, Film, Package, Loader2, Check, AlertCircle } from 'lucide-react'
import { Button } from './ui/button'
import type { TimelineClip, Track, Timeline } from '../types/project'

interface ExportModalProps {
  open: boolean
  onClose: () => void
  clips: TimelineClip[]
  tracks: Track[]
  timeline: Timeline | null
  projectName: string
}

type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

// Generate FCPXML for Premiere / DaVinci
function generateFCPXML(
  clips: TimelineClip[],
  tracks: Track[],
  projectName: string,
  timelineName: string,
  fps: number = 24
): string {
  const frameDuration = `${Math.round(100 * fps)}/${100 * fps}s`
  const totalDuration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0)
  const totalFrames = Math.ceil(totalDuration * fps)

  // Build asset-list entries
  const assetEntries: string[] = []
  const seenAssets = new Set<string>()
  for (const clip of clips) {
    const assetId = clip.assetId || clip.id
    if (seenAssets.has(assetId)) continue
    seenAssets.add(assetId)

    const src = clip.asset?.url || clip.importedUrl || ''
    const dur = clip.asset?.duration || clip.duration
    const durFrames = Math.ceil(dur * fps)
    const format = clip.type === 'audio' ? 'audio' : 'video'

    assetEntries.push(
      `        <asset id="${escapeXml(assetId)}" name="${escapeXml(clip.asset?.prompt?.slice(0, 60) || clip.importedName || 'Clip')}" src="${escapeXml(src)}" start="0s" duration="${durFrames}/${fps}s" hasVideo="${format === 'video' ? '1' : '0'}" hasAudio="1" format="r1" />`
    )
  }

  // Group clips by track
  const trackGroups: Map<number, TimelineClip[]> = new Map()
  for (const clip of clips) {
    if (!trackGroups.has(clip.trackIndex)) trackGroups.set(clip.trackIndex, [])
    trackGroups.get(clip.trackIndex)!.push(clip)
  }

  // Build spine (primary storyline) and connected clips
  const laneXml: string[] = []
  const sortedTrackIndices = [...trackGroups.keys()].sort((a, b) => a - b)
  
  for (const trackIdx of sortedTrackIndices) {
    const trackClips = trackGroups.get(trackIdx)!.sort((a, b) => a.startTime - b.startTime)
    const clipElements: string[] = []
    
    for (const clip of trackClips) {
      const assetId = clip.assetId || clip.id
      const startFrame = Math.round(clip.startTime * fps)
      const durFrames = Math.round(clip.duration * fps)
      const trimStartFrame = Math.round(clip.trimStart * fps)
      const name = clip.asset?.prompt?.slice(0, 60) || clip.importedName || 'Clip'

      let clipXml = `            <asset-clip ref="${escapeXml(assetId)}" name="${escapeXml(name)}" offset="${startFrame}/${fps}s" duration="${durFrames}/${fps}s" start="${trimStartFrame}/${fps}s"`
      
      if (clip.speed !== 1) {
        clipXml += ` tcFormat="NDF"`
      }
      clipXml += ` />`
      clipElements.push(clipXml)
    }

    const trackName = tracks[trackIdx]?.name || `Track ${trackIdx + 1}`
    laneXml.push(
      `          <!-- ${escapeXml(trackName)} -->\n` +
      clipElements.join('\n')
    )
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${fps === 24 ? '1080p2398' : '1080p' + fps}" frameDuration="${frameDuration}" width="1920" height="1080" />
${assetEntries.join('\n')}
  </resources>
  <library>
    <event name="${escapeXml(projectName)}">
      <project name="${escapeXml(timelineName)}">
        <sequence format="r1" duration="${totalFrames}/${fps}s" tcStart="0s" tcFormat="NDF">
          <spine>
${laneXml.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function ExportModal({ open, onClose, clips, tracks, timeline, projectName }: ExportModalProps) {
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle')
  const [exportType, setExportType] = useState<'package' | 'video' | null>(null)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef(false)

  useEffect(() => {
    if (open) {
      setExportStatus('idle')
      setExportType(null)
      setExportProgress(0)
      setExportError(null)
      setExportPath(null)
      abortRef.current = false
    }
  }, [open])

  const handleExportPackage = useCallback(async () => {
    if (!timeline) return
    setExportType('package')
    setExportStatus('exporting')
    setExportProgress(0)
    setExportError(null)

    try {
      const filePath = await window.electronAPI?.showSaveDialog({
        title: 'Export FCPXML Package',
        defaultPath: `${projectName}_${timeline.name}.fcpxml`,
        filters: [
          { name: 'Final Cut Pro XML', extensions: ['fcpxml'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })

      if (!filePath) {
        setExportStatus('idle')
        return
      }

      setExportProgress(50)

      const xml = generateFCPXML(clips, tracks, projectName, timeline.name)
      
      const result = await window.electronAPI?.saveFile(filePath, xml)
      if (result?.success) {
        setExportProgress(100)
        setExportPath(filePath)
        setExportStatus('done')
      } else {
        throw new Error(result?.error || 'Failed to save file')
      }
    } catch (err) {
      setExportError(String(err))
      setExportStatus('error')
    }
  }, [clips, tracks, timeline, projectName])

  const handleExportVideo = useCallback(async () => {
    if (!timeline || clips.length === 0) return
    setExportType('video')
    setExportStatus('exporting')
    setExportProgress(0)
    setExportError(null)
    abortRef.current = false

    try {
      const filePath = await window.electronAPI?.showSaveDialog({
        title: 'Export MP4 Video',
        defaultPath: `${projectName}_${timeline.name}.webm`,
        filters: [
          { name: 'WebM Video', extensions: ['webm'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })

      if (!filePath) {
        setExportStatus('idle')
        return
      }

      // Render video using canvas + MediaRecorder
      const totalDuration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0)
      const fps = 24
      const width = 1920
      const height = 1080

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!

      // Preload all media
      const mediaElements: Map<string, HTMLVideoElement | HTMLImageElement> = new Map()
      
      for (const clip of clips) {
        const url = clip.asset?.url || clip.importedUrl
        if (!url || mediaElements.has(url)) continue

        if (clip.type === 'video') {
          const video = document.createElement('video')
          video.src = url
          video.crossOrigin = 'anonymous'
          video.muted = true
          video.preload = 'auto'
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve()
            video.onerror = () => reject(new Error(`Failed to load video: ${url}`))
            video.load()
          })
          mediaElements.set(url, video)
        } else if (clip.type === 'image') {
          const img = document.createElement('img') as HTMLImageElement
          img.crossOrigin = 'anonymous'
          img.src = url
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
          })
          mediaElements.set(url, img)
        }
      }

      // Set up MediaRecorder
      const stream = canvas.captureStream(fps)
      const chunks: Blob[] = []
      const recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 8_000_000,
      })
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      const recordingDone = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })

      recorder.start()

      // Render frame by frame
      const totalFrames = Math.ceil(totalDuration * fps)
      
      for (let frame = 0; frame < totalFrames; frame++) {
        if (abortRef.current) {
          recorder.stop()
          setExportStatus('idle')
          return
        }

        const time = frame / fps

        // Clear canvas
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)

        // Find active clip at this time (same priority as the editor: lower track wins, later clip wins on same track)
        const clipsAtTime = clips
          .map((clip, idx) => ({ clip, idx }))
          .filter(({ clip }) => time >= clip.startTime && time < clip.startTime + clip.duration)
          .sort((a, b) => {
            if (a.clip.trackIndex !== b.clip.trackIndex) return a.clip.trackIndex - b.clip.trackIndex
            return b.idx - a.idx
          })

        // Helper: draw a single clip to canvas with effects at a given opacity
        const drawClipToCanvas = async (clip: TimelineClip, timeInClip: number, overrideOpacity?: number) => {
          const url = clip.asset?.url || (clip as any).importedUrl
          if (!url) return
          const media = mediaElements.get(url)
          if (!media) return

          ctx.save()

          // Apply color correction as canvas filters
          const cc = clip.colorCorrection
          if (cc) {
            const filters: string[] = []
            if (cc.brightness !== 0) filters.push(`brightness(${1 + cc.brightness / 100})`)
            if (cc.contrast !== 0) filters.push(`contrast(${1 + cc.contrast / 100})`)
            if (cc.saturation !== 0) filters.push(`saturate(${1 + cc.saturation / 100})`)
            if (cc.exposure !== 0) filters.push(`brightness(${1 + cc.exposure / 200})`)
            if (cc.temperature !== 0) {
              if (cc.temperature > 0) {
                filters.push(`sepia(${cc.temperature / 200})`)
              } else {
                filters.push(`hue-rotate(${Math.abs(cc.temperature) * 0.4}deg)`)
              }
            }
            if (filters.length > 0) ctx.filter = filters.join(' ')
          }

          // Apply flip
          if (clip.flipH || clip.flipV) {
            ctx.translate(clip.flipH ? width : 0, clip.flipV ? height : 0)
            ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1)
          }

          // Apply opacity
          if (overrideOpacity !== undefined) {
            ctx.globalAlpha = overrideOpacity
          } else {
            // Apply base + transition opacity (fade-to-black/white only; dissolve handled separately)
            let opacity = (clip.opacity ?? 100) / 100
            const tIn = clip.transitionIn
            const tOut = clip.transitionOut
            if (tIn && tIn.duration > 0 && timeInClip < tIn.duration) {
              if (tIn.type === 'fade-to-black' || tIn.type === 'fade-to-white') {
                opacity = Math.min(opacity, timeInClip / tIn.duration)
              }
            }
            if (tOut && tOut.duration > 0) {
              const timeFromEnd = clip.duration - timeInClip
              if (timeFromEnd < tOut.duration) {
                if (tOut.type === 'fade-to-black' || tOut.type === 'fade-to-white') {
                  opacity = Math.min(opacity, timeFromEnd / tOut.duration)
                }
              }
            }
            ctx.globalAlpha = opacity
          }

          if (media instanceof HTMLVideoElement) {
            const mediaTime = clip.reversed
              ? clip.trimStart + (clip.duration - timeInClip) * clip.speed
              : clip.trimStart + timeInClip * clip.speed
            media.currentTime = Math.max(0, Math.min(media.duration, mediaTime))
            
            await new Promise<void>((resolve) => {
              if (media.readyState >= 2) {
                resolve()
              } else {
                media.onseeked = () => resolve()
                setTimeout(resolve, 50)
              }
            })

            const scale = Math.min(width / media.videoWidth, height / media.videoHeight)
            const dw = media.videoWidth * scale
            const dh = media.videoHeight * scale
            const dx = (width - dw) / 2
            const dy = (height - dh) / 2
            ctx.drawImage(media, dx, dy, dw, dh)
          } else if (media instanceof HTMLImageElement) {
            const scale = Math.min(width / media.naturalWidth, height / media.naturalHeight)
            const dw = media.naturalWidth * scale
            const dh = media.naturalHeight * scale
            const dx = (width - dw) / 2
            const dy = (height - dh) / 2
            ctx.drawImage(media, dx, dy, dw, dh)
          }

          ctx.restore()
        }

        if (clipsAtTime.length > 0) {
          const { clip } = clipsAtTime[0]
          const timeInClip = time - clip.startTime

          // Check for cross-dissolve: detect if we're in a dissolve overlap region
          let isCrossDissolve = false
          
          // Check dissolve-in on this clip
          const tIn = clip.transitionIn
          if (tIn && tIn.type === 'dissolve' && tIn.duration > 0 && timeInClip < tIn.duration) {
            const clipEnd = clip.startTime
            const outgoing = clips.find(c =>
              c.id !== clip.id &&
              c.trackIndex === clip.trackIndex &&
              c.transitionOut?.type === 'dissolve' &&
              Math.abs((c.startTime + c.duration) - clipEnd) < 0.01
            )
            if (outgoing) {
              const progress = timeInClip / tIn.duration
              const outOffset = time - outgoing.startTime
              const outOpacity = (1 - progress) * ((outgoing.opacity ?? 100) / 100)
              const inOpacity = progress * ((clip.opacity ?? 100) / 100)
              // Draw outgoing first (bottom), then incoming (top)
              await drawClipToCanvas(outgoing, outOffset, outOpacity)
              await drawClipToCanvas(clip, timeInClip, inOpacity)
              isCrossDissolve = true
            }
          }

          // Check dissolve-out on this clip
          if (!isCrossDissolve) {
            const tOut = clip.transitionOut
            const timeFromEnd = clip.duration - timeInClip
            if (tOut && tOut.type === 'dissolve' && tOut.duration > 0 && timeFromEnd < tOut.duration) {
              const nextClipStart = clip.startTime + clip.duration
              const incoming = clips.find(c =>
                c.id !== clip.id &&
                c.trackIndex === clip.trackIndex &&
                c.transitionIn?.type === 'dissolve' &&
                Math.abs(c.startTime - nextClipStart) < 0.01
              )
              if (incoming) {
                const progress = 1 - (timeFromEnd / tOut.duration)
                const inOffset = time - incoming.startTime
                const outOpacity = (1 - progress) * ((clip.opacity ?? 100) / 100)
                const inOpacity = progress * ((incoming.opacity ?? 100) / 100)
                await drawClipToCanvas(clip, timeInClip, outOpacity)
                await drawClipToCanvas(incoming, inOffset, inOpacity)
                isCrossDissolve = true
              }
            }
          }

          // Normal rendering (no cross-dissolve)
          if (!isCrossDissolve) {
            await drawClipToCanvas(clip, timeInClip)
          }
        }

        setExportProgress(Math.round((frame / totalFrames) * 95))

        // Yield to keep UI responsive
        if (frame % 4 === 0) {
          await new Promise((r) => setTimeout(r, 0))
        }
      }

      recorder.stop()
      await recordingDone

      // Save the blob
      const blob = new Blob(chunks, { type: 'video/webm' })
      const arrayBuffer = await blob.arrayBuffer()
      
      const result = await window.electronAPI?.saveBinaryFile(filePath, arrayBuffer)
      if (result?.success) {
        setExportProgress(100)
        setExportPath(filePath)
        setExportStatus('done')
      } else {
        throw new Error(result?.error || 'Failed to save video')
      }
    } catch (err) {
      setExportError(String(err))
      setExportStatus('error')
    }
  }, [clips, tracks, timeline, projectName])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="bg-zinc-900 rounded-2xl border border-zinc-700/50 shadow-2xl w-full max-w-lg p-8 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="text-xl font-bold text-white mb-6">Export Video</h2>

        {/* Exporting state */}
        {exportStatus === 'exporting' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 text-violet-400 animate-spin" />
              <span className="text-sm text-zinc-300">
                {exportType === 'package' ? 'Generating FCPXML...' : 'Rendering video...'}
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
              <div 
                className="h-full bg-violet-500 rounded-full transition-all duration-300"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500">{exportProgress}% complete</p>
            {exportType === 'video' && (
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-400"
                onClick={() => { abortRef.current = true }}
              >
                Cancel
              </Button>
            )}
          </div>
        )}

        {/* Done state */}
        {exportStatus === 'done' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="h-5 w-5 text-green-400" />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Export complete</p>
                <p className="text-xs text-zinc-500 truncate max-w-[300px]">{exportPath}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-300"
                onClick={() => {
                  if (exportPath) {
                    const dir = exportPath.replace(/[/\\][^/\\]*$/, '')
                    window.electronAPI?.openFolder(dir)
                  }
                }}
              >
                <FolderOpen className="h-4 w-4 mr-2" />
                Show in Folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-300"
                onClick={() => {
                  setExportStatus('idle')
                  setExportType(null)
                }}
              >
                Export Another
              </Button>
            </div>
          </div>
        )}

        {/* Error state */}
        {exportStatus === 'error' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertCircle className="h-5 w-5 text-red-400" />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Export failed</p>
                <p className="text-xs text-red-400 max-w-[300px] truncate">{exportError}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-zinc-700 text-zinc-300"
              onClick={() => {
                setExportStatus('idle')
                setExportType(null)
              }}
            >
              Try Again
            </Button>
          </div>
        )}

        {/* Idle state - options */}
        {exportStatus === 'idle' && (
          <div className="space-y-3">
            {/* Package export */}
            <button
              onClick={handleExportPackage}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-zinc-700/50 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600 transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-zinc-700/50 flex items-center justify-center flex-shrink-0">
                <Package className="h-6 w-6 text-zinc-300" />
              </div>
              <div className="flex-1 text-left">
                <p className="text-sm font-semibold text-white">Package</p>
                <p className="text-xs text-zinc-400">FCPXML for Premiere Pro &amp; DaVinci Resolve</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* DaVinci icon placeholder */}
                <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center" title="DaVinci Resolve">
                  <span className="text-[10px] font-bold text-orange-400">DR</span>
                </div>
                {/* Premiere icon placeholder */}
                <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center" title="Premiere Pro">
                  <span className="text-[10px] font-bold text-violet-400">Pr</span>
                </div>
                <Download className="h-5 w-5 text-zinc-500 group-hover:text-zinc-300 transition-colors ml-1" />
              </div>
            </button>

            {/* Video export */}
            <button
              onClick={handleExportVideo}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-zinc-700/50 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600 transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-zinc-700/50 flex items-center justify-center flex-shrink-0">
                <Film className="h-6 w-6 text-zinc-300" />
              </div>
              <div className="flex-1 text-left">
                <p className="text-sm font-semibold text-white">Video</p>
                <p className="text-xs text-zinc-400">WebM video of the timeline</p>
              </div>
              <Download className="h-5 w-5 text-zinc-500 group-hover:text-zinc-300 transition-colors flex-shrink-0" />
            </button>

            {clips.length === 0 && (
              <p className="text-xs text-zinc-500 text-center mt-2">Add clips to the timeline to export.</p>
            )}
          </div>
        )}

        {/* Hidden canvas for rendering */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  )
}
