// Using require for Electron preload compatibility
const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get the backend URL
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  
  // Get the path where models are stored
  getModelsPath: (): Promise<string> => ipcRenderer.invoke('get-models-path'),
  
  // Check if the backend is healthy
  checkBackendHealth: (): Promise<boolean> => ipcRenderer.invoke('check-backend-health'),
  
  // Read a local file and return as base64
  readLocalFile: (filePath: string): Promise<{ data: string; mimeType: string }> => 
    ipcRenderer.invoke('read-local-file', filePath),
  
  // Check GPU availability
  checkGpu: (): Promise<{ available: boolean; name?: string; vram?: number }> =>
    ipcRenderer.invoke('check-gpu'),
  
  // Get app info
  getAppInfo: (): Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }> =>
    ipcRenderer.invoke('get-app-info'),
  
  // First-run setup
  checkFirstRun: (): Promise<boolean> => ipcRenderer.invoke('check-first-run'),
  completeSetup: (): Promise<boolean> => ipcRenderer.invoke('complete-setup'),
  
  // Open folder in file explorer
  openFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke('open-folder', folderPath),
  
  // Model management
  getModelsStatus: (): Promise<ModelsStatus> => ipcRenderer.invoke('get-models-status'),
  startModelDownload: (options?: { skipTextEncoder?: boolean; ltxApiKey?: string }): Promise<{ status: string; message?: string; error?: string; skippingTextEncoder?: boolean }> => 
    ipcRenderer.invoke('start-model-download', options || {}),
  getModelDownloadProgress: (): Promise<ModelDownloadProgress> => 
    ipcRenderer.invoke('get-model-download-progress'),
  
  // Log viewer
  getLogs: (): Promise<LogsResponse> => ipcRenderer.invoke('get-logs'),
  getLogPath: (): Promise<{ logPath: string; logDir: string }> => ipcRenderer.invoke('get-log-path'),
  openLogFolder: (): Promise<boolean> => ipcRenderer.invoke('open-log-folder'),
  
  // Get resources path (for video assets in production)
  getResourcePath: (): Promise<string | null> => ipcRenderer.invoke('get-resource-path'),
  
  // Platform info
  platform: process.platform,
})

// Type definitions for model status
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

// Type definitions for the exposed API
declare global {
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
      startModelDownload: (options?: { skipTextEncoder?: boolean; ltxApiKey?: string }) => Promise<{ status: string; message?: string; error?: string; skippingTextEncoder?: boolean }>
      getModelDownloadProgress: () => Promise<ModelDownloadProgress>
      getLogs: () => Promise<LogsResponse>
      getLogPath: () => Promise<{ logPath: string; logDir: string }>
      openLogFolder: () => Promise<boolean>
      getResourcePath: () => Promise<string | null>
      platform: string
    }
  }
}

export {}
