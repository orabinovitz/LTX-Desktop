import type { LogEntry } from '../shared/logging'

const { contextBridge, ipcRenderer } = require('electron')

const CH = {
  APP_GET_BACKEND: 'app:get-backend',
  APP_GET_MODELS_PATH: 'app:get-models-path',
  APP_CHECK_GPU: 'app:check-gpu',
  APP_GET_INFO: 'app:get-info',
  APP_GET_RESOURCE_PATH: 'app:get-resource-path',
  SETUP_CHECK_FIRST_RUN: 'setup:check-first-run',
  SETUP_ACCEPT_LICENSE: 'setup:accept-license',
  SETUP_COMPLETE: 'setup:complete',
  SETUP_FETCH_LICENSE_TEXT: 'setup:fetch-license-text',
  SETUP_GET_NOTICES_TEXT: 'setup:get-notices-text',
  PYTHON_CHECK_READY: 'python:check-ready',
  PYTHON_START_SETUP: 'python:start-setup',
  PYTHON_START_BACKEND: 'python:start-backend',
  PYTHON_GET_HEALTH_STATUS: 'python:get-health-status',
  PYTHON_SETUP_PROGRESS: 'python:setup-progress',
  PYTHON_BACKEND_HEALTH_STATUS: 'python:backend-health-status',
  FILE_READ_LOCAL: 'file:read-local',
  FILE_SHOW_SAVE_DIALOG: 'file:show-save-dialog',
  FILE_SAVE: 'file:save',
  FILE_SAVE_BINARY: 'file:save-binary',
  FILE_SHOW_OPEN_DIR_DIALOG: 'file:show-open-dir-dialog',
  FILE_SHOW_OPEN_FILE_DIALOG: 'file:show-open-file-dialog',
  FILE_SEARCH_DIRECTORY: 'file:search-directory',
  FILE_CHECK_EXIST: 'file:check-exist',
  SHELL_OPEN_LTX_API_KEY_PAGE: 'shell:open-ltx-api-key-page',
  SHELL_OPEN_FAL_API_KEY_PAGE: 'shell:open-fal-api-key-page',
  SHELL_OPEN_PARENT_FOLDER: 'shell:open-parent-folder',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  ASSETS_COPY_TO_PROJECT: 'assets:copy-to-project',
  ASSETS_GET_PATH: 'assets:get-path',
  ASSETS_CHANGE_PATH_DIALOG: 'assets:change-path-dialog',
  LOG_WRITE: 'log:write',
  LOG_GET: 'log:get',
  LOG_OPEN_FOLDER: 'log:open-folder',
  VIDEO_EXTRACT_FRAME: 'video:extract-frame',
  EXPORT_NATIVE: 'export:native',
  EXPORT_CANCEL: 'export:cancel',
  MODELS_CHANGE_DIR_DIALOG: 'models:change-dir-dialog',
  ANALYTICS_GET_STATE: 'analytics:get-state',
  ANALYTICS_SET_ENABLED: 'analytics:set-enabled',
  ANALYTICS_SEND_EVENT: 'analytics:send-event',
  SECURE_STORE_KEY: 'secure:store-key',
  SECURE_GET_KEY: 'secure:get-key',
} as const

