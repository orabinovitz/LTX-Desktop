import { app, BrowserWindow, ipcMain, dialog, nativeImage, session } from 'electron'
import { spawn, spawnSync, ChildProcess, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { PathValidator } from './path-validator'

// Get directory - works in both CJS and ESM contexts
const getCurrentDir = (): string => {
  // In bundled output, use app.getAppPath()
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'))
  }
  // In development, use process.cwd() which is the project root
  return process.cwd()
}

let mainWindow: BrowserWindow | null = null
let pythonProcess: ChildProcess | null = null
let pathValidator: PathValidator

const PYTHON_PORT = 8000
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Enforce Content Security Policy via response headers (tamper-proof from renderer)
function setupCSP(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
          "img-src 'self' data: blob: file:",
          "media-src 'self' blob: file:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join('; ')
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
          "img-src 'self' data: blob: file:",
          "media-src 'self' blob: file:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join('; ')

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

// Get user data path for models
function getModelsPath(): string {
  const modelsPath = path.join(app.getPath('userData'), 'models')
  if (!fs.existsSync(modelsPath)) {
    fs.mkdirSync(modelsPath, { recursive: true })
  }
  return modelsPath
}

// Get the path to the backend directory
function getBackendPath(): string {
  if (isDev) {
    return path.join(getCurrentDir(), 'backend')
  }
  return path.join(process.resourcesPath, 'backend')
}

// Get the path to Python executable
function getPythonPath(): string {
  // In production, use bundled Python first
  if (!isDev) {
    const bundledPython = process.platform === 'win32'
      ? path.join(process.resourcesPath, 'python', 'python.exe')
      : path.join(process.resourcesPath, 'python', 'bin', 'python3')
    if (fs.existsSync(bundledPython)) {
      console.log(`Using bundled Python: ${bundledPython}`)
      return bundledPython
    }
  }
  
  // Check for venv in backend directory
  const backendPath = getBackendPath()
  const isWindows = process.platform === 'win32'
  const venvPython = isWindows
    ? path.join(backendPath, '.venv', 'Scripts', 'python.exe')
    : path.join(backendPath, '.venv', 'bin', 'python')

  if (fs.existsSync(venvPython)) {
    console.log(`Using venv Python: ${venvPython}`)
    return venvPython
  }

  if (isDev) {
    // In development, try common Python paths
    const pythonPaths = isWindows
      ? [
          'python',
          'python3',
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        ]
      : [
          'python3',
          'python',
        ]

    for (const p of pythonPaths) {
      try {
        if (fs.existsSync(p)) {
          return p
        }
      } catch {
        continue
      }
    }
    return isWindows ? 'python' : 'python3'
  }
  
  // Fallback
  return 'python'
}

// Check if NVIDIA GPU is available
async function checkGPU(): Promise<{ available: boolean; name?: string; vram?: number }> {
  try {
    // Try to get GPU info from the backend API first (more reliable)
    const response = await fetch(`http://localhost:${PYTHON_PORT}/api/gpu-info`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    
    if (response.ok) {
      const data = await response.json()
      return {
        available: data.cuda_available ?? false,
        name: data.gpu_name,
        vram: data.vram_gb
      }
    }
  } catch (error) {
    console.log('Backend GPU check failed, trying direct check:', error)
  }
  
  // Fallback: try direct Python check
  try {
    const pythonPath = getPythonPath()
    const result = execSync(`"${pythonPath}" -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''); print(torch.cuda.get_device_properties(0).total_memory // (1024**3) if torch.cuda.is_available() else 0)"`, {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true
    }).trim().split('\n')
    
    return {
      available: result[0] === 'True',
      name: result[1] || undefined,
      vram: parseInt(result[2]) || undefined
    }
  } catch (error) {
    console.error('Direct GPU check also failed:', error)
    return { available: false }
  }
}

// Start the Python backend server
async function startPythonBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonPath()
    const backendPath = getBackendPath()
    const mainPy = path.join(backendPath, 'ltx2_server.py')

    console.log(`Starting Python backend: ${pythonPath} ${mainPy}`)

    pythonProcess = spawn(pythonPath, ['-u', mainPy], {
      cwd: backendPath,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        LTX_PORT: String(PYTHON_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let started = false

    const checkStarted = (output: string) => {
      // Check if server has started
      if (!started && (output.includes('Server running on') || output.includes('Uvicorn running'))) {
        started = true
        resolve()
      }
    }

    pythonProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.log(`[Python] ${output}`)
      checkStarted(output)
    })

    pythonProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.error(`[Python Error] ${output}`)
      checkStarted(output)
    })

    pythonProcess.on('error', (error) => {
      console.error('Failed to start Python backend:', error)
      reject(error)
    })

    pythonProcess.on('exit', (code) => {
      console.log(`Python backend exited with code ${code}`)
      pythonProcess = null
    })

    // Timeout after 5 minutes (model loading can take a while on first run)
    setTimeout(() => {
      if (!started) {
        reject(new Error('Python backend failed to start within 5 minutes'))
      }
    }, 300000)
  })
}

