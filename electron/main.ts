import './app-paths'
import { app, dialog } from 'electron'
import { setupCSP } from './csp'
import { registerExportHandlers } from './export/export-handler'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { registerVideoProcessingHandlers } from './ipc/video-processing-handlers'
import { initSessionLog } from './logging-management'
import { stopPythonBackend } from './python-backend'
import { initAutoUpdater } from './updater'
import { createWindow, getMainWindow } from './window'
import { sendAnalyticsEvent } from './analytics'
import { logger } from './logger'
import { initSentry, captureException } from './sentry'

initSentry()

process.on('uncaughtException', (error) => {
  captureException(error)
  logger.error(`Uncaught exception: ${error.message}\n${error.stack ?? ''}`)
})

process.on('unhandledRejection', (reason) => {
  captureException(reason)
  const message = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
  logger.error(`Unhandled promise rejection: ${message}`)
})

function logAppVersion(): void {
  if (!app.isPackaged) {
    logger.info('[LTX Desktop] Running in development mode')
  } else {
    logger.info(`[LTX Desktop] Version ${app.getVersion()}`)
  }
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  initSessionLog()
  logAppVersion()

  registerAppHandlers()
  registerFileHandlers()
  registerLogHandlers()
  registerExportHandlers()
  registerVideoProcessingHandlers()

  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      return
    }
    if (app.isReady()) {
      createWindow()
    }
  })

  app.whenReady().then(async () => {
    setupCSP()
    createWindow()
    initAutoUpdater()
    // Python setup + backend start are now driven by the renderer via IPC

    // Fire analytics event (no-op if user hasn't opted in)
    void sendAnalyticsEvent('ltxdesktop_app_launched')
  }).catch((err: unknown) => {
    logger.error(`Fatal error during app startup: ${err instanceof Error ? err.message : String(err)}`)
    dialog.showErrorBox('LTX Desktop failed to start', String(err))
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      stopPythonBackend()
      app.quit()
    }
  })

  app.on('activate', () => {
    if (getMainWindow() === null) {
      createWindow()
    }
  })

  app.on('before-quit', () => {
    stopExportProcess()
    stopPythonBackend()
  })
}
