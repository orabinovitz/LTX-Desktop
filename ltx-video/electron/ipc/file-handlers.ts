import { ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { getCurrentDir, getAllowedRoots } from '../config'
import { getMainWindow } from '../window'
import { validatePath, approvePath } from '../path-validation'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
}

function readLocalFileAsBase64(filePath: string): { data: string; mimeType: string } {
  const data = fs.readFileSync(filePath)
  const base64 = data.toString('base64')
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream'
  return { data: base64, mimeType }
}

function searchDirectoryForFiles(dir: string, filenames: string[]): Record<string, string> {
  const results: Record<string, string> = {}
  const remaining = new Set(filenames.map(f => f.toLowerCase()))

  const walk = (currentDir: string, depth: number) => {
    if (remaining.size === 0 || depth > 10) return // max depth to avoid infinite loops
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (remaining.size === 0) break
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isFile()) {
          const lower = entry.name.toLowerCase()
          if (remaining.has(lower)) {
            results[lower] = fullPath
            remaining.delete(lower)
          }
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(fullPath, depth + 1)
        }
      }
    } catch {
      // Skip directories we can't read (permissions, etc.)
    }
  }

  walk(dir, 0)
  return results
}

function importFileToStorage(sourcePath: string, originalName: string): { path: string; url: string } {
  // Use the backend outputs directory so imported assets live alongside generated ones
  const backendDir = path.join(getCurrentDir(), 'backend', 'outputs')
  if (!fs.existsSync(backendDir)) fs.mkdirSync(backendDir, { recursive: true })

  const ext = path.extname(originalName) || path.extname(sourcePath) || ''
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const uniqueId = Math.random().toString(36).slice(2, 10)
  const destName = `imported_${timestamp}_${uniqueId}${ext}`
  const destPath = path.join(backendDir, destName)

  fs.copyFileSync(sourcePath, destPath)

  // Build a file:// URL
  const normalized = destPath.replace(/\\/g, '/')
  const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`

  return { path: destPath, url: fileUrl }
}

export function registerFileHandlers(): void {
  ipcMain.handle('open-folder', async (_event, folderPath: string) => {
    const { shell } = await import('electron')
    shell.openPath(folderPath)
  })

  ipcMain.handle('show-item-in-folder', async (_event, filePath: string) => {
    const { shell } = await import('electron')
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('read-local-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = validatePath(filePath, getAllowedRoots())

      if (!fs.existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`)
      }

      return readLocalFileAsBase64(normalizedPath)
    } catch (error) {
      console.error('Error reading local file:', error)
      throw error
    }
  })

  ipcMain.handle('show-save-dialog', async (_event, options: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters || [],
    })
    if (result.canceled || !result.filePath) return null
    approvePath(result.filePath)
    return result.filePath
  })

  ipcMain.handle('save-file', async (_event, filePath: string, data: string, encoding?: string) => {
    try {
      validatePath(filePath, getAllowedRoots())
      if (encoding === 'base64') {
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
      } else {
        fs.writeFileSync(filePath, data, 'utf-8')
      }
      return { success: true, path: filePath }
    } catch (error) {
      console.error('Error saving file:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('save-binary-file', async (_event, filePath: string, data: ArrayBuffer) => {
    try {
      validatePath(filePath, getAllowedRoots())
      fs.writeFileSync(filePath, Buffer.from(data))
      return { success: true, path: filePath }
    } catch (error) {
      console.error('Error saving binary file:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('show-open-directory-dialog', async (_event, options: { title?: string }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    approvePath(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle('search-directory-for-files', async (_event, dir: string, filenames: string[]) => {
    return searchDirectoryForFiles(dir, filenames)
  })

  ipcMain.handle('copy-file', async (_event, src: string, dest: string) => {
    try {
      validatePath(src, getAllowedRoots())
      validatePath(dest, getAllowedRoots())
      const dir = path.dirname(dest)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(src, dest)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('import-file-to-storage', async (_event, sourcePath: string, originalName: string) => {
    try {
      const result = importFileToStorage(sourcePath, originalName)
      return { success: true, path: result.path, url: result.url }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('check-file-exists', async (_event, filePath: string) => {
    try {
      return fs.existsSync(filePath)
    } catch {
      return false
    }
  })

  ipcMain.handle('check-files-exist', async (_event, filePaths: string[]) => {
    const results: Record<string, boolean> = {}
    for (const p of filePaths) {
      try {
        results[p] = fs.existsSync(p)
      } catch {
        results[p] = false
      }
    }
    return results
  })

  ipcMain.handle('show-open-file-dialog', async (_event, options: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
    properties?: string[]
  }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const props: any[] = ['openFile']
    if (options.properties?.includes('multiSelections')) props.push('multiSelections')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select File',
      filters: options.filters || [],
      properties: props,
    })
    if (result.canceled || result.filePaths.length === 0) return null
    for (const fp of result.filePaths) {
      approvePath(fp)
    }
    return result.filePaths
  })

  ipcMain.handle('ensure-directory', async (_event, dirPath: string) => {
    try {
      validatePath(dirPath, getAllowedRoots())
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