// Stop the Python backend server
function stopPythonBackend(): void {
  if (pythonProcess) {
    console.log('Stopping Python backend...')
    pythonProcess.kill('SIGTERM')
    pythonProcess = null
  }
}

// Stop any active FFmpeg export process
function stopExportProcess(): void {
  if (activeExportProcess) {
    console.log('Stopping active export process...')
    activeExportProcess.kill()
    activeExportProcess = null
  }
}

// Create the main application window
function createWindow(): void {
  // Get the path to preload script
  const preloadPath = isDev 
    ? path.join(getCurrentDir(), 'dist-electron', 'preload.js')
    : path.join(process.resourcesPath, 'dist-electron', 'preload.js')

  // App icon — use .ico on Windows, .png elsewhere
  const iconExt = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconPath = path.join(getCurrentDir(), 'resources', iconExt)
  console.log('[icon] Loading app icon from:', iconPath, '| exists:', fs.existsSync(iconPath))
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: appIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: isDev ? false : true,
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'default',
    show: false,
  })

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // DevTools can be opened manually with Ctrl+Shift+I or F12
  } else {
    mainWindow.loadFile(path.join(process.resourcesPath, 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// IPC Handlers
ipcMain.handle('get-backend-url', () => {
  return `http://localhost:${PYTHON_PORT}`
})

ipcMain.handle('get-models-path', () => {
  return getModelsPath()
})

ipcMain.handle('check-backend-health', async () => {
  try {
    const response = await fetch(`http://localhost:${PYTHON_PORT}/health`)
    return response.ok
  } catch {
    return false
  }
})

ipcMain.handle('check-gpu', async () => {
  return await checkGPU()
})

ipcMain.handle('get-app-info', () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    modelsPath: getModelsPath(),
    userDataPath: app.getPath('userData'),
  }
})

ipcMain.handle('get-downloads-path', () => {
  return app.getPath('downloads')
})

ipcMain.handle('ensure-directory', async (_event, dirPath: string) => {
  try {
    pathValidator.validate(dirPath)
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('check-first-run', () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    return true
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return !settings.setupComplete
  } catch {
    return true
  }
})

ipcMain.handle('complete-setup', () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json')
  let settings: Record<string, unknown> = {}
  
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch {
    settings = {}
  }
  
  settings.setupComplete = true
  settings.setupDate = new Date().toISOString()
  
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return true
})

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  const { shell } = await import('electron')
  shell.openPath(folderPath)
})

ipcMain.handle('show-item-in-folder', async (_event, filePath: string) => {
  const { shell } = await import('electron')
  shell.showItemInFolder(filePath)
})

ipcMain.handle('read-local-file', async (_event, filePath: string) => {
  try {
    const normalizedPath = pathValidator.validate(filePath)

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`)
    }
    
    const data = fs.readFileSync(normalizedPath)
    const base64 = data.toString('base64')
    
    // Determine MIME type from extension
    const ext = path.extname(normalizedPath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.mov': 'video/quicktime',
    }
    const mimeType = mimeTypes[ext] || 'application/octet-stream'
    
    return { data: base64, mimeType }
  } catch (error) {
    console.error('Error reading local file:', error)
    throw error
  }
})

// Model management handlers
ipcMain.handle('get-models-status', async () => {
  try {
    const response = await fetch(`http://localhost:${PYTHON_PORT}/api/models/status`)
    if (response.ok) {
      return await response.json()
    }
    throw new Error('Failed to get models status')
  } catch (error) {
    console.error('Error getting models status:', error)
    return {
      models: [],
      all_downloaded: false,
      total_size: 0,
      downloaded_size: 0,
      total_size_gb: 0,
      downloaded_size_gb: 0,
    }
  }
})

ipcMain.handle('start-model-download', async (_event, options: { skipTextEncoder?: boolean } = {}) => {
  try {
    const response = await fetch(`http://localhost:${PYTHON_PORT}/api/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skipTextEncoder: options.skipTextEncoder || false,
      }),
    })
    return await response.json()
  } catch (error) {
    console.error('Error starting model download:', error)
    return { status: 'error', error: String(error) }
  }
})

ipcMain.handle('get-model-download-progress', async () => {
  try {
    const response = await fetch(`http://localhost:${PYTHON_PORT}/api/models/download/progress`)
    if (response.ok) {
      return await response.json()
    }
    throw new Error('Failed to get download progress')
  } catch (error) {
    console.error('Error getting download progress:', error)
    return {
      status: 'error',
      currentFile: '',
      currentFileProgress: 0,
      totalProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      filesCompleted: 0,
      totalFiles: 0,
      error: String(error),
      speedMbps: 0,
    }
  }
})

// Log viewer handlers — read log file directly (no Python backend dependency)
const getLogDir = (): string => {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LTX-desktop', 'logs')
  }
  return path.join(os.homedir(), '.ltx-video-studio', 'logs')
}

