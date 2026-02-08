import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

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

const PYTHON_PORT = 8000
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

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
    const bundledPython = path.join(process.resourcesPath, 'python', 'python.exe')
    if (fs.existsSync(bundledPython)) {
      console.log(`Using bundled Python: ${bundledPython}`)
      return bundledPython
    }
  }
  
  // Check for venv in backend directory
  const backendPath = getBackendPath()
  const venvPython = path.join(backendPath, '.venv', 'Scripts', 'python.exe')
  
  if (fs.existsSync(venvPython)) {
    console.log(`Using venv Python: ${venvPython}`)
    return venvPython
  }
  
  if (isDev) {
    // In development, try common Python paths
    const pythonPaths = [
      'python',
      'python3',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
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
    return 'python'
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

// Create the main application window
function createWindow(): void {
  // Get the path to preload script
  const preloadPath = isDev 
    ? path.join(getCurrentDir(), 'dist-electron', 'preload.js')
    : path.join(process.resourcesPath, 'dist-electron', 'preload.js')

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Disable web security in dev to allow localhost API calls
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

ipcMain.handle('read-local-file', async (_event, filePath: string) => {
  try {
    // Normalize the file path (handle file:// URLs)
    let normalizedPath = filePath
    if (filePath.startsWith('file:///')) {
      normalizedPath = filePath.slice(8) // Remove 'file:///'
    } else if (filePath.startsWith('file://')) {
      normalizedPath = filePath.slice(7) // Remove 'file://'
    }
    
    // On Windows, paths like 'C:/...' are valid
    normalizedPath = normalizedPath.replace(/\//g, path.sep)
    
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
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    
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

ipcMain.handle('start-model-download', async () => {
  try {
    const response = await fetch(`http://localhost:${PYTHON_PORT}/api/models/download`, {
      method: 'POST',
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

// App lifecycle
app.whenReady().then(async () => {
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
  stopPythonBackend()
})
