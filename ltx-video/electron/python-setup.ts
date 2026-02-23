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
      // Dev mode: use local python-embed directory
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
    // macOS: always bundled
    return { ready: true }
  }

  if (isDev) {
    // Dev mode: check for local python-embed or venv
    return { ready: true }
  }

  const bundledHash = readHash(getBundledHashPath())
  const installedHash = readHash(getInstalledHashPath())

  if (!bundledHash) {
    // No hash file shipped — fall back to checking python.exe exists
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

function getDownloadUrl(): string {
  // Allow override via env var (full URL to the archive)
  if (process.env.LTX_PYTHON_URL) {
    return process.env.LTX_PYTHON_URL
  }

  const version = app.getVersion()
  const baseUrl = 'https://github.com/Lightricks/ltx-desktop/releases/download'
  return `${baseUrl}/v${version}/python-embed-win32.tar.gz`
}

/**
 * Download python-embed archive and extract it to userData/python/.
 * Only called on Windows in production.
 */
export async function downloadPythonEmbed(
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const destDir = path.join(app.getPath('userData'), 'python')
  const tempDir = path.join(app.getPath('userData'), 'python-tmp')
  const archivePath = path.join(app.getPath('userData'), 'python-embed-win32.tar.gz')

  // Clean up any previous partial attempts
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }

  fs.mkdirSync(tempDir, { recursive: true })

  try {
    // 1. Download the archive
    const url = getDownloadUrl()
    console.log(`[python-setup] Downloading from: ${url}`)
    await downloadFile(url, archivePath, onProgress)

    // 2. Extract
    onProgress({ status: 'extracting', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    console.log(`[python-setup] Extracting to: ${tempDir}`)
    await extractTarGz(archivePath, tempDir)

    // 3. Move extracted directory into place
    //    The archive contains a top-level `python-embed/` directory.
    //    We want its contents at `userData/python/`.
    const extractedInner = path.join(tempDir, 'python-embed')
    const source = fs.existsSync(extractedInner) ? extractedInner : tempDir

    // Remove old install if present
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.renameSync(source, destDir)

    // 4. Copy the bundled deps hash so subsequent launches skip download
    const bundledHash = getBundledHashPath()
    if (fs.existsSync(bundledHash)) {
      fs.copyFileSync(bundledHash, path.join(destDir, 'deps-hash.txt'))
    }

    onProgress({ status: 'complete', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    console.log('[python-setup] Python environment ready')
  } catch (err) {
    // Clean up partial state
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  } finally {
    // Always remove the archive
    try { fs.unlinkSync(archivePath) } catch { /* ignore */ }
    // Clean up tempDir if it still exists (in case source !== tempDir)
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Download a file with progress, following redirects. */
function downloadFile(
  url: string,
  dest: string,
  onProgress: (progress: PythonSetupProgress) => void,
  redirectCount = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'))
      return
    }

    const client = url.startsWith('https') ? https : http
    const req = client.get(url, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume() // consume response to free memory
        downloadFile(res.headers.location, dest, onProgress, redirectCount + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
      let downloadedBytes = 0
      let lastTime = Date.now()
      let lastBytes = 0

      const file = fs.createWriteStream(dest)
      res.pipe(file)

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000

        let speed = 0
        if (elapsed >= 0.5) {
          speed = (downloadedBytes - lastBytes) / elapsed
          lastTime = now
          lastBytes = downloadedBytes
        }

        const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0

        onProgress({
          status: 'downloading',
          percent,
          downloadedBytes,
          totalBytes,
          speed,
        })
      })

      file.on('finish', () => {
        file.close(() => resolve())
      })

      file.on('error', (err) => {
        fs.unlink(dest, () => {})
        reject(err)
      })
    })

    req.on('error', (err) => {
      reject(err)
    })
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