ipcMain.handle('get-logs', async () => {
  try {
    const logDir = getLogDir()
    const logPath = path.join(logDir, 'backend.log')
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8')
      const allLines = content.split('\n')
      const lines = allLines.slice(-200).map(l => l.trimEnd())
      return { logPath, lines }
    }
    return { logPath, lines: [] }
  } catch (error) {
    console.error('Error getting logs:', error)
    return { logPath: '', lines: [], error: String(error) }
  }
})

ipcMain.handle('get-log-path', async () => {
  const logDir = getLogDir()
  const logPath = path.join(logDir, 'backend.log')
  return { logPath, logDir }
})

ipcMain.handle('open-log-folder', async () => {
  const logDir = getLogDir()
  if (fs.existsSync(logDir)) {
    const { shell } = await import('electron')
    shell.openPath(logDir)
    return true
  }
  return false
})

// File save dialog + write
ipcMain.handle('show-save-dialog', async (_event, options: {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}) => {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath,
    filters: options.filters || [],
  })
  if (result.canceled || !result.filePath) return null
  pathValidator.approve(result.filePath)
  return result.filePath
})

ipcMain.handle('save-file', async (_event, filePath: string, data: string, encoding?: string) => {
  try {
    pathValidator.validate(filePath)
    if (encoding === 'base64') {
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
    } else {
      fs.writeFileSync(filePath, data, 'utf-8')
    }
    return { success: true, path: filePath }
  } catch (error) {
    console.error('Error saving file:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('save-binary-file', async (_event, filePath: string, data: ArrayBuffer) => {
  try {
    pathValidator.validate(filePath)
    fs.writeFileSync(filePath, Buffer.from(data))
    return { success: true, path: filePath }
  } catch (error) {
    console.error('Error saving binary file:', error)
    return { success: false, error: String(error) }
  }
})

// Show open folder dialog
ipcMain.handle('show-open-directory-dialog', async (_event, options: { title?: string }) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  pathValidator.approveAndPersist(result.filePaths[0])
  return result.filePaths[0]
})

// Search a directory recursively for files by name
// Returns a map of { filename -> fullPath } for the first match of each filename
ipcMain.handle('search-directory-for-files', async (_event, dir: string, filenames: string[]) => {
  const results: Record<string, string> = {}
  const remaining = new Set(filenames.map(f => f.toLowerCase()))

  const walk = (currentDir: string, depth: number) => {
    if (remaining.size === 0 || depth > 10) return // max depth to avoid infinite loops
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (remaining.size === 0) break
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isFile()) {
          const lower = entry.name.toLowerCase()
          if (remaining.has(lower)) {
            results[lower] = fullPath
            remaining.delete(lower)
          }
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(fullPath, depth + 1)
        }
      }
    } catch {
      // Skip directories we can't read (permissions, etc.)
    }
  }

  walk(dir, 0)
  return results // { "filename.mp4": "C:\path\to\filename.mp4", ... }
})

