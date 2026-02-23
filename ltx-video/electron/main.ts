import { app } from 'electron'
import { setupCSP } from './csp'
import { registerExportHandlers } from './export/export-handler'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { initSessionLog } from './logging-management'
import { stopPythonBackend } from './python-backend'
import { initAutoUpdater } from './updater'
import { createWindow, getMainWindow } from './window'

initSessionLog()

registerAppHandlers()
registerFileHandlers()
registerLogHandlers()
registerExportHandlers()

app.whenReady().then(async () => {
  setupCSP()
  createWindow()
  initAutoUpdater()
  // Python setup + backend start are now driven by the renderer via IPC
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopPythonBackend();
    app.quit();
  }
});

app.on('activate', () => {
  if (getMainWindow() === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopExportProcess();
  stopPythonBackend();
});
