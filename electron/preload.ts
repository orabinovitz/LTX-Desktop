// Using require for Electron preload compatibility
const { contextBridge, ipcRenderer } = require('electron')
const { IpcChannels } = require('./ipc/channels')

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getBackend: (): Promise<{ url: string; token: string }> => ipcRenderer.invoke(IpcChannels.APP_GET_BACKEND),
  getModelsPath: (): Promise<string> => ipcRenderer.invoke(IpcChannels.APP_GET_MODELS_PATH),
  readLocalFile: (filePath: string): Promise<{ data: string; mimeType: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_READ_LOCAL, filePath),
  checkGpu: (): Promise<{ available: boolean; name?: string; vram?: number }> =>
    ipcRenderer.invoke(IpcChannels.APP_CHECK_GPU),
  getAppInfo: (): Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }> =>
    ipcRenderer.invoke(IpcChannels.APP_GET_INFO),

  // First-run setup
  checkFirstRun: (): Promise<{ needsSetup: boolean; needsLicense: boolean }> => ipcRenderer.invoke(IpcChannels.SETUP_CHECK_FIRST_RUN),
  acceptLicense: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.SETUP_ACCEPT_LICENSE),
  completeSetup: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.SETUP_COMPLETE),
  fetchLicenseText: (): Promise<string> => ipcRenderer.invoke(IpcChannels.SETUP_FETCH_LICENSE_TEXT),
  getNoticesText: (): Promise<string> => ipcRenderer.invoke(IpcChannels.SETUP_GET_NOTICES_TEXT),

  // External links & folders
  openLtxApiKeyPage: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.SHELL_OPEN_LTX_API_KEY_PAGE),
  openFalApiKeyPage: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.SHELL_OPEN_FAL_API_KEY_PAGE),
  openParentFolderOfFile: (filePath: string): Promise<void> => ipcRenderer.invoke(IpcChannels.SHELL_OPEN_PARENT_FOLDER, filePath),
  showItemInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke(IpcChannels.SHELL_SHOW_ITEM_IN_FOLDER, filePath),

  // Logs
  getLogs: (): Promise<LogsResponse> => ipcRenderer.invoke(IpcChannels.LOG_GET),
  openLogFolder: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.LOG_OPEN_FOLDER),

  // Resources
  getResourcePath: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.APP_GET_RESOURCE_PATH),

  // Project assets
  copyToProjectAssets: (srcPath: string, projectId: string): Promise<{ success: boolean; path?: string; url?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ASSETS_COPY_TO_PROJECT, srcPath, projectId),
  getProjectAssetsPath: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.ASSETS_GET_PATH),
  openProjectAssetsPathChangeDialog: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ASSETS_CHANGE_PATH_DIALOG),

  // File operations
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.FILE_SHOW_SAVE_DIALOG, options),
  saveFile: (filePath: string, data: string, encoding?: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_SAVE, filePath, data, encoding),
  saveBinaryFile: (filePath: string, data: ArrayBuffer): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_SAVE_BINARY, filePath, data),
  showOpenDirectoryDialog: (options: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.FILE_SHOW_OPEN_DIR_DIALOG, options),
  searchDirectoryForFiles: (dir: string, filenames: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IpcChannels.FILE_SEARCH_DIRECTORY, dir, filenames),
  checkFilesExist: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke(IpcChannels.FILE_CHECK_EXIST, filePaths),
  showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<string[] | null> =>
    ipcRenderer.invoke(IpcChannels.FILE_SHOW_OPEN_FILE_DIALOG, options),

  // Video export
  exportNative: (data: {
    clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[];
    outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
    letterbox?: { ratio: number; color: string; opacity: number };
    subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[];
  }): Promise<{ success?: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.EXPORT_NATIVE, data),
  exportCancel: (sessionId: string): Promise<{ ok?: boolean }> =>
    ipcRenderer.invoke(IpcChannels.EXPORT_CANCEL, sessionId),

  // Python backend
  checkPythonReady: (): Promise<{ ready: boolean }> => ipcRenderer.invoke(IpcChannels.PYTHON_CHECK_READY),
  startPythonSetup: (): Promise<void> => ipcRenderer.invoke(IpcChannels.PYTHON_START_SETUP),
  startPythonBackend: (): Promise<void> => ipcRenderer.invoke(IpcChannels.PYTHON_START_BACKEND),
  getBackendHealthStatus: (): Promise<BackendHealthStatus | null> => ipcRenderer.invoke(IpcChannels.PYTHON_GET_HEALTH_STATUS),
  onPythonSetupProgress: (cb: (data: unknown) => void) => {
    ipcRenderer.on(IpcChannels.PYTHON_SETUP_PROGRESS, (_: unknown, data: unknown) => cb(data))
  },
  removePythonSetupProgress: () => {
    ipcRenderer.removeAllListeners(IpcChannels.PYTHON_SETUP_PROGRESS)
  },
  onBackendHealthStatus: (cb: (data: BackendHealthStatus) => void) => {
    const listener = (_: unknown, data: BackendHealthStatus) => cb(data)
    ipcRenderer.on(IpcChannels.PYTHON_BACKEND_HEALTH_STATUS, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.PYTHON_BACKEND_HEALTH_STATUS, listener)
    }
  },

  // Video frame extraction
  extractVideoFrame: (videoUrl: string, seekTime: number, width?: number, quality?: number): Promise<{ path: string; url: string }> =>
    ipcRenderer.invoke(IpcChannels.VIDEO_EXTRACT_FRAME, videoUrl, seekTime, width, quality),

  // Logging
  writeLog: (level: string, message: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.LOG_WRITE, level, message),

  // Models directory
  openModelsDirChangeDialog: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.MODELS_CHANGE_DIR_DIALOG),

  // Analytics
  getAnalyticsState: (): Promise<{ analyticsEnabled: boolean; installationId: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYTICS_GET_STATE),
  setAnalyticsEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ANALYTICS_SET_ENABLED, enabled),
  sendAnalyticsEvent: (eventName: string, extraDetails?: Record<string, unknown> | null): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ANALYTICS_SEND_EVENT, eventName, extraDetails),

  // Secure storage
  storeSecureKey: (name: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SECURE_STORE_KEY, name, value),
  getSecureKey: (name: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.SECURE_GET_KEY, name),

  // Platform info
  platform: process.platform,
})

export {}
