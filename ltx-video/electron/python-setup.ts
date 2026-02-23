import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import { isDev } from './config'

export interface PythonSetupProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error'
  percent: number
  downloadedBytes: number
  totalBytes: number
  speed: number
}

interface ArchiveManifest {
  parts: { name: string; size: number }[]
  totalSize: number
}

function getBundledHashPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'python-deps-hash.txt')
  }
  return path.join(process.resourcesPath, 'python-deps-hash.txt')
}

function getInstalledHashPath(): string {
  return path.join(app.getPath('userData'), 'python', 'deps-hash.txt')
}

/** Directory where python-embed lives at runtime. */
export function getPythonDir(): string {
  if (process.platform === 'win32') {
    if (isDev) {
      return path.join(process.cwd(), 'python-embed')
    }
    return path.join(app.getPath('userData'), 'python')
  }
  // macOS: bundled in resources
  return path.join(process.resourcesPath, 'python')
}

/** Check whether the Python environment is ready to use. */
export function isPythonReady(): { ready: boolean } {
  if (process.platform !== 'win32') {
    return { ready: true }
  }

  if (isDev) {
    return { ready: true }
  }

  const bundledHash = readHash(getBundledHashPath())
  const installedHash = readHash(getInstalledHashPath())

  if (!bundledHash) {
    const pythonExe = path.join(getPythonDir(), 'python.exe')
    return { ready: fs.existsSync(pythonExe) }
  }

  return { ready: bundledHash === installedHash }
}

