import { useState, useEffect, useCallback } from 'react'

interface BackendStatus {
  connected: boolean
  modelsLoaded: boolean
  gpuInfo: {
    name: string
    vram: number
    vramUsed: number
  } | null
}

interface ModelStatus {
  id: string
  name: string
  size: number
  downloaded: boolean
  downloadProgress: number
}

interface UseBackendReturn {
  status: BackendStatus
  models: ModelStatus[]
  isLoading: boolean
  error: string | null
  checkHealth: () => Promise<boolean>
  downloadModel: (modelId: string) => Promise<void>
}

export function useBackend(): UseBackendReturn {
  const [status, setStatus] = useState<BackendStatus>({
    connected: false,
    modelsLoaded: false,
    gpuInfo: null,
  })
  const [models, setModels] = useState<ModelStatus[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      console.log('Checking backend health at:', backendUrl)
      const response = await fetch(`${backendUrl}/health`)
      
      if (response.ok) {
        const data = await response.json()
        console.log('Backend health:', data)
        setStatus({
          connected: true,
          modelsLoaded: data.models_loaded,
          gpuInfo: data.gpu_info,
        })
        return true
      }
      console.warn('Backend health check failed with status:', response.status)
      return false
    } catch (err) {
      console.error('Backend health check error:', err)
      setStatus(prev => ({ ...prev, connected: false }))
      return false
    }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const response = await fetch(`${backendUrl}/api/models`)
      
      if (response.ok) {
        const data = await response.json()
        setModels(data.models)
      }
    } catch (err) {
      console.error('Failed to fetch models:', err)
    }
  }, [])

  const downloadModel = useCallback(async (modelId: string) => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      
      // Connect to WebSocket for download progress
      const wsUrl = backendUrl.replace('http://', 'ws://') + `/ws/download/${modelId}`
      const ws = new WebSocket(wsUrl)

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'progress') {
          setModels(prev => prev.map(m => 
            m.id === modelId 
              ? { ...m, downloadProgress: data.progress }
              : m
          ))
        } else if (data.type === 'complete') {
          setModels(prev => prev.map(m => 
            m.id === modelId 
              ? { ...m, downloaded: true, downloadProgress: 100 }
              : m
          ))
        }
      }

      // Trigger download
      await fetch(`${backendUrl}/api/models/${modelId}/download`, {
        method: 'POST',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }, [])

  // Initial health check and polling
  useEffect(() => {
    let intervalId: NodeJS.Timeout
    let cancelled = false

    const init = async () => {
      console.log('Starting backend connection...')
      setIsLoading(true)
      
      // Poll for backend connection (up to 5 minutes for model loading)
      const maxAttempts = 300  // 5 minutes at 1 second intervals
      let attempts = 0
      let connected = false
      
      while (attempts < maxAttempts && !cancelled) {
        try {
          const healthy = await checkHealth()
          console.log(`Health check attempt ${attempts + 1}: ${healthy}`)
          if (healthy) {
            connected = true
            try {
              await fetchModels()
            } catch (e) {
              console.warn('Failed to fetch models:', e)
            }
            break
          }
        } catch (e) {
          console.warn('Health check failed:', e)
        }
        attempts++
        await new Promise(r => setTimeout(r, 1000))
      }

      if (!cancelled) {
        if (!connected && attempts >= maxAttempts) {
          setError('Failed to connect to backend after 5 minutes')
        }
        console.log('Setting isLoading to false, connected:', connected)
        setIsLoading(false)

        // Continue polling every 5 seconds
        intervalId = setInterval(checkHealth, 5000)
      }
    }

    init()

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [checkHealth, fetchModels])

  return {
    status,
    models,
    isLoading,
    error,
    checkHealth,
    downloadModel,
  }
}
