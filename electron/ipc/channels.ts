export const IpcChannels = {
  // App lifecycle & info
  APP_GET_BACKEND: 'app:get-backend',
  APP_GET_MODELS_PATH: 'app:get-models-path',
  APP_CHECK_GPU: 'app:check-gpu',
  APP_GET_INFO: 'app:get-info',
  APP_GET_RESOURCE_PATH: 'app:get-resource-path',

  // First-run setup
  SETUP_CHECK_FIRST_RUN: 'setup:check-first-run',
  SETUP_ACCEPT_LICENSE: 'setup:accept-license',
  SETUP_COMPLETE: 'setup:complete',
  SETUP_FETCH_LICENSE_TEXT: 'setup:fetch-license-text',
  SETUP_GET_NOTICES_TEXT: 'setup:get-notices-text',

  // Python backend
  PYTHON_CHECK_READY: 'python:check-ready',
  PYTHON_START_SETUP: 'python:start-setup',
  PYTHON_START_BACKEND: 'python:start-backend',
  PYTHON_GET_HEALTH_STATUS: 'python:get-health-status',
  PYTHON_SETUP_PROGRESS: 'python:setup-progress',
  PYTHON_UPDATE_PROGRESS: 'python:update-progress',
  PYTHON_BACKEND_HEALTH_STATUS: 'python:backend-health-status',

  // File operations
  FILE_READ_LOCAL: 'file:read-local',
  FILE_SHOW_SAVE_DIALOG: 'file:show-save-dialog',
  FILE_SAVE: 'file:save',
  FILE_SAVE_BINARY: 'file:save-binary',
  FILE_SHOW_OPEN_DIR_DIALOG: 'file:show-open-dir-dialog',
  FILE_SHOW_OPEN_FILE_DIALOG: 'file:show-open-file-dialog',
  FILE_SEARCH_DIRECTORY: 'file:search-directory',
  FILE_CHECK_EXIST: 'file:check-exist',

  // External links & folders
  SHELL_OPEN_LTX_API_KEY_PAGE: 'shell:open-ltx-api-key-page',
  SHELL_OPEN_FAL_API_KEY_PAGE: 'shell:open-fal-api-key-page',
  SHELL_OPEN_PARENT_FOLDER: 'shell:open-parent-folder',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',

  // Project assets
  ASSETS_COPY_TO_PROJECT: 'assets:copy-to-project',
  ASSETS_GET_PATH: 'assets:get-path',
  ASSETS_CHANGE_PATH_DIALOG: 'assets:change-path-dialog',

  // Logs
  LOG_WRITE: 'log:write',
  LOG_GET: 'log:get',
  LOG_OPEN_FOLDER: 'log:open-folder',

  // Video processing
  VIDEO_EXTRACT_FRAME: 'video:extract-frame',

  // Export
  EXPORT_NATIVE: 'export:native',
  EXPORT_CANCEL: 'export:cancel',

  // Models directory
  MODELS_CHANGE_DIR_DIALOG: 'models:change-dir-dialog',

  // Analytics
  ANALYTICS_GET_STATE: 'analytics:get-state',
  ANALYTICS_SET_ENABLED: 'analytics:set-enabled',
  ANALYTICS_SEND_EVENT: 'analytics:send-event',

  // Secure storage
  SECURE_STORE_KEY: 'secure:store-key',
  SECURE_GET_KEY: 'secure:get-key',
} as const

export type IpcChannel = typeof IpcChannels[keyof typeof IpcChannels]
