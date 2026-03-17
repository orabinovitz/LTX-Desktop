import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from './logger'

interface AppState {
  analyticsEnabled?: boolean
  installationId?: string
  projectAssetsPath?: string
  [key: string]: unknown
}

function getAppStatePath(): string {
  return path.join(app.getPath('userData'), 'app_state.json')
}

export function readAppState(): AppState {
  const statePath = getAppStatePath()
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as AppState
    }
  } catch (err) {
    logger.warn(`[app-state] failed to read app state: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {}
}

export function writeAppState(state: AppState): void {
  fs.writeFileSync(getAppStatePath(), JSON.stringify(state, null, 2))
}

let cachedProjectAssetsPath: string | null = null

export function getProjectAssetsPath(): string {
  if (cachedProjectAssetsPath) return cachedProjectAssetsPath
  const state = readAppState()
  if (state.projectAssetsPath) {
    cachedProjectAssetsPath = path.resolve(state.projectAssetsPath)
    return cachedProjectAssetsPath
  }
  const defaultPath = path.resolve(path.join(app.getPath('downloads'), 'Ltx Desktop Assets'))
  cachedProjectAssetsPath = defaultPath
  return defaultPath
}

const BLOCKED_ROOTS = new Set(
  process.platform === 'win32'
    ? ['c:\\', 'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']
    : ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/lib', '/System', '/Library', '/private'],
)

export function setProjectAssetsPath(p: string): void {
  const resolved = path.resolve(p)
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (BLOCKED_ROOTS.has(normalized) || normalized === path.sep) {
    throw new Error(`Cannot set project assets path to a system directory: ${p}`)
  }
  cachedProjectAssetsPath = resolved
  const state = readAppState()
  state.projectAssetsPath = resolved
  writeAppState(state)
}
