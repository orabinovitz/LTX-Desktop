import { ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'

function getLogDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LTX-desktop', 'logs')
  }
  return path.join(os.homedir(), '.ltx-video-studio', 'logs')
}

export function registerLogHandlers(): void {
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
}
