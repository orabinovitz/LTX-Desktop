// Using require for Electron preload compatibility
const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get the backend URL
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  
  // Get the path where models are stored
  getModelsPath: (): Promise<string> => ipcRenderer.invoke('get-models-path'),
  
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
  
  // Reveal a specific file in the OS file manager (Explorer/Finder)
  showItemInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('show-item-in-folder', filePath),
  
  // Log viewer
  getLogs: (): Promise<LogsResponse> => ipcRenderer.invoke('get-logs'),
  getLogPath: (): Promise<{ logPath: string; logDir: string }> => ipcRenderer.invoke('get-log-path'),
  openLogFolder: (): Promise<boolean> => ipcRenderer.invoke('open-log-folder'),
  
  // Get resources path (for video assets in production)
  getResourcePath: (): Promise<string | null> => ipcRenderer.invoke('get-resource-path'),
  
  // Paths
  getDownloadsPath: (): Promise<string> => ipcRenderer.invoke('get-downloads-path'),
  ensureDirectory: (dirPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ensure-directory', dirPath),

  // File save/export
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
    ipcRenderer.invoke('show-save-dialog', options),
  saveFile: (filePath: string, data: string, encoding?: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('save-file', filePath, data, encoding),
  saveBinaryFile: (filePath: string, data: ArrayBuffer): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('save-binary-file', filePath, data),
  showOpenDirectoryDialog: (options: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke('show-open-directory-dialog', options),
  searchDirectoryForFiles: (dir: string, filenames: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('search-directory-for-files', dir, filenames),
  copyFile: (src: string, dest: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('copy-file', src, dest),
  
  // Import a file to persistent storage (copies to outputs dir)
  importFileToStorage: (sourcePath: string, originalName: string): Promise<{ success: boolean; path?: string; url?: string; error?: string }> =>
    ipcRenderer.invoke('import-file-to-storage', sourcePath, originalName),
  
  // Check if a file exists on disk
  checkFileExists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('check-file-exists', filePath),
  
  // Check multiple files at once
  checkFilesExist: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('check-files-exist', filePaths),
  
  // Show open file dialog
  showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<string[] | null> =>
    ipcRenderer.invoke('show-open-file-dialog', options),
  
  // Video export via ffmpeg (native compositing — no canvas, no frame-by-frame)
  exportNative: (data: {
    clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[];
    outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
    letterbox?: { ratio: number; color: string; opacity: number };
    subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[];
  }): Promise<{ success?: boolean; error?: string }> =>
    ipcRenderer.invoke('export-native', data),
  exportCancel: (sessionId: string): Promise<{ ok?: boolean }> =>
    ipcRenderer.invoke('export-cancel', sessionId),

  // Python setup (Windows first-launch download)
  checkPythonReady: (): Promise<{ ready: boolean }> => ipcRenderer.invoke('check-python-ready'),
  startPythonSetup: (): Promise<void> => ipcRenderer.invoke('start-python-setup'),
  startPythonBackend: (): Promise<void> => ipcRenderer.invoke('start-python-backend'),
  onPythonSetupProgress: (cb: (data: unknown) => void) => {
    ipcRenderer.on('python-setup-progress', (_: unknown, data: unknown) => cb(data))
  },
  removePythonSetupProgress: () => {
    ipcRenderer.removeAllListeners('python-setup-progress')
  },

  // Platform info
  platform: process.platform,
})

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
      readLocalFile: (filePath: string) => Promise<{ data: string; mimeType: string }>
      checkGpu: () => Promise<{ available: boolean; name?: string; vram?: number }>
      getAppInfo: () => Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }>
      checkFirstRun: () => Promise<boolean>
      completeSetup: () => Promise<boolean>
      openFolder: (folderPath: string) => Promise<void>
      showItemInFolder: (filePath: string) => Promise<void>
      getLogs: () => Promise<LogsResponse>
      getLogPath: () => Promise<{ logPath: string; logDir: string }>
      openLogFolder: () => Promise<boolean>
      getResourcePath: () => Promise<string | null>
      getDownloadsPath: () => Promise<string>
      ensureDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
      showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      saveFile: (filePath: string, data: string, encoding?: string) => Promise<{ success: boolean; path?: string; error?: string }>
      saveBinaryFile: (filePath: string, data: ArrayBuffer) => Promise<{ success: boolean; path?: string; error?: string }>
      showOpenDirectoryDialog: (options: { title?: string }) => Promise<string | null>
      searchDirectoryForFiles: (dir: string, filenames: string[]) => Promise<Record<string, string>>
      copyFile: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
      importFileToStorage: (sourcePath: string, originalName: string) => Promise<{ success: boolean; path?: string; url?: string; error?: string }>
      checkFileExists: (filePath: string) => Promise<boolean>
      checkFilesExist: (filePaths: string[]) => Promise<Record<string, boolean>>
      showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<string[] | null>
      exportNative: (data: {
        clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[];
        outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
        letterbox?: { ratio: number; color: string; opacity: number };
        subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[];
      }) => Promise<{ success?: boolean; error?: string }>
      exportCancel: (sessionId: string) => Promise<{ ok?: boolean }>
      checkPythonReady: () => Promise<{ ready: boolean }>
      startPythonSetup: () => Promise<void>
      startPythonBackend: () => Promise<void>
      onPythonSetupProgress: (cb: (data: unknown) => void) => void
      removePythonSetupProgress: () => void
      platform: string
    }
  }
}

export {}
