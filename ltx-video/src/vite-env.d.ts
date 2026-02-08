/// <reference types="vite/client" />

interface ModelInfo {
  name: string
  description: string
  downloaded: boolean
  size: number
  expected_size: number
  is_folder?: boolean
}

interface ModelsStatus {
  models: ModelInfo[]
  all_downloaded: boolean
  total_size: number
  downloaded_size: number
  total_size_gb: number
  downloaded_size_gb: number
}

interface ModelDownloadProgress {
  status: 'idle' | 'downloading' | 'complete' | 'error'
  currentFile: string
  currentFileProgress: number
  totalProgress: number
  downloadedBytes: number
  totalBytes: number
  filesCompleted: number
  totalFiles: number
  error: string | null
  speedMbps: number
}

interface LogsResponse {
  logPath: string
  lines: string[]
  error?: string
}

interface Window {
  electronAPI: {
    getBackendUrl: () => Promise<string>
    getModelsPath: () => Promise<string>
    checkBackendHealth: () => Promise<boolean>
    readLocalFile: (filePath: string) => Promise<{ data: string; mimeType: string }>
    checkGpu: () => Promise<{ available: boolean; name?: string; vram?: number }>
    getAppInfo: () => Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }>
    checkFirstRun: () => Promise<boolean>
    completeSetup: () => Promise<boolean>
    openFolder: (folderPath: string) => Promise<void>
    getModelsStatus: () => Promise<ModelsStatus>
    startModelDownload: () => Promise<{ status: string; message?: string; error?: string }>
    getModelDownloadProgress: () => Promise<ModelDownloadProgress>
    getLogs: () => Promise<LogsResponse>
    getLogPath: () => Promise<{ logPath: string; logDir: string }>
    openLogFolder: () => Promise<boolean>
    getResourcePath: () => Promise<string | null>
    platform: string
  }
}
