import type { LogEntry } from "./logging"

interface LogsResponse {
  logPath: string
  lines: string[]
  totalLines?: number
  error?: string
}

interface BackendHealthStatus {
  status: 'alive' | 'restarting' | 'dead'
  exitCode?: number | null
}

interface ElectronAPI {
  getBackend: () => Promise<{ url: string; token: string }>
  getModelsPath: () => Promise<string>
  readLocalFile: (filePath: string) => Promise<{ data: string; mimeType: string }>
  checkGpu: () => Promise<{ available: boolean; name?: string; vram?: number }>
  getAppInfo: () => Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }>
  checkFirstRun: () => Promise<{ needsSetup: boolean; needsLicense: boolean }>
  acceptLicense: () => Promise<boolean>
  completeSetup: () => Promise<boolean>
  fetchLicenseText: () => Promise<string>
  getNoticesText: () => Promise<string>
  openLtxApiKeyPage: () => Promise<boolean>
  openFalApiKeyPage: () => Promise<boolean>
  openParentFolderOfFile: (filePath: string) => Promise<void>
  showItemInFolder: (filePath: string) => Promise<void>
  getLogs: (options?: { limit?: number }) => Promise<LogsResponse>
  openLogFolder: () => Promise<boolean>
  getResourcePath: () => Promise<string | null>
  copyToProjectAssets: (srcPath: string, projectId: string) => Promise<{ success: boolean; path?: string; url?: string; error?: string }>
  getProjectAssetsPath: () => Promise<string>
  openProjectAssetsPathChangeDialog: () => Promise<{ success: boolean; path?: string; error?: string }>
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
  saveFile: (filePath: string, data: string, encoding?: string) => Promise<{ success: boolean; path?: string; error?: string }>
  saveBinaryFile: (filePath: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>
  showOpenDirectoryDialog: (options: { title?: string }) => Promise<string | null>
  searchDirectoryForFiles: (dir: string, filenames: string[]) => Promise<Record<string, string>>
  checkFilesExist: (filePaths: string[]) => Promise<Record<string, boolean>>
  showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<string[] | null>
  exportNative: (data: {
    clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[]
    outputPath: string; codec: string; width: number; height: number; fps: number; quality: number
    letterbox?: { ratio: number; color: string; opacity: number }
    subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[]
  }) => Promise<{ success?: boolean; error?: string }>
  exportCancel: (sessionId: string) => Promise<{ ok?: boolean }>
  checkPythonReady: () => Promise<{ ready: boolean }>
  startPythonSetup: () => Promise<void>
  startPythonBackend: () => Promise<void>
  getBackendHealthStatus: () => Promise<BackendHealthStatus | null>
  onPythonSetupProgress: (cb: (data: unknown) => void) => void
  removePythonSetupProgress: () => void
  onBackendHealthStatus: (cb: (data: BackendHealthStatus) => void) => (() => void)
  extractVideoFrame: (videoUrl: string, seekTime: number, width?: number, quality?: number) => Promise<{ path: string; url: string }>
  writeLog: (entry: LogEntry) => Promise<void>
  openModelsDirChangeDialog: () => Promise<{ success: boolean; path?: string; error?: string }>
  getAnalyticsState: () => Promise<{ analyticsEnabled: boolean; installationId: string }>
  setAnalyticsEnabled: (enabled: boolean) => Promise<void>
  sendAnalyticsEvent: (eventName: string, extraDetails?: Record<string, unknown> | null) => Promise<void>
  storeSecureKey: (name: string, value: string) => Promise<void>
  getSecureKey: (name: string) => Promise<string>
  platform: string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
