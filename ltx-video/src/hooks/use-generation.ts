import { useState, useCallback, useRef } from 'react'
import type { GenerationSettings } from '../components/SettingsPanel'

interface GenerationState {
  isGenerating: boolean
  progress: number
  statusMessage: string
  videoUrl: string | null
  error: string | null
}

interface UseGenerationReturn extends GenerationState {
  generate: (prompt: string, image: File | null, settings: GenerationSettings) => Promise<void>
  cancel: () => void
  reset: () => void
}

export function useGeneration(): UseGenerationReturn {
  const [state, setState] = useState<GenerationState>({
    isGenerating: false,
    progress: 0,
    statusMessage: '',
    videoUrl: null,
    error: null,
  })

  const abortControllerRef = useRef<AbortController | null>(null)

  const generate = useCallback(async (
    prompt: string,
    image: File | null,
    settings: GenerationSettings
  ) => {
    // Reset state
    setState({
      isGenerating: true,
      progress: 0,
      statusMessage: 'Generating video...',
      videoUrl: null,
      error: null,
    })

    abortControllerRef.current = new AbortController()

    try {
      // Get backend URL from Electron
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Prepare form data
      const formData = new FormData()
      formData.append('prompt', prompt)
      formData.append('model', settings.model)
      formData.append('duration', String(settings.duration))
      formData.append('resolution', settings.resolution)
      formData.append('fps', String(settings.fps))
      formData.append('audio', String(settings.audio))
      formData.append('camera_motion', settings.cameraMotion)
      
      if (image) {
        formData.append('image', image)
      }

      // Show progress animation while waiting
      const progressInterval = setInterval(() => {
        setState(prev => ({
          ...prev,
          progress: Math.min(prev.progress + 5, 90),
        }))
      }, 300)

      // Start generation (HTTP POST - synchronous, returns when done)
      const response = await fetch(`${backendUrl}/api/generate`, {
        method: 'POST',
        body: formData,
        signal: abortControllerRef.current.signal,
      })

      clearInterval(progressInterval)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Generation failed')
      }

      const result = await response.json()
      
      if (result.status === 'complete' && result.video_path) {
        // Convert Windows path to proper file:// URL
        const videoPath = result.video_path.replace(/\\/g, '/')
        const fileUrl = videoPath.startsWith('/') ? `file://${videoPath}` : `file:///${videoPath}`
        
        setState({
          isGenerating: false,
          progress: 100,
          statusMessage: 'Complete!',
          videoUrl: fileUrl,
          error: null,
        })
      } else if (result.error) {
        throw new Error(result.error)
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setState(prev => ({
          ...prev,
          isGenerating: false,
          statusMessage: 'Cancelled',
        }))
      } else {
        setState(prev => ({
          ...prev,
          isGenerating: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }))
      }
    }
  }, [])

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort()
    setState(prev => ({
      ...prev,
      isGenerating: false,
      statusMessage: 'Cancelled',
    }))
  }, [])

  const reset = useCallback(() => {
    setState({
      isGenerating: false,
      progress: 0,
      statusMessage: '',
      videoUrl: null,
      error: null,
    })
  }, [])

  return {
    ...state,
    generate,
    cancel,
    reset,
  }
}
