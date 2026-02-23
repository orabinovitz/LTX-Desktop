import { app, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { BACKEND_BASE_URL } from '../config'
import { checkGPU } from '../gpu'
import { isPythonReady, downloadPythonEmbed } from '../python-setup'
import { startPythonBackend } from '../python-backend'
import { getMainWindow } from '../window'

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

  ipcMain.handle('check-python-ready', () => {
    return isPythonReady()
  })

  ipcMain.handle('start-python-setup', async () => {
    await downloadPythonEmbed((progress) => {
      getMainWindow()?.webContents.send('python-setup-progress', progress)
    })
  })

  ipcMain.handle('start-python-backend', async () => {
    await startPythonBackend()
  })

}
