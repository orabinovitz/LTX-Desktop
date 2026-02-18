import path from 'path'
import fs from 'fs'

const isWindows = process.platform === 'win32'

function normalize(p: string): string {
  const resolved = path.resolve(p)
  return isWindows ? resolved.toLowerCase() : resolved
}

export class PathValidator {
  private getAllowedRoots: () => string[]
  private approvedPaths = new Set<string>()
  private approvedDirsFile: string

  constructor(getAllowedRoots: () => string[], approvedDirsFile: string) {
    this.getAllowedRoots = getAllowedRoots
    this.approvedDirsFile = approvedDirsFile
    this.loadApprovedDirs()
  }

  /** Validate that a path falls under an allowed root or approved path. Returns the resolved path. Handles file:// URLs. */
  validate(inputPath: string): string {
    const cleaned = inputPath.startsWith('file://') ? this.stripFileUrl(inputPath) : inputPath
    const resolved = path.resolve(cleaned)
    const norm = isWindows ? resolved.toLowerCase() : resolved

    for (const root of this.getAllowedRoots().map(normalize)) {
      if (norm === root || norm.startsWith(root + path.sep)) return resolved
    }
    let found = false
    this.approvedPaths.forEach((approved) => {
      if (norm === approved || norm.startsWith(approved + path.sep)) found = true
    })
    if (found) return resolved

    throw new Error(`Path not allowed: ${inputPath}`)
  }

  private stripFileUrl(fileUrl: string): string {
    let raw = fileUrl
    if (raw.startsWith('file:///')) {
      raw = raw.slice(8) // Remove 'file:///' — keeps drive letter on Windows
    } else if (raw.startsWith('file://')) {
      raw = raw.slice(7)
    }
    raw = decodeURIComponent(raw)
    return raw.replace(/\//g, path.sep)
  }

  /** Approve a path (file or directory). Directory approval covers descendants. */
  approve(filePath: string): void {
    this.approvedPaths.add(normalize(filePath))
  }

  /** Approve a directory and persist it so it survives app restarts. */
  approveAndPersist(dirPath: string): void {
    this.approve(dirPath)
    this.persistApprovedDir(dirPath)
  }

  private loadApprovedDirs(): void {
    try {
      if (fs.existsSync(this.approvedDirsFile)) {
        const data = JSON.parse(fs.readFileSync(this.approvedDirsFile, 'utf-8'))
        if (Array.isArray(data)) {
          for (const dir of data) {
            if (typeof dir === 'string') {
              this.approvedPaths.add(normalize(dir))
            }
          }
        }
      }
    } catch {
      // Ignore corrupt file — start with empty approved set
    }
  }

  private persistApprovedDir(dirPath: string): void {
    try {
      let dirs: string[] = []
      if (fs.existsSync(this.approvedDirsFile)) {
        const data = JSON.parse(fs.readFileSync(this.approvedDirsFile, 'utf-8'))
        if (Array.isArray(data)) dirs = data.filter((d: unknown) => typeof d === 'string')
      }
      const resolved = path.resolve(dirPath)
      if (!dirs.includes(resolved)) {
        dirs.push(resolved)
        fs.writeFileSync(this.approvedDirsFile, JSON.stringify(dirs, null, 2))
      }
    } catch {
      // Best-effort persistence
    }
  }
}
