import { app, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { BACKEND_BASE_URL } from '../config'
import { checkGPU } from '../gpu'

function getModelsPath(): string {
  const modelsPath = path.join(app.getPath('userData'), 'models')
  if (!fs.existsSync(modelsPath)) {
    fs.mkdirSync(modelsPath, { recursive: true })
  }
  return modelsPath
}

function isFirstRun(settingsPath: string): boolean {
  if (!fs.existsSync(settingsPath)) {
    return true
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return !settings.setupComplete
  } catch {
    return true
  }
}

function markSetupComplete(settingsPath: string): void {
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
}

export function registerAppHandlers(): void {
  ipcMain.handle('get-backend-url', () => {
    return BACKEND_BASE_URL
  })

  ipcMain.handle('get-models-path', () => {
    return getModelsPath()
  })

  ipcMain.handle('check-backend-health', async () => {
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/health`)
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

  ipcMain.handle('check-first-run', () => {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    return isFirstRun(settingsPath)
  })

  ipcMain.handle('complete-setup', () => {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    markSetupComplete(settingsPath)
    return true
  })

  ipcMain.handle('get-resource-path', () => {
    if (!app.isPackaged) {
      return null
    }
    return process.resourcesPath
  })

  // Model management handlers
  ipcMain.handle('get-models-status', async () => {
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/models/status`)
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
      const response = await fetch(`${BACKEND_BASE_URL}/api/models/download`, {
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
      const response = await fetch(`${BACKEND_BASE_URL}/api/models/download/progress`)
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
}