// Copy file
ipcMain.handle('copy-file', async (_event, src: string, dest: string) => {
  try {
    pathValidator.validate(src)
    pathValidator.validate(dest)
    const dir = path.dirname(dest)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(src, dest)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

// Copy an imported file to persistent storage and return its new path + file URL
ipcMain.handle('import-file-to-storage', async (_event, sourcePath: string, originalName: string) => {
  try {
    // Use the backend outputs directory so imported assets live alongside generated ones
    const backendDir = path.join(getCurrentDir(), 'backend', 'outputs')
    if (!fs.existsSync(backendDir)) fs.mkdirSync(backendDir, { recursive: true })
    
    const ext = path.extname(originalName) || path.extname(sourcePath) || ''
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    const uniqueId = Math.random().toString(36).slice(2, 10)
    const destName = `imported_${timestamp}_${uniqueId}${ext}`
    const destPath = path.join(backendDir, destName)
    
    fs.copyFileSync(sourcePath, destPath)
    
    // Build a file:// URL
    const normalized = destPath.replace(/\\/g, '/')
    const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
    
    return { success: true, path: destPath, url: fileUrl }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

// Check if a file exists on disk
ipcMain.handle('check-file-exists', async (_event, filePath: string) => {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
})

// Check multiple file paths at once (batch)
ipcMain.handle('check-files-exist', async (_event, filePaths: string[]) => {
  const results: Record<string, boolean> = {}
  for (const p of filePaths) {
    try {
      results[p] = fs.existsSync(p)
    } catch {
      results[p] = false
    }
  }
  return results
})

// Show open file dialog (for selecting individual files)
ipcMain.handle('show-open-file-dialog', async (_event, options: {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  properties?: string[]
}) => {
  if (!mainWindow) return null
  const props: any[] = ['openFile']
  if (options.properties?.includes('multiSelections')) props.push('multiSelections')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select File',
    filters: options.filters || [],
    properties: props,
  })
  if (result.canceled || result.filePaths.length === 0) return null
  for (const fp of result.filePaths) {
    pathValidator.approve(fp)
  }
  return result.filePaths
})

// Get resource path for unpacked assets (like splash video)
ipcMain.handle('get-resource-path', () => {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  return null
})

// ═══════════════════════════════════════════════════════════════════
// Video Export via FFmpeg (native compositing — fast, no canvas)
// ═══════════════════════════════════════════════════════════════════

let activeExportProcess: ChildProcess | null = null

interface ExportClip {
  url: string; type: string; startTime: number; duration: number; trimStart: number;
  speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number;
  muted: boolean; volume: number;
}

function findFfmpegPath(): string | null {
  const imageioRelPath = path.join('Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
  const binDir = isDev
    ? path.join(getCurrentDir(), 'backend', '.venv', imageioRelPath)
    : path.join(process.resourcesPath, 'python', imageioRelPath)

  if (fs.existsSync(binDir)) {
    const bin = fs.readdirSync(binDir).find(f => f.startsWith('ffmpeg') && (f.endsWith('.exe') || !f.includes('.')))
    if (bin) return path.join(binDir, bin)
  }

  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return 'ffmpeg' } catch { return null }
}

/** Check if a video file contains an audio stream using ffprobe/ffmpeg */
function fileHasAudio(ffmpegPath: string, filePath: string): boolean {
  try {
    const result = spawnSync(ffmpegPath, ['-i', filePath, '-hide_banner'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const output = (result.stdout || '') + (result.stderr || '')
    return output.includes('Audio:')
  } catch {
    return false
  }
}

function urlToFilePath(url: string): string {
  // Convert http://127.0.0.1:PORT/outputs/file.mp4 → backend/outputs/file.mp4
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    const urlObj = new URL(url)
    const relPath = decodeURIComponent(urlObj.pathname).replace(/^\//, '')
    return path.join(getCurrentDir(), 'backend', relPath)
  }
  // file:///C:/path/to/file.mp4 → C:\path\to\file.mp4
  if (url.startsWith('file://')) {
    return decodeURIComponent(url.replace('file:///', '').replace('file://', ''))
  }
  // Already a file path
  return url
}

interface FlatSegment {
  filePath: string; type: string; startTime: number; duration: number; trimStart: number;
  speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number;
  muted: boolean; volume: number;
}

/**
 * Flatten a multi-track timeline into a sequence of segments for ffmpeg concat.
 * At each point in time, the highest trackIndex wins for video (NLE convention).
 */
function flattenTimeline(clips: ExportClip[]): FlatSegment[] {
  // Only consider video/image clips for visual flattening
  const videoClips = clips.filter(c => c.type === 'video' || c.type === 'image')
  if (videoClips.length === 0) return []

  // Collect all time boundaries
  const boundaries = new Set<number>()
  boundaries.add(0)
  for (const c of videoClips) {
    boundaries.add(c.startTime)
    boundaries.add(c.startTime + c.duration)
  }
  const sorted = [...boundaries].sort((a, b) => a - b)

  const segments: FlatSegment[] = []

  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i]
    const t1 = sorted[i + 1]
    const segDur = t1 - t0
    if (segDur < 0.001) continue

    const mid = (t0 + t1) / 2
    // Find highest-track clip at this time
    const active = videoClips
      .filter(c => mid >= c.startTime && mid < c.startTime + c.duration)
      .sort((a, b) => b.trackIndex - a.trackIndex)

    if (active.length > 0) {
      const c = active[0]
      const offsetInClip = t0 - c.startTime
      segments.push({
        filePath: urlToFilePath(c.url),
        type: c.type,
        startTime: t0,
        duration: segDur,
        trimStart: c.trimStart + offsetInClip * c.speed,
        speed: c.speed,
        reversed: c.reversed,
        flipH: c.flipH,
        flipV: c.flipV,
        opacity: c.opacity,
        muted: c.muted,
        volume: c.volume,
      })
    } else {
      segments.push({
        filePath: '', type: 'gap', startTime: t0, duration: segDur, trimStart: 0,
        speed: 1, reversed: false, flipH: false, flipV: false, opacity: 100,
        muted: true, volume: 0,
      })
    }
  }

  // Merge adjacent segments from the same file with contiguous trim
  const merged: FlatSegment[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (prev && prev.filePath === seg.filePath && prev.filePath !== '' &&
        prev.speed === seg.speed && prev.reversed === seg.reversed &&
        prev.flipH === seg.flipH && prev.flipV === seg.flipV &&
        prev.opacity === seg.opacity && prev.muted === seg.muted && prev.volume === seg.volume &&
        Math.abs((prev.trimStart + prev.duration * prev.speed) - seg.trimStart) < 0.01) {
      prev.duration += seg.duration
    } else {
      merged.push({ ...seg })
    }
  }

  return merged
}

/** Run an ffmpeg command and return a promise. Logs stderr and sets activeExportProcess. */
function runFfmpeg(ffmpegPath: string, args: string[]): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`[ffmpeg] spawn: ${args.join(' ').slice(0, 400)}`)
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    activeExportProcess = proc
    let stderrLog = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrLog += text
      const lines = text.trim().split('\n')
      for (const line of lines) {
        if (line.includes('frame=') || line.includes('Error') || line.includes('error')) {
          console.log(`[ffmpeg] ${line.trim().slice(0, 200)}`)
        }
      }
    })
    proc.on('close', (code) => {
      activeExportProcess = null
      if (code === 0) {
        resolve({ success: true })
      } else {
        const errLines = stderrLog.split('\n').filter(l => l.trim()).slice(-5).join('\n')
        console.error(`[ffmpeg] exited ${code}:\n${errLines}`)
        resolve({ success: false, error: `FFmpeg failed (code ${code}): ${errLines.slice(0, 300)}` })
      }
    })
    proc.on('error', (err) => {
      activeExportProcess = null
      resolve({ success: false, error: `Failed to start ffmpeg: ${err.message}` })
    })
  })
}

