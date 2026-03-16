import path from 'path'
import { fileURLToPath } from 'url'

const isWindows = process.platform === 'win32'

function normalize(p: string): string {
  return isWindows ? path.resolve(p).toLowerCase() : path.resolve(p)
}

function stripFileUrl(fileUrl: string): string {
  if (fileUrl.startsWith('file://')) {
    return fileURLToPath(fileUrl)
  }
  return decodeURIComponent(fileUrl).replace(/\//g, path.sep)
}

const approvedPaths = new Set<string>()

export function approvePath(filePath: string): void {
  approvedPaths.add(normalize(filePath))
}

export function validatePath(inputPath: string, allowedRoots: string[]): string {
  const cleaned = inputPath.startsWith('file://') ? stripFileUrl(inputPath) : inputPath
  const resolved = path.resolve(cleaned)
  const norm = normalize(resolved)

  for (const root of allowedRoots.map(normalize)) {
    if (norm === root || norm.startsWith(root + path.sep)) return resolved
  }

  let found = false
  approvedPaths.forEach((approved) => {
    if (norm === approved || norm.startsWith(approved + path.sep)) found = true
  })
  if (found) return resolved

  throw new Error(`Path not allowed: ${inputPath}`)
}
