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
    showItemInFolder: (filePath: string) => Promise<void>
    getModelsStatus: () => Promise<ModelsStatus>
    startModelDownload: (options?: { skipTextEncoder?: boolean; ltxApiKey?: string }) => Promise<{ status: string; message?: string; error?: string; skippingTextEncoder?: boolean }>
    getModelDownloadProgress: () => Promise<ModelDownloadProgress>
    getLogs: () => Promise<LogsResponse>
    getLogPath: () => Promise<{ logPath: string; logDir: string }>
    openLogFolder: () => Promise<boolean>
    getResourcePath: () => Promise<string | null>
    showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
    saveFile: (filePath: string, data: string, encoding?: string) => Promise<{ success: boolean; path?: string; error?: string }>
    saveBinaryFile: (filePath: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>
    showOpenDirectoryDialog: (options: { title?: string }) => Promise<string | null>
    copyFile: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
    importFileToStorage: (sourcePath: string, originalName: string) => Promise<{ success: boolean; path?: string; url?: string; error?: string }>
    checkFileExists: (filePath: string) => Promise<boolean>
    checkFilesExist: (filePaths: string[]) => Promise<Record<string, boolean>>
    showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<string[] | null>
    searchDirectoryForFiles: (directory: string, filenames: string[]) => Promise<Record<string, string | null>>
    exportNative: (data: {
      clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[]
      outputPath: string; codec: string; width: number; height: number; fps: number; quality: number
      letterbox?: { ratio: number; color: string; opacity: number }
      subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[]
    }) => Promise<{ success?: boolean; error?: string }>
    exportCancel: (sessionId: string) => Promise<{ ok?: boolean }>
    platform: string
  }
}
