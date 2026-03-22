import { app, ipcMain } from 'electron'
import { spawnSync } from 'child_process'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fileHasAudio, findFfmpegPath, urlToFilePath } from '../export/ffmpeg-utils'
import { logger } from '../logger'

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

function getAudioPreviewCachePath(sourcePath: string): string {
  const stats = fs.statSync(sourcePath)
  const key = crypto
    .createHash('sha1')
    .update(`${sourcePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex')
  const cacheDir = path.join(app.getPath('userData'), 'preview-audio-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  return path.join(cacheDir, `${key}.m4a`)
}

export function registerVideoProcessingHandlers(): void {
  ipcMain.handle(
    'extract-video-frame',
    async (
      _event,
      videoUrl: string,
      seekTime: number,
      width?: number,
      quality?: number,
    ): Promise<{ path: string; url: string }> => {
      const ffmpeg = findFfmpegPath()
      if (!ffmpeg) {
        throw new Error('ffmpeg not found')
      }

      const inputPath = urlToFilePath(videoUrl)
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Video file not found: ${inputPath}`)
      }

      const outputName = `ltx_frame_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`
      const outputPath = path.join(os.tmpdir(), outputName)

      const args: string[] = [
        '-ss', String(Math.max(0, seekTime)),
        '-i', inputPath,
        ...(width ? ['-vf', `scale=${width}:-2`] : []),
        '-frames:v', '1',
        '-q:v', String(quality ?? 2),
        '-y',
        outputPath,
      ]

      logger.info(`[extract-frame] ${args.join(' ').slice(0, 300)}`)

      const result = spawnSync(ffmpeg, args, { timeout: 10000 })

      if (result.status !== 0) {
        const stderr = result.stderr?.toString().slice(-300) || ''
        throw new Error(`ffmpeg frame extraction failed (code ${result.status}): ${stderr}`)
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('ffmpeg produced no output file')
      }

      const fileUrl = `file://${outputPath}`
      return { path: outputPath, url: fileUrl }
    },
  )

  ipcMain.handle(
    'ensure-audio-preview',
    async (
      _event,
      sourceUrl: string,
    ): Promise<{ path: string; url: string; cacheHit: boolean }> => {
      const ffmpeg = findFfmpegPath()
      if (!ffmpeg) {
        throw new Error('ffmpeg not found')
      }

      const sourcePath = urlToFilePath(sourceUrl)
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Audio preview source not found: ${sourcePath}`)
      }

      const outputPath = getAudioPreviewCachePath(sourcePath)
      const cacheHit = fs.existsSync(outputPath)
      if (cacheHit) {
        return { path: outputPath, url: toFileUrl(outputPath), cacheHit: true }
      }

      if (!fileHasAudio(ffmpeg, sourcePath) && !/\.(mp3|wav|ogg|aac|flac|m4a)$/i.test(sourcePath)) {
        throw new Error(`Source has no audio stream: ${sourcePath}`)
      }

      const args: string[] = [
        '-i', sourcePath,
        '-map', '0:a:0?',
        '-vn',
        '-ac', '1',
        '-ar', '24000',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        '-y',
        outputPath,
      ]

      logger.info(`[audio-preview] ${args.join(' ').slice(0, 300)}`)
      const result = spawnSync(ffmpeg, args, { timeout: 30000 })
      if (result.status !== 0) {
        const stderr = result.stderr?.toString().slice(-300) || ''
        throw new Error(`ffmpeg audio preview failed (code ${result.status}): ${stderr}`)
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('ffmpeg produced no audio preview file')
      }

      return { path: outputPath, url: toFileUrl(outputPath), cacheHit: false }
    },
  )
}
