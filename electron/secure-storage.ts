import { safeStorage, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from './logger'

const SECURE_KEYS_FILE = 'secure-keys.json'

type SecureKeysOnDisk = Record<string, string>

function getSecureKeysPath(): string {
  return path.join(app.getPath('userData'), SECURE_KEYS_FILE)
}

function readRawStore(): SecureKeysOnDisk {
  try {
    const p = getSecureKeysPath()
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as SecureKeysOnDisk
    }
  } catch (err) {
    logger.warn(`Failed to read secure keys store (starting fresh): ${err instanceof Error ? err.message : String(err)}`)
  }
  return {}
}

function writeRawStore(store: SecureKeysOnDisk): void {
  const target = getSecureKeysPath()
  const tmp = `${target}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, target)
  } catch (err) {
    logger.error(`Failed to write secure keys store: ${err instanceof Error ? err.message : String(err)}`)
    try { fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw err
  }
}

export function storeSecureKey(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    return
  }
  const store = readRawStore()
  if (!value) {
    delete store[name]
  } else {
    const encrypted = safeStorage.encryptString(value)
    store[name] = encrypted.toString('base64')
  }
  writeRawStore(store)
}

export function getSecureKey(name: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }
  const store = readRawStore()
  const b64 = store[name]
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    logger.warn(`Failed to decrypt secure key "${name}": ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function getAllSecureKeys(): Record<string, string> {
  if (!safeStorage.isEncryptionAvailable()) {
    return {}
  }
  const store = readRawStore()
  const result: Record<string, string> = {}
  for (const [name, b64] of Object.entries(store)) {
    try {
      const buf = Buffer.from(b64, 'base64')
      result[name] = safeStorage.decryptString(buf)
    } catch (err) {
      logger.warn(`Failed to decrypt key "${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}

const API_KEY_FIELDS = ['ltx_api_key', 'fal_api_key', 'gemini_api_key'] as const

/**
 * Migrate plaintext API keys from settings.json into encrypted secure storage,
 * then clear them from the JSON file on disk.
 */
export function migrateApiKeysFromSettings(settingsJsonPath: string): void {
  if (!safeStorage.isEncryptionAvailable()) return
  if (!fs.existsSync(settingsJsonPath)) return

  try {
    const raw = JSON.parse(fs.readFileSync(settingsJsonPath, 'utf-8'))
    let modified = false

    for (const field of API_KEY_FIELDS) {
      const value = raw[field]
      if (typeof value === 'string' && value.length > 0) {
        storeSecureKey(field, value)
        raw[field] = ''
        modified = true
      }
    }

    if (modified) {
      fs.writeFileSync(settingsJsonPath, JSON.stringify(raw, null, 2))
    }
  } catch (err) {
    logger.warn(`API key migration from settings failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Returns decrypted API keys to inject into the backend.
 */
export function getDecryptedApiKeys(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of API_KEY_FIELDS) {
    const val = getSecureKey(field)
    if (val) result[field] = val
  }
  return result
}
