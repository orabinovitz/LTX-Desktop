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
  
  // Platform info
  platform: process.platform,
})

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getBackendUrl: () => Promise<string>
      getModelsPath: () => Promise<string>
      checkBackendHealth: () => Promise<boolean>
      platform: string
    }
  }
}

export {}
