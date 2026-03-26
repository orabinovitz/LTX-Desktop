/* eslint-disable no-console */
import fs from 'fs'

import {
  formatPersistedLogLine,
  formatRenderedLogLine,
  type LogEntry,
  type LogLevel,
  type LogSource,
  shouldEmitToTerminal,
} from '../shared/logging'

export type LogContext = Omit<LogEntry, 'level' | 'source' | 'message'>

let logFilePath: string | null = null
let startupBuffer: LogEntry[] = []
let pendingLines: string[] = []
let flushPromise: Promise<void> | null = null

function consoleMethodFor(level: LogLevel): 'log' | 'warn' | 'error' {
  if (level === 'ERROR') return 'error'
  if (level === 'WARNING') return 'warn'
  return 'log'
}

function queuePersistedLine(entry: LogEntry): void {
  pendingLines.push(`${formatPersistedLogLine(entry)}\n`)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (!logFilePath || pendingLines.length === 0 || flushPromise) {
    return
  }

  const batch = pendingLines.join('')
  pendingLines = []
  flushPromise = fs.promises.appendFile(logFilePath, batch, 'utf-8')
    .catch((error: unknown) => {
      pendingLines = [`${batch}${pendingLines.join('')}`]
      console.error('Failed to write session logs', error)
    })
    .finally(() => {
      flushPromise = null
      if (logFilePath && pendingLines.length > 0) {
        scheduleFlush()
      }
    })
}

/** Called by initSessionLog() to tell the writer where to append. */
export function setLogFilePath(filePath: string): void {
  logFilePath = filePath
  if (startupBuffer.length > 0) {
    for (const entry of startupBuffer) {
      queuePersistedLine(entry)
    }
    startupBuffer = []
  } else {
    scheduleFlush()
  }
}

export function writeLogEntry(entry: LogEntry): void {
  const rendered = formatRenderedLogLine(entry)
  const forceVerboseTerminal = process.env.LTX_AGENT_DEBUG === '1'
  if (forceVerboseTerminal || shouldEmitToTerminal(entry)) {
    console[consoleMethodFor(entry.level)](rendered)
  }

  if (entry.sinks?.sessionFile === false) {
    return
  }

  if (!logFilePath) {
    startupBuffer.push(entry)
    return
  }

  queuePersistedLine(entry)
}

export function writeLog(
  level: LogLevel,
  source: LogSource,
  message: string,
  context: LogContext = {},
): void {
  writeLogEntry({
    level,
    source,
    message,
    ...context,
  })
}

function log(level: LogLevel, message: string, context: LogContext = {}): void {
  writeLog(level, 'Electron', message, context)
}

export const logger = {
  info: (message: string, context?: LogContext) => log('INFO', message, context),
  warn: (message: string, context?: LogContext) => log('WARNING', message, context),
  error: (message: string, context?: LogContext) => log('ERROR', message, context),
  debug: (message: string, context?: LogContext) => log('DEBUG', message, context),
}

export async function flushLogsForTests(): Promise<void> {
  while (flushPromise || (logFilePath && pendingLines.length > 0)) {
    if (!flushPromise) {
      scheduleFlush()
    }
    if (flushPromise) {
      await flushPromise
    }
  }
}

export function resetLoggerForTests(): void {
  logFilePath = null
  startupBuffer = []
  pendingLines = []
  flushPromise = null
}
