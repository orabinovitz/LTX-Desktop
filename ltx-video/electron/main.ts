import { app } from 'electron'
import { setupCSP } from './csp'
import { createWindow, getMainWindow } from './window'
import { startPythonBackend, stopPythonBackend } from './python-backend'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { registerExportHandlers } from './export/export-handler'

registerAppHandlers()
registerFileHandlers()
registerLogHandlers()
registerExportHandlers()

app.whenReady().then(async () => {
  setupCSP()

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
