import { ipcMain } from 'electron'
import fs from 'fs'
import { getLogDir, getCurrentLogFilename } from '../logging-management'

export function registerLogHandlers(): void {
  ipcMain.handle('get-logs', async () => {
    try {
      const logPath = getCurrentLogFilename()
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
    const logPath = getCurrentLogFilename()
    const logDir = getLogDir()
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
}