contextBridge.exposeInMainWorld('electronAPI', {
  getBackend: (): Promise<{ url: string; token: string }> => ipcRenderer.invoke(CH.APP_GET_BACKEND),
  getModelsPath: (): Promise<string> => ipcRenderer.invoke(CH.APP_GET_MODELS_PATH),
  readLocalFile: (filePath: string): Promise<{ data: string; mimeType: string }> =>
    ipcRenderer.invoke(CH.FILE_READ_LOCAL, filePath),
  checkGpu: (): Promise<{ available: boolean; name?: string; vram?: number }> =>
    ipcRenderer.invoke(CH.APP_CHECK_GPU),
  getAppInfo: (): Promise<{ version: string; isPackaged: boolean; modelsPath: string; userDataPath: string }> =>
    ipcRenderer.invoke(CH.APP_GET_INFO),

  // First-run setup
  checkFirstRun: (): Promise<{ needsSetup: boolean; needsLicense: boolean }> => ipcRenderer.invoke(CH.SETUP_CHECK_FIRST_RUN),
  acceptLicense: (): Promise<boolean> => ipcRenderer.invoke(CH.SETUP_ACCEPT_LICENSE),
  completeSetup: (): Promise<boolean> => ipcRenderer.invoke(CH.SETUP_COMPLETE),
  fetchLicenseText: (): Promise<string> => ipcRenderer.invoke(CH.SETUP_FETCH_LICENSE_TEXT),
  getNoticesText: (): Promise<string> => ipcRenderer.invoke(CH.SETUP_GET_NOTICES_TEXT),

  // External links & folders
  openLtxApiKeyPage: (): Promise<boolean> => ipcRenderer.invoke(CH.SHELL_OPEN_LTX_API_KEY_PAGE),
  openFalApiKeyPage: (): Promise<boolean> => ipcRenderer.invoke(CH.SHELL_OPEN_FAL_API_KEY_PAGE),
  openParentFolderOfFile: (filePath: string): Promise<void> => ipcRenderer.invoke(CH.SHELL_OPEN_PARENT_FOLDER, filePath),
  showItemInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke(CH.SHELL_SHOW_ITEM_IN_FOLDER, filePath),

  // Logs
  getLogs: (options?: { limit?: number }): Promise<LogsResponse> => ipcRenderer.invoke(CH.LOG_GET, options),
  openLogFolder: (): Promise<boolean> => ipcRenderer.invoke(CH.LOG_OPEN_FOLDER),

  // Resources
  getResourcePath: (): Promise<string | null> => ipcRenderer.invoke(CH.APP_GET_RESOURCE_PATH),

  // Project assets
  copyToProjectAssets: (srcPath: string, projectId: string): Promise<{ success: boolean; path?: string; url?: string; error?: string }> =>
    ipcRenderer.invoke(CH.ASSETS_COPY_TO_PROJECT, srcPath, projectId),
  getProjectAssetsPath: (): Promise<string> =>
    ipcRenderer.invoke(CH.ASSETS_GET_PATH),
  openProjectAssetsPathChangeDialog: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(CH.ASSETS_CHANGE_PATH_DIALOG),

  // File operations
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
    ipcRenderer.invoke(CH.FILE_SHOW_SAVE_DIALOG, options),
  saveFile: (filePath: string, data: string, encoding?: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(CH.FILE_SAVE, filePath, data, encoding),
  saveBinaryFile: (filePath: string, data: ArrayBuffer): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(CH.FILE_SAVE_BINARY, filePath, data),
  showOpenDirectoryDialog: (options: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke(CH.FILE_SHOW_OPEN_DIR_DIALOG, options),
  searchDirectoryForFiles: (dir: string, filenames: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke(CH.FILE_SEARCH_DIRECTORY, dir, filenames),
  checkFilesExist: (filePaths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke(CH.FILE_CHECK_EXIST, filePaths),
  showOpenFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<string[] | null> =>
    ipcRenderer.invoke(CH.FILE_SHOW_OPEN_FILE_DIALOG, options),

  // Video export
  exportNative: (data: {
    clips: { url: string; type: string; startTime: number; duration: number; trimStart: number; speed: number; reversed: boolean; flipH: boolean; flipV: boolean; opacity: number; trackIndex: number; muted: boolean; volume: number }[];
    outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
    letterbox?: { ratio: number; color: string; opacity: number };
    subtitles?: { text: string; startTime: number; endTime: number; style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean } }[];
  }): Promise<{ success?: boolean; error?: string }> =>
    ipcRenderer.invoke(CH.EXPORT_NATIVE, data),
  exportCancel: (sessionId: string): Promise<{ ok?: boolean }> =>
    ipcRenderer.invoke(CH.EXPORT_CANCEL, sessionId),

  // Python backend
  checkPythonReady: (): Promise<{ ready: boolean }> => ipcRenderer.invoke(CH.PYTHON_CHECK_READY),
  startPythonSetup: (): Promise<void> => ipcRenderer.invoke(CH.PYTHON_START_SETUP),
  startPythonBackend: (): Promise<void> => ipcRenderer.invoke(CH.PYTHON_START_BACKEND),
  getBackendHealthStatus: (): Promise<BackendHealthStatus | null> => ipcRenderer.invoke(CH.PYTHON_GET_HEALTH_STATUS),
  onPythonSetupProgress: (cb: (data: unknown) => void) => {
    ipcRenderer.on(CH.PYTHON_SETUP_PROGRESS, (_: unknown, data: unknown) => cb(data))
  },
  removePythonSetupProgress: () => {
    ipcRenderer.removeAllListeners(CH.PYTHON_SETUP_PROGRESS)
  },
  onBackendHealthStatus: (cb: (data: BackendHealthStatus) => void) => {
    const listener = (_: unknown, data: BackendHealthStatus) => cb(data)
    ipcRenderer.on(CH.PYTHON_BACKEND_HEALTH_STATUS, listener)
    return () => {
      ipcRenderer.removeListener(CH.PYTHON_BACKEND_HEALTH_STATUS, listener)
    }
  },

  // Video frame extraction
  extractVideoFrame: (videoUrl: string, seekTime: number, width?: number, quality?: number): Promise<{ path: string; url: string }> =>
    ipcRenderer.invoke(CH.VIDEO_EXTRACT_FRAME, videoUrl, seekTime, width, quality),

  // Logging
  writeLog: (entry: LogEntry): Promise<void> =>
    ipcRenderer.invoke(CH.LOG_WRITE, entry),

  // Models directory
  openModelsDirChangeDialog: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(CH.MODELS_CHANGE_DIR_DIALOG),

  // Analytics
  getAnalyticsState: (): Promise<{ analyticsEnabled: boolean; installationId: string }> =>
    ipcRenderer.invoke(CH.ANALYTICS_GET_STATE),
  setAnalyticsEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(CH.ANALYTICS_SET_ENABLED, enabled),
  sendAnalyticsEvent: (eventName: string, extraDetails?: Record<string, unknown> | null): Promise<void> =>
    ipcRenderer.invoke(CH.ANALYTICS_SEND_EVENT, eventName, extraDetails),

  // Secure storage
  storeSecureKey: (name: string, value: string): Promise<void> =>
    ipcRenderer.invoke(CH.SECURE_STORE_KEY, name, value),
  getSecureKey: (name: string): Promise<string> =>
    ipcRenderer.invoke(CH.SECURE_GET_KEY, name),

  // Platform info
  platform: process.platform,
})

export {}
