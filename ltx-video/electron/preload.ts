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
      readLocalFile: (filePath: string) => Promise<{ data: string; mimeType: string }>
      platform: string
    }
  }
}

export {}
