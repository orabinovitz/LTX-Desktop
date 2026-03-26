import { ipcMain } from 'electron'
import fs from 'fs'

import { logger, writeLogEntry } from '../logger'
import { getCurrentLogFilename,getLogDir } from '../logging-management'
import type { LogEntry, LogLevel } from '../shared/logging'
import { IpcChannels } from './channels'

const VALID_LOG_LEVELS = new Set<LogLevel>(['INFO', 'WARNING', 'ERROR', 'DEBUG'])

function normalizeLogEntry(payload: unknown, legacyMessage?: unknown): LogEntry | null {
  if (typeof payload === 'string' && typeof legacyMessage === 'string') {
    const level = payload.toUpperCase()
    if (!VALID_LOG_LEVELS.has(level as LogLevel)) return null
    return {
      level: level as LogLevel,
      source: 'Renderer',
      message: legacyMessage,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Partial<LogEntry>
  const level = typeof record.level === 'string' ? record.level.toUpperCase() : ''
  const message = typeof record.message === 'string' ? record.message : ''
  if (!VALID_LOG_LEVELS.has(level as LogLevel) || message.length === 0) {
    return null
  }

  return {
    level: level as LogLevel,
    source: 'Renderer',
    message,
    category: typeof record.category === 'string' ? record.category : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
    traceId: typeof record.traceId === 'string' ? record.traceId : undefined,
    agentSessionId: typeof record.agentSessionId === 'string' ? record.agentSessionId : undefined,
    taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
    toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    statusCode: typeof record.statusCode === 'number' ? record.statusCode : undefined,
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    retryCause: typeof record.retryCause === 'string' ? record.retryCause : undefined,
    sinks: record.sinks,
  }
}

export function registerLogHandlers(): void {
  ipcMain.handle(IpcChannels.LOG_WRITE, async (_event, payload: unknown, legacyMessage?: unknown) => {
    const entry = normalizeLogEntry(payload, legacyMessage)
    if (!entry) return
    writeLogEntry(entry)
  })
  ipcMain.handle(IpcChannels.LOG_GET, async (_event, options?: { limit?: number }) => {
    try {
      const logPath = getCurrentLogFilename()
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf-8')
        const limit = typeof options?.limit === 'number'
          ? Math.max(1, Math.min(options.limit, 5000))
          : 2000
        const allLines = content
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
        const lines = allLines.slice(-limit)
        return { logPath, lines, totalLines: allLines.length }
      }
      return { logPath, lines: [], totalLines: 0 }
    } catch (error) {
      logger.error(`Error getting logs: ${error}`)
      return { logPath: '', lines: [], totalLines: 0, error: String(error) }
    }
  })

  ipcMain.handle(IpcChannels.LOG_OPEN_FOLDER, async () => {
    const logDir = getLogDir()
    if (fs.existsSync(logDir)) {
      const { shell } = await import('electron')
      void shell.openPath(logDir)
      return true
    }
    return false
  })
}
