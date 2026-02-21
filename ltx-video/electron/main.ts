import { app } from 'electron'
import { setupCSP } from './csp'
import { registerExportHandlers } from './export/export-handler'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { startPythonBackend, stopPythonBackend } from './python-backend'
import { initAutoUpdater } from './updater'
import { createWindow, getMainWindow } from './window'

registerAppHandlers()
registerFileHandlers()
registerLogHandlers()
registerExportHandlers()

app.whenReady().then(async () => {
  setupCSP()

  try {
    // Start Python backend first
    console.log('Starting Python backend...');
    await startPythonBackend();
    console.log('Python backend started successfully');
  } catch (e) {
    console.error('Failed to initialize Python backend:', e)
  }

  createWindow();
  initAutoUpdater();
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