function readHash(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * Get the base URL/path for python-embed assets.
 * LTX_PYTHON_URL can be:
 *   - A path to a .tar.gz file (single-file local testing)
 *   - A path to a directory containing manifest + parts
 *   - A URL base (remote, default: GitHub Releases)
 */
function getArchiveBase(): string {
  if (process.env.LTX_PYTHON_URL) {
    return process.env.LTX_PYTHON_URL
  }
  const version = app.getVersion()
  return `https://github.com/Lightricks/ltx-desktop/releases/download/v${version}`
}

function isLocalPath(source: string): boolean {
  return !source.startsWith('http://') && !source.startsWith('https://')
}

/**
 * Download (or copy) python-embed archive and extract to userData/python/.
 * Supports multi-part archives (split for GitHub's 2GB asset limit).
 */
export async function downloadPythonEmbed(
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const destDir = path.join(app.getPath('userData'), 'python')
  const tempDir = path.join(app.getPath('userData'), 'python-tmp')
  const archivePath = path.join(app.getPath('userData'), 'python-embed-win32.tar.gz')

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }

  fs.mkdirSync(tempDir, { recursive: true })

  const cleanupFiles: string[] = []

  try {
    const base = getArchiveBase()
    console.log(`[python-setup] Archive base: ${base}`)

    if (isLocalPath(base) && base.endsWith('.tar.gz')) {
      // Single local file — copy directly
      await copyFileWithProgress(base, archivePath, 0, fs.statSync(base).size, onProgress)
    } else if (isLocalPath(base)) {
      // Local directory with manifest + parts
      await acquirePartsLocal(base, archivePath, cleanupFiles, onProgress)
    } else {
      // Remote multi-part download
      await acquirePartsRemote(base, archivePath, cleanupFiles, onProgress)
    }

    // Extract
    onProgress({ status: 'extracting', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    console.log(`[python-setup] Extracting to: ${tempDir}`)
    await extractTarGz(archivePath, tempDir)

    // Move into place (archive has top-level `python-embed/` directory)
    const extractedInner = path.join(tempDir, 'python-embed')
    const extractedSource = fs.existsSync(extractedInner) ? extractedInner : tempDir

    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.renameSync(extractedSource, destDir)

    // Write deps hash so subsequent launches skip download
    const bundledHash = getBundledHashPath()
    if (fs.existsSync(bundledHash)) {
      fs.copyFileSync(bundledHash, path.join(destDir, 'deps-hash.txt'))
    }

    onProgress({ status: 'complete', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    console.log('[python-setup] Python environment ready')
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  } finally {
    try { fs.unlinkSync(archivePath) } catch { /* ignore */ }
    for (const f of cleanupFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── Multi-part: local directory ──────────────────────────────────────

async function acquirePartsLocal(
  dirPath: string,
  archivePath: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const manifestPath = path.join(dirPath, 'python-embed-win32.manifest.json')
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

  const partPaths: string[] = []
  let bytesSoFar = 0

  for (const part of manifest.parts) {
    const src = path.join(dirPath, part.name)
    const dest = path.join(app.getPath('userData'), part.name)
    partPaths.push(dest)
    cleanupFiles.push(dest)

    await copyFileWithProgress(src, dest, bytesSoFar, manifest.totalSize, onProgress)
    bytesSoFar += part.size
  }

  await concatenateParts(partPaths, archivePath)
}

// ── Multi-part: remote download ──────────────────────────────────────

async function acquirePartsRemote(
  baseUrl: string,
  archivePath: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  // Fetch manifest
  const manifestUrl = `${baseUrl}/python-embed-win32.manifest.json`
  const manifestDest = path.join(app.getPath('userData'), 'python-embed-win32.manifest.json')
  cleanupFiles.push(manifestDest)
  await downloadFileRaw(manifestUrl, manifestDest)
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestDest, 'utf-8'))

  const partPaths: string[] = []
  let bytesSoFar = 0
  let lastTime = Date.now()
  let lastReportedBytes = 0

  for (const part of manifest.parts) {
    const partUrl = `${baseUrl}/${part.name}`
    const partDest = path.join(app.getPath('userData'), part.name)
    partPaths.push(partDest)
    cleanupFiles.push(partDest)

    await downloadFileWithGlobalProgress(
      partUrl,
      partDest,
      bytesSoFar,
      manifest.totalSize,
      (globalDownloaded, totalBytes) => {
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000

        let speed = 0
        if (elapsed >= 0.5) {
          speed = (globalDownloaded - lastReportedBytes) / elapsed
          lastTime = now
          lastReportedBytes = globalDownloaded
        }

        onProgress({
          status: 'downloading',
          percent: Math.round((globalDownloaded / totalBytes) * 100),
          downloadedBytes: globalDownloaded,
          totalBytes,
          speed,
        })
      }
    )

    bytesSoFar += part.size
  }

  await concatenateParts(partPaths, archivePath)
}

// ── File operations ──────────────────────────────────────────────────

function concatenateParts(parts: string[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(dest)
    let i = 0

    function writeNext() {
      if (i >= parts.length) {
        writeStream.end(() => resolve())
        return
      }

      const readStream = fs.createReadStream(parts[i])
      i++

      readStream.on('error', (err) => {
        writeStream.destroy()
        reject(err)
      })

      readStream.on('end', writeNext)
      readStream.pipe(writeStream, { end: false })
    }

    writeStream.on('error', reject)
    writeNext()
  })
}

/** Copy a local file with progress relative to a global total. */
function copyFileWithProgress(
  source: string,
  dest: string,
  globalOffset: number,
  globalTotal: number,
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let copiedBytes = 0

    const readStream = fs.createReadStream(source)
    const writeStream = fs.createWriteStream(dest)

    readStream.on('data', (chunk: Buffer) => {
      copiedBytes += chunk.length
      const totalDone = globalOffset + copiedBytes
      onProgress({
        status: 'downloading',
        percent: Math.round((totalDone / globalTotal) * 100),
        downloadedBytes: totalDone,
        totalBytes: globalTotal,
        speed: 0,
      })
    })

    readStream.on('error', reject)
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)

    readStream.pipe(writeStream)
  })
}

/** Download a file without progress (used for manifest). */
function downloadFileRaw(url: string, dest: string, redirectCount = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'))
      return
    }

    const client = url.startsWith('https') ? https : http
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFileRaw(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      const file = fs.createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    })

    req.on('error', reject)
  })
}

/** Download a file, reporting progress as (globalDownloaded, globalTotal). */
function downloadFileWithGlobalProgress(
  url: string,
  dest: string,
  globalOffset: number,
  globalTotal: number,
  onProgress: (globalDownloaded: number, globalTotal: number) => void,
  redirectCount = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'))
      return
    }

    const client = url.startsWith('https') ? https : http
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFileWithGlobalProgress(res.headers.location, dest, globalOffset, globalTotal, onProgress, redirectCount + 1)
          .then(resolve).catch(reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      let downloadedBytes = 0
      const file = fs.createWriteStream(dest)
      res.pipe(file)

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        onProgress(globalOffset + downloadedBytes, globalTotal)
      })

      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    })

    req.on('error', reject)
  })
}

/** Extract a .tar.gz file using the system tar command (ships on Windows 10+). */
function extractTarGz(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', destDir], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`tar extraction failed: ${stderr || err.message}`))
        return
      }
      resolve()
    })
  })
}
