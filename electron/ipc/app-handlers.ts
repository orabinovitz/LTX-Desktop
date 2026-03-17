import { app, dialog, ipcMain } from 'electron'
import { IpcChannels } from './channels'
import path from 'path'
import fs from 'fs'
import { checkGPU } from '../gpu'
import { isPythonReady, downloadPythonEmbed } from '../python-setup'
import { getBackendHealthStatus, getBackendUrl, getAuthToken, getAdminToken, startPythonBackend } from '../python-backend'
import { getMainWindow } from '../window'
import { getAnalyticsState, setAnalyticsEnabled, sendAnalyticsEvent } from '../analytics'
import { storeSecureKey, getSecureKey } from '../secure-storage'

function getModelsPath(): string {
  const modelsPath = path.join(app.getPath('userData'), 'models')
  if (!fs.existsSync(modelsPath)) {
    fs.mkdirSync(modelsPath, { recursive: true })
  }
  return modelsPath
}

function getSetupStatus(settingsPath: string): { needsSetup: boolean; needsLicense: boolean } {
  if (!fs.existsSync(settingsPath)) {
    return { needsSetup: true, needsLicense: true }
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return {
      needsSetup: !settings.setupComplete,
      needsLicense: !settings.licenseAccepted,
    }
  } catch {
    return { needsSetup: true, needsLicense: true }
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
  settings.licenseAccepted = true
  settings.licenseAcceptedDate = new Date().toISOString()
  settings.setupDate = new Date().toISOString()

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

function markLicenseAccepted(settingsPath: string): void {
  let settings: Record<string, unknown> = {}

  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch {
    settings = {}
  }

  settings.licenseAccepted = true
  settings.licenseAcceptedDate = new Date().toISOString()

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannels.APP_GET_BACKEND, () => {
    return { url: getBackendUrl() ?? '', token: getAuthToken() ?? '' }
  })

  ipcMain.handle(IpcChannels.APP_GET_MODELS_PATH, () => {
    return getModelsPath()
  })

  ipcMain.handle(IpcChannels.APP_CHECK_GPU, async () => {
    return await checkGPU()
  })

  ipcMain.handle(IpcChannels.APP_GET_INFO, () => {
    return {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      modelsPath: getModelsPath(),
      userDataPath: app.getPath('userData'),
    }
  })

  ipcMain.handle(IpcChannels.SETUP_CHECK_FIRST_RUN, () => {
    const settingsPath = path.join(app.getPath('userData'), 'app_state.json')
    return getSetupStatus(settingsPath)
  })

  ipcMain.handle(IpcChannels.SETUP_ACCEPT_LICENSE, () => {
    const settingsPath = path.join(app.getPath('userData'), 'app_state.json')
    markLicenseAccepted(settingsPath)
    return true
  })

  ipcMain.handle(IpcChannels.SETUP_COMPLETE, () => {
    const settingsPath = path.join(app.getPath('userData'), 'app_state.json')
    markSetupComplete(settingsPath)
    return true
  })

  ipcMain.handle(IpcChannels.SETUP_FETCH_LICENSE_TEXT, async () => {
    const resp = await fetch('https://huggingface.co/Lightricks/LTX-2.3/raw/main/LICENSE')
    if (!resp.ok) {
      throw new Error(`Failed to fetch license (HTTP ${resp.status})`)
    }
    return await resp.text()
  })

  ipcMain.handle(IpcChannels.SETUP_GET_NOTICES_TEXT, async () => {
    const noticesPath = path.join(app.getAppPath(), 'NOTICES.md')
    return fs.readFileSync(noticesPath, 'utf-8')
  })

  ipcMain.handle(IpcChannels.APP_GET_RESOURCE_PATH, () => {
    if (!app.isPackaged) {
      return null
    }
    return process.resourcesPath
  })

  ipcMain.handle(IpcChannels.PYTHON_CHECK_READY, () => {
    return isPythonReady()
  })

  ipcMain.handle(IpcChannels.PYTHON_START_SETUP, async () => {
    await downloadPythonEmbed((progress) => {
      getMainWindow()?.webContents.send(IpcChannels.PYTHON_SETUP_PROGRESS, progress)
    })
  })

  ipcMain.handle(IpcChannels.PYTHON_START_BACKEND, async () => {
    await startPythonBackend()
  })

  ipcMain.handle(IpcChannels.PYTHON_GET_HEALTH_STATUS, () => {
    return getBackendHealthStatus()
  })

  ipcMain.handle(IpcChannels.ANALYTICS_GET_STATE, () => {
    return getAnalyticsState()
  })

  ipcMain.handle(IpcChannels.ANALYTICS_SET_ENABLED, (_event, enabled: boolean) => {
    setAnalyticsEnabled(enabled)
  })

  ipcMain.handle(IpcChannels.ANALYTICS_SEND_EVENT, async (_event, eventName: string, extraDetails?: Record<string, unknown> | null) => {
    await sendAnalyticsEvent(eventName, extraDetails)
  })

  ipcMain.handle(IpcChannels.MODELS_CHANGE_DIR_DIALOG, async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return { success: false, error: 'No window' }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Models Directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' }

    const newDir = result.filePaths[0]
    const url = getBackendUrl()
    const auth = getAuthToken()
    const admin = getAdminToken()
    if (!url || !auth || !admin) return { success: false, error: 'Backend not ready' }

    const resp = await fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth}`,
        'X-Admin-Token': admin,
      },
      body: JSON.stringify({ modelsDir: newDir }),
    })
    if (!resp.ok) return { success: false, error: await resp.text() }

    return { success: true, path: newDir }
  })

  ipcMain.handle(IpcChannels.SECURE_STORE_KEY, (_event, name: string, value: string) => {
    storeSecureKey(name, value)
  })

  ipcMain.handle(IpcChannels.SECURE_GET_KEY, (_event, name: string) => {
    return getSecureKey(name) ?? ''
  })

}
