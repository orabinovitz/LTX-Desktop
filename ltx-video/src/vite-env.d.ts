/// <reference types="vite/client" />

interface Window {
  electronAPI: {
    getBackendUrl: () => Promise<string>
    getModelsPath: () => Promise<string>
    checkBackendHealth: () => Promise<boolean>
    platform: string
  }
}