interface ExportSubtitle {
  text: string; startTime: number; endTime: number;
  style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean };
}

ipcMain.handle('export-native', async (_event, data: {
  clips: ExportClip[]; outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
  letterbox?: { ratio: number; color: string; opacity: number };
  subtitles?: ExportSubtitle[];
}) => {
  const ffmpegPath = findFfmpegPath()
  if (!ffmpegPath) return { error: 'FFmpeg not found' }

  const { clips, outputPath, codec, width, height, fps, quality, letterbox, subtitles } = data

  // Validate output path and all clip source paths
  try {
    pathValidator.validate(outputPath)
    for (const clip of clips) {
      const fp = urlToFilePath(clip.url)
      if (fp) pathValidator.validate(fp)
    }
  } catch (err) {
    return { error: String(err) }
  }

  const segments = flattenTimeline(clips)
  if (segments.length === 0) return { error: 'No clips to export' }

  // Verify source files exist
  for (const seg of segments) {
    if (seg.filePath && !fs.existsSync(seg.filePath)) {
      return { error: `Source file not found: ${path.basename(seg.filePath)}` }
    }
  }

  const tmpDir = os.tmpdir()
  const ts = Date.now()
  const tmpVideo = path.join(tmpDir, `ltx-export-video-${ts}.mkv`)
  const tmpAudio = path.join(tmpDir, `ltx-export-audio-${ts}.wav`)
  const cleanup = () => {
    try { fs.unlinkSync(tmpVideo) } catch {}
    try { fs.unlinkSync(tmpAudio) } catch {}
  }

  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Export video-only (simple concat, no audio complexity)
    // ═══════════════════════════════════════════════════════════════
    console.log(`[Export] Step 1: Video-only export (${segments.length} segments)`)
    {
      const inputs: string[] = []
      const filterParts: string[] = []
      let idx = 0

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]

        if (seg.type === 'gap') {
          // Gap: generate black frames at target fps (synthetic input)
          inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seg.duration.toFixed(6)}`)
          filterParts.push(`[${idx}:v]setsar=1[v${i}]`)
          idx++
        } else if (seg.type === 'image') {
          // Image: loop for exact duration, use target fps for frame generation
          inputs.push('-loop', '1', '-framerate', String(fps), '-t', seg.duration.toFixed(6), '-i', seg.filePath)
          let chain = `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,setsar=1`
          if (seg.flipH) chain += ',hflip'
          if (seg.flipV) chain += ',vflip'
          chain += `[v${i}]`
          filterParts.push(chain)
          idx++
        } else {
          // Video: trim → speed → scale, NO per-segment fps conversion
          // (fps is applied ONCE after concat to avoid per-segment duration quantization)
          const trimEnd = seg.trimStart + seg.duration * seg.speed
          inputs.push('-i', seg.filePath)
          let chain = `[${idx}:v]trim=start=${seg.trimStart.toFixed(6)}:end=${trimEnd.toFixed(6)},setpts=PTS-STARTPTS`
          if (seg.speed !== 1) chain += `,setpts=PTS/${seg.speed.toFixed(6)}`
          if (seg.reversed) chain += ',reverse'
          chain += `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,setsar=1`
          if (seg.flipH) chain += ',hflip'
          if (seg.flipV) chain += ',vflip'
          chain += `[v${i}]`
          filterParts.push(chain)
          idx++
        }
      }

      const concatInputs = segments.map((_, i) => `[v${i}]`).join('')

      // Concat all segments, then apply fps ONCE to the entire output.
      // This is how real NLEs work: frame rate conversion happens globally,
      // not per-clip, so per-segment duration quantization doesn't accumulate.
      let lastLabel = 'fpsout'
      filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[concatraw]`)
      filterParts.push(`[concatraw]fps=${fps}[${lastLabel}]`)

      // ── Letterbox overlay (drawbox) ──
      if (letterbox) {
        const containerRatio = width / height
        const targetRatio = letterbox.ratio
        const hexColor = letterbox.color.replace('#', '')
        const alphaHex = Math.round(letterbox.opacity * 255).toString(16).padStart(2, '0')
        const colorStr = `0x${hexColor}${alphaHex}`
        const nextLabel = 'lbout'

        if (targetRatio >= containerRatio) {
          // Letterbox: bars on top and bottom
          const visibleH = Math.round(width / targetRatio)
          const barH = Math.round((height - visibleH) / 2)
          if (barH > 0) {
            filterParts.push(`[${lastLabel}]drawbox=x=0:y=0:w=iw:h=${barH}:c=${colorStr}:t=fill,drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:c=${colorStr}:t=fill[${nextLabel}]`)
            lastLabel = nextLabel
          }
        } else {
          // Pillarbox: bars on left and right
          const visibleW = Math.round(height * targetRatio)
          const barW = Math.round((width - visibleW) / 2)
          if (barW > 0) {
            filterParts.push(`[${lastLabel}]drawbox=x=0:y=0:w=${barW}:h=ih:c=${colorStr}:t=fill,drawbox=x=iw-${barW}:y=0:w=${barW}:h=ih:c=${colorStr}:t=fill[${nextLabel}]`)
            lastLabel = nextLabel
          }
        }
      }

      // ── Subtitle burn-in (drawtext) ──
      if (subtitles && subtitles.length > 0) {
        for (let si = 0; si < subtitles.length; si++) {
          const sub = subtitles[si]
          const nextLabel = `sub${si}`
          // Escape text for ffmpeg drawtext: replace special chars
          const escapedText = sub.text
            .replace(/\\/g, '\\\\\\\\')
            .replace(/'/g, "'\\\\\\''")
            .replace(/:/g, '\\:')
            .replace(/%/g, '%%')
            .replace(/\n/g, '\\n')

          const fontSize = Math.round(sub.style.fontSize * (height / 1080)) // scale relative to export res
          const fontColor = sub.style.color.replace('#', '0x')

          // Y position based on style.position
          let yExpr: string
          if (sub.style.position === 'top') {
            yExpr = '20'
          } else if (sub.style.position === 'center') {
            yExpr = '(h-text_h)/2'
          } else {
            yExpr = 'h-text_h-30'
          }

          // Background box
          let boxPart = ''
          if (sub.style.backgroundColor && sub.style.backgroundColor !== 'transparent') {
            const bgHex = sub.style.backgroundColor.replace('#', '')
            // Handle 8-char hex with alpha (e.g., 00000099)
            const bgColor = bgHex.length > 6 ? `0x${bgHex.slice(0, 6)}` : `0x${bgHex}`
            const bgAlpha = bgHex.length > 6 ? (parseInt(bgHex.slice(6), 16) / 255).toFixed(2) : '0.6'
            boxPart = `:box=1:boxcolor=${bgColor}@${bgAlpha}:boxborderw=8`
          }

          const dtFilter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=${yExpr}${boxPart}:enable='between(t\\,${sub.startTime.toFixed(3)}\\,${sub.endTime.toFixed(3)})'`

          filterParts.push(`[${lastLabel}]${dtFilter}[${nextLabel}]`)
          lastLabel = nextLabel
        }
      }

      // Rename final label to outv
      if (lastLabel !== 'outv') {
        filterParts.push(`[${lastLabel}]null[outv]`)
      }

      const filterFile = path.join(tmpDir, `ltx-filter-v-${ts}.txt`)
      fs.writeFileSync(filterFile, filterParts.join(';\n'), 'utf8')

      const r = await runFfmpeg(ffmpegPath, [
        '-y', ...inputs, '-filter_complex_script', filterFile,
        '-map', '[outv]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', tmpVideo
      ])
      try { fs.unlinkSync(filterFile) } catch {}
      if (!r.success) { cleanup(); return { error: r.error } }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Audio mixdown — PCM buffer mixing (sample-accurate)
    //
    // How real NLEs do it: extract each clip's audio as raw PCM,
    // then MIX by summing samples at exact byte offsets.
    // No adelay, no amix, no filter graphs — just math.
    // ═══════════════════════════════════════════════════════════════
    console.log('[Export] Step 2: Audio mixdown (PCM buffer approach)')
    // Total duration = max of video segments and all clips (audio clips may extend beyond video)
    let totalDuration = segments.reduce((max, s) => Math.max(max, s.startTime + s.duration), 0)
    for (const c of clips) {
      totalDuration = Math.max(totalDuration, c.startTime + c.duration)
    }

    const SAMPLE_RATE = 48000
    const NUM_CHANNELS = 2
    const BYTES_PER_SAMPLE = 2 // 16-bit signed LE
    const BYTES_PER_FRAME = NUM_CHANNELS * BYTES_PER_SAMPLE // 4 bytes per stereo frame

    // --- Helper: extract raw PCM from a file via ffmpeg → stdout pipe ---
    function extractPcmBuffer(
      filePath: string, trimStart: number, trimEnd: number, speed: number, reversed: boolean
    ): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        // Build audio filter chain: trim → reset PTS → speed → reverse
        // Using atrim (not -ss/-t) for sample-accurate trimming
        const filters: string[] = [
          `atrim=start=${trimStart.toFixed(6)}:end=${trimEnd.toFixed(6)}`,
          'asetpts=PTS-STARTPTS',
        ]
        if (speed !== 1) {
          // atempo only supports 0.5–100, chain multiple for extreme values
          let remaining = speed
          while (remaining > 2.0) { filters.push('atempo=2.0'); remaining /= 2.0 }
          while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5 }
          filters.push(`atempo=${remaining.toFixed(6)}`)
        }
        if (reversed) filters.push('areverse')

        const args = [
          '-i', filePath,
          '-af', filters.join(','),
          '-f', 's16le', '-ac', String(NUM_CHANNELS), '-ar', String(SAMPLE_RATE),
          'pipe:1',
        ]
        const proc = spawn(ffmpegPath!, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
        proc.stderr?.on('data', () => {}) // drain stderr to prevent blocking
        proc.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks))
          else reject(new Error(`PCM extraction failed (code ${code}) for ${filePath}`))
        })
        proc.on('error', reject)
      })
    }

    // --- Collect audio sources from ORIGINAL clips ---
    const audioProbeCache = new Map<string, boolean>()
    interface AudioSource { filePath: string; trimStart: number; trimEnd: number; timelineStart: number; speed: number; reversed: boolean; volume: number }
    const audioSources: AudioSource[] = []

    for (const c of clips) {
      if (c.muted || c.volume <= 0) continue
      const fp = urlToFilePath(c.url)
      if (!fp || !fs.existsSync(fp)) continue

      if (c.type === 'audio') {
        audioSources.push({
          filePath: fp,
          trimStart: c.trimStart,
          trimEnd: c.trimStart + c.duration * c.speed,
          timelineStart: c.startTime,
          speed: c.speed,
          reversed: c.reversed,
          volume: c.volume,
        })
      } else if (c.type === 'video') {
        if (!audioProbeCache.has(fp)) {
          audioProbeCache.set(fp, fileHasAudio(ffmpegPath, fp))
        }
        if (!audioProbeCache.get(fp)) continue
        audioSources.push({
          filePath: fp,
          trimStart: c.trimStart,
          trimEnd: c.trimStart + c.duration * c.speed,
          timelineStart: c.startTime,
          speed: c.speed,
          reversed: c.reversed,
          volume: c.volume,
        })
      }
    }

    console.log(`[Export] Audio: ${audioSources.length} source(s) from ${clips.length} clip(s)`)

    // --- Create master mix buffer (Float64 to accumulate without clipping) ---
    const totalFrames = Math.ceil(totalDuration * SAMPLE_RATE)
    const totalSamples = totalFrames * NUM_CHANNELS
    const mixBuffer = new Float64Array(totalSamples) // initialized to 0 (silence)

    // --- Extract each source and mix into the master buffer ---
    for (let i = 0; i < audioSources.length; i++) {
      const src = audioSources[i]
      console.log(`[Export] Audio ${i + 1}/${audioSources.length}: ${path.basename(src.filePath)} trim=${src.trimStart.toFixed(2)}-${src.trimEnd.toFixed(2)} @${src.timelineStart.toFixed(2)}s vol=${src.volume}`)
      try {
        const pcm = await extractPcmBuffer(src.filePath, src.trimStart, src.trimEnd, src.speed, src.reversed)
        const startFrame = Math.round(src.timelineStart * SAMPLE_RATE)
        const startSample = startFrame * NUM_CHANNELS
        const numPcmSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE)

        for (let s = 0; s < numPcmSamples; s++) {
          const destIdx = startSample + s
          if (destIdx < 0 || destIdx >= totalSamples) continue
          const value = pcm.readInt16LE(s * BYTES_PER_SAMPLE)
          mixBuffer[destIdx] += value * src.volume
        }
        console.log(`[Export] Audio ${i + 1}: mixed ${numPcmSamples} samples (${(numPcmSamples / SAMPLE_RATE / NUM_CHANNELS).toFixed(2)}s) at offset frame ${startFrame}`)
      } catch (err: any) {
        console.warn(`[Export] Failed to extract audio from ${src.filePath}: ${err.message}`)
      }
    }

    // --- Convert Float64 accumulator → Int16 PCM buffer (with clamp) ---
    const outputPcm = Buffer.alloc(totalFrames * BYTES_PER_FRAME)
    for (let s = 0; s < totalSamples; s++) {
      const clamped = Math.max(-32768, Math.min(32767, Math.round(mixBuffer[s])))
      outputPcm.writeInt16LE(clamped, s * BYTES_PER_SAMPLE)
    }

    // --- Write raw PCM to disk, wrap as WAV ---
    const tmpRawPcm = path.join(tmpDir, `ltx-pcm-${ts}.raw`)
    fs.writeFileSync(tmpRawPcm, outputPcm)
    console.log(`[Export] Wrote raw PCM: ${outputPcm.length} bytes (${totalDuration.toFixed(2)}s)`)

    {
      const r = await runFfmpeg(ffmpegPath, [
        '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(NUM_CHANNELS),
        '-i', tmpRawPcm, '-c:a', 'pcm_s16le', tmpAudio,
      ])
      try { fs.unlinkSync(tmpRawPcm) } catch {}
      if (!r.success) { cleanup(); return { error: r.error } }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Combine video + audio (no re-encode of video)
    // ═══════════════════════════════════════════════════════════════
    console.log('[Export] Step 3: Combining video + audio')
    let videoCodecArgs: string[]
    let audioCodecArgs: string[]
    if (codec === 'h264') {
      videoCodecArgs = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality || 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
      audioCodecArgs = ['-c:a', 'aac', '-b:a', '192k']
    } else if (codec === 'prores') {
      videoCodecArgs = ['-c:v', 'prores_ks', '-profile:v', String(quality || 3), '-pix_fmt', 'yuva444p10le']
      audioCodecArgs = ['-c:a', 'pcm_s16le']
    } else if (codec === 'vp9') {
      videoCodecArgs = ['-c:v', 'libvpx-vp9', '-b:v', `${quality || 8}M`, '-pix_fmt', 'yuv420p']
      audioCodecArgs = ['-c:a', 'libopus', '-b:a', '128k']
    } else {
      cleanup()
      return { error: `Unknown codec: ${codec}` }
    }

    // If final codec matches temp video (h264), just copy video stream
    const canCopyVideo = codec === 'h264'
    const r = await runFfmpeg(ffmpegPath, [
      '-y', '-i', tmpVideo, '-i', tmpAudio,
      '-map', '0:v', '-map', '1:a',
      ...(canCopyVideo ? ['-c:v', 'copy'] : videoCodecArgs),
      ...audioCodecArgs, '-shortest', outputPath
    ])

    cleanup()
    if (!r.success) return { error: r.error }
    console.log(`[Export] Done: ${outputPath}`)
    return { success: true }
  } catch (err) {
    cleanup()
    return { error: String(err) }
  }
})

ipcMain.handle('export-cancel', async () => {
  stopExportProcess()
  return { ok: true }
})

// App lifecycle
app.whenReady().then(async () => {
  setupCSP()

  // Initialize path validator — roots are fetched fresh on each validation
  const approvedDirsFile = path.join(app.getPath('userData'), 'approved-dirs.json')
  pathValidator = new PathValidator(() => {
    const roots = [
      getCurrentDir(),              // covers backend/outputs/
      app.getPath('userData'),      // settings, logs, models
      app.getPath('downloads'),     // default export destination
      os.tmpdir(),                  // FFmpeg temp files
    ]
    if (!isDev && process.resourcesPath) {
      roots.push(process.resourcesPath) // bundled assets
    }
    return roots
  }, approvedDirsFile)

  try {
    // Start Python backend first
    console.log('Starting Python backend...')
    await startPythonBackend()
    console.log('Python backend started successfully')

    // Then create the window
    createWindow()
  } catch (error) {
    console.error('Failed to initialize app:', error)
    // Still create window to show error state
    createWindow()
  }
})

app.on('window-all-closed', () => {
  stopPythonBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

app.on('before-quit', () => {
  stopExportProcess()
  stopPythonBackend()
})
