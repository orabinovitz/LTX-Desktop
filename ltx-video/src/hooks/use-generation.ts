import { useState, useCallback, useRef } from 'react'
import type { GenerationSettings } from '../components/SettingsPanel'

interface GenerationState {
  isGenerating: boolean
  progress: number
  statusMessage: string
  videoUrl: string | null
  videoPath: string | null  // Original file path for upscaling
  imageUrl: string | null
  imageUrls: string[]  // For multiple image variations
  error: string | null
}

interface GenerationProgress {
  status: string
  phase: string
  progress: number
  currentStep: number
  totalSteps: number
}

interface UseGenerationReturn extends GenerationState {
  generate: (prompt: string, imagePath: string | null, settings: GenerationSettings) => Promise<void>
  generateImage: (prompt: string, settings: GenerationSettings) => Promise<void>
  editImage: (prompt: string, inputImages: File[], settings: GenerationSettings) => Promise<void>
  cancel: () => void
  reset: () => void
}

// Map phase to user-friendly message
function getPhaseMessage(phase: string, _currentStep: number, totalSteps: number): string {
  switch (phase) {
    case 'loading_model':
      return 'Loading model...'
    case 'encoding_text':
      return 'Encoding prompt...'
    case 'inference':
      return totalSteps > 0 ? `Generating (${totalSteps} steps)...` : 'Generating...'
    case 'decoding':
      return 'Decoding video...'
    case 'complete':
      return 'Complete!'
    default:
      return 'Generating...'
  }
}

export function useGeneration(): UseGenerationReturn {
  const [state, setState] = useState<GenerationState>({
    isGenerating: false,
    progress: 0,
    statusMessage: '',
    videoUrl: null,
    videoPath: null,
    imageUrl: null,
    imageUrls: [],
    error: null,
  })

  const abortControllerRef = useRef<AbortController | null>(null)

  const generate = useCallback(async (
    prompt: string,
    imagePath: string | null,
    settings: GenerationSettings
  ) => {
    // Reset state - show different message if using Pro model (may need to load)
    setState({
      isGenerating: true,
      progress: 0,
      statusMessage: 'Enhancing prompt...',
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
    })

    abortControllerRef.current = new AbortController()

    try {
      // Get backend URL from Electron
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Step 1: Enhance prompt (if enabled — backend checks per-mode setting)
      const enhanceMode = imagePath ? 'i2v' : 't2v'
      let finalPrompt = prompt
      try {
        const enhanceResponse = await fetch(`${backendUrl}/api/enhance-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, mode: enhanceMode }),
          signal: abortControllerRef.current.signal,
        })
        
        if (enhanceResponse.ok) {
          const enhanceResult = await enhanceResponse.json()
          if (enhanceResult.status === 'success' && enhanceResult.enhanced_prompt) {
            if (enhanceResult.skipped) {
              console.log(`Prompt enhancement skipped (${enhanceMode}): ${enhanceResult.reason}`)
            } else {
              finalPrompt = enhanceResult.enhanced_prompt
              console.log(`Prompt enhanced (${enhanceMode}):`, finalPrompt.substring(0, 100) + '...')
            }
          }
        } else {
          const errorData = await enhanceResponse.json().catch(() => ({}))
          if (errorData.error === 'GEMINI_API_KEY_MISSING') {
            console.log('Prompt enhancement skipped: no Gemini API key')
          } else {
            console.warn('Prompt enhancement failed, using original:', errorData)
          }
        }
      } catch (enhanceError) {
        console.warn('Prompt enhancement error, using original:', enhanceError)
      }
      
      // Update status for video generation
      const statusMsg = settings.model === 'pro' 
        ? 'Loading Pro model & generating...' 
        : 'Generating video...'
      setState(prev => ({ ...prev, statusMessage: statusMsg }))

      // Prepare JSON body
      const body: Record<string, unknown> = {
        prompt: finalPrompt,
        model: settings.model,
        duration: String(settings.duration),
        resolution: settings.resolution,
        fps: String(settings.fps),
        audio: String(settings.audio),
        cameraMotion: settings.cameraMotion,
      }
      if (imagePath) {
        body.imagePath = imagePath
      }

      // Poll for real progress from backend with time-based interpolation
      let lastPhase = ''
      let inferenceStartTime = 0
      // Estimated inference time in seconds based on model
      const estimatedInferenceTime = settings.model === 'pro' ? 120 : 45
      
      const pollProgress = async () => {
        try {
          const res = await fetch(`${backendUrl}/api/generation/progress`)
          if (res.ok) {
            const data: GenerationProgress = await res.json()
            
            let displayProgress = data.progress
            
            // Time-based interpolation during inference phase
            if (data.phase === 'inference') {
              if (lastPhase !== 'inference') {
                inferenceStartTime = Date.now()
              }
              const elapsed = (Date.now() - inferenceStartTime) / 1000
              // Interpolate from 15% to 95% based on estimated time
              const inferenceProgress = Math.min(elapsed / estimatedInferenceTime, 0.95)
              displayProgress = 15 + Math.floor(inferenceProgress * 80)
            }
            
            lastPhase = data.phase
            
            setState(prev => ({
              ...prev,
              progress: displayProgress,
              statusMessage: getPhaseMessage(data.phase, data.currentStep, data.totalSteps),
            }))
          }
        } catch {
          // Ignore polling errors
        }
      }
      
      const progressInterval = setInterval(pollProgress, 500)

      // Start generation (HTTP POST - synchronous, returns when done)
      const response = await fetch(`${backendUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        const videoPathNormalized = result.video_path.replace(/\\/g, '/')
        const fileUrl = videoPathNormalized.startsWith('/') ? `file://${videoPathNormalized}` : `file:///${videoPathNormalized}`
        
        setState({
          isGenerating: false,
          progress: 100,
          statusMessage: 'Complete!',
          videoUrl: fileUrl,
          videoPath: result.video_path,  // Keep original path for API calls
          imageUrl: null,
          imageUrls: [],
          error: null,
        })
      } else if (result.status === 'cancelled') {
        setState(prev => ({
          ...prev,
          isGenerating: false,
          statusMessage: 'Cancelled',
        }))
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

  const cancel = useCallback(async () => {
    // Abort the fetch request
    abortControllerRef.current?.abort()
    
    // Also tell the backend to cancel
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      await fetch(`${backendUrl}/api/generate/cancel`, {
        method: 'POST',
      })
    } catch (e) {
      // Ignore errors from cancel request
    }
    
    setState(prev => ({
      ...prev,
      isGenerating: false,
      statusMessage: 'Cancelled',
    }))
  }, [])

  const generateImage = useCallback(async (
    prompt: string,
    settings: GenerationSettings
  ) => {
    const numImages = settings.variations || 1
    
    setState({
      isGenerating: true,
      progress: 0,
      statusMessage: numImages > 1 ? `Generating ${numImages} images...` : 'Generating image...',
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
    })

    abortControllerRef.current = new AbortController()

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Skip prompt enhancement for T2I - use original prompt directly
      const finalPrompt = prompt

      // Aspect ratio to dimensions mapping for images (base size ~1024px on short side)
      const aspectRatioMap: Record<string, { width: number; height: number }> = {
        '1:1': { width: 1024, height: 1024 },
        '16:9': { width: 1280, height: 720 },
        '9:16': { width: 720, height: 1280 },
        '4:3': { width: 1024, height: 768 },
        '3:4': { width: 768, height: 1024 },
        '21:9': { width: 1344, height: 576 },
      }
      const dims = aspectRatioMap[settings.imageAspectRatio || '16:9'] || { width: 1280, height: 720 }
      const numSteps = settings.imageSteps || 4

      // Poll for progress
      const pollProgress = async () => {
        try {
          const res = await fetch(`${backendUrl}/api/generation/progress`)
          if (res.ok) {
            const data = await res.json()
            const currentImage = data.currentStep || 0
            const totalImages = data.totalSteps || numImages
            setState(prev => ({
              ...prev,
              progress: data.progress,
              statusMessage: data.phase === 'loading_model' 
                ? 'Loading Flux model...' 
                : data.phase === 'inference'
                  ? numImages > 1 
                    ? `Generating image ${currentImage + 1}/${totalImages}...`
                    : 'Generating image...'
                  : data.phase === 'complete'
                    ? 'Complete!'
                    : 'Generating...',
            }))
          }
        } catch {
          // Ignore polling errors
        }
      }
      
      const progressInterval = setInterval(pollProgress, 500)

      const response = await fetch(`${backendUrl}/api/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          width: dims.width,
          height: dims.height,
          numSteps,
          numImages,
        }),
        signal: abortControllerRef.current.signal,
      })

      clearInterval(progressInterval)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Image generation failed')
      }

      const result = await response.json()
      
      if (result.status === 'complete') {
        // Handle both new format (image_paths array) and old format (single image_path)
        let rawPaths: string[] = []
        if (result.image_paths && Array.isArray(result.image_paths)) {
          rawPaths = result.image_paths
        } else if (result.image_path) {
          rawPaths = [result.image_path]
        }
        
        if (rawPaths.length > 0) {
          // Convert all paths to file URLs
          const fileUrls = rawPaths.map((path: string) => {
            const imagePath = path.replace(/\\/g, '/')
            return imagePath.startsWith('/') ? `file://${imagePath}` : `file:///${imagePath}`
          })
          
          setState({
            isGenerating: false,
            progress: 100,
            statusMessage: 'Complete!',
            videoUrl: null,
            videoPath: null,
            imageUrl: fileUrls[0],  // First image for backwards compatibility
            imageUrls: fileUrls,    // All images
            error: null,
          })
        }
      } else if (result.status === 'cancelled') {
        setState(prev => ({
          ...prev,
          isGenerating: false,
          statusMessage: 'Cancelled',
        }))
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

  const editImage = useCallback(async (
    prompt: string,
    inputImages: File[],
    settings: GenerationSettings
  ) => {
    if (inputImages.length === 0) return

    setState({
      isGenerating: true,
      progress: 0,
      statusMessage: 'Editing image...',
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
    })

    abortControllerRef.current = new AbortController()

    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Aspect ratio to dimensions mapping
      const aspectRatioMap: Record<string, { width: number; height: number }> = {
        '1:1': { width: 1024, height: 1024 },
        '16:9': { width: 1280, height: 720 },
        '9:16': { width: 720, height: 1280 },
        '4:3': { width: 1024, height: 768 },
        '3:4': { width: 768, height: 1024 },
      }
      const dims = aspectRatioMap[settings.imageAspectRatio || '16:9'] || { width: 1280, height: 720 }
      const numSteps = settings.imageSteps || 4

      // Poll for progress
      const pollProgress = async () => {
        try {
          const res = await fetch(`${backendUrl}/api/generation/progress`)
          if (res.ok) {
            const data = await res.json()
            setState(prev => ({
              ...prev,
              progress: data.progress,
              statusMessage: data.phase === 'loading_model'
                ? 'Loading Flux model...'
                : data.phase === 'inference'
                  ? 'Editing image...'
                  : data.phase === 'complete'
                    ? 'Complete!'
                    : 'Processing...',
            }))
          }
        } catch {
          // Ignore polling errors
        }
      }

      const progressInterval = setInterval(pollProgress, 500)

      // Build multipart form data
      const formData = new FormData()
      formData.append('prompt', prompt)
      formData.append('width', String(dims.width))
      formData.append('height', String(dims.height))
      formData.append('numSteps', String(numSteps))

      // Attach input images
      formData.append('image', inputImages[0])
      for (let i = 1; i < inputImages.length; i++) {
        formData.append(`image${i + 1}`, inputImages[i])
      }

      const response = await fetch(`${backendUrl}/api/edit-image`, {
        method: 'POST',
        body: formData,
        signal: abortControllerRef.current.signal,
      })

      clearInterval(progressInterval)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || 'Image editing failed')
      }

      const result = await response.json()

      if (result.status === 'complete') {
        let rawPaths: string[] = []
        if (result.image_paths && Array.isArray(result.image_paths)) {
          rawPaths = result.image_paths
        } else if (result.image_path) {
          rawPaths = [result.image_path]
        }

        if (rawPaths.length > 0) {
          const fileUrls = rawPaths.map((path: string) => {
            const imagePath = path.replace(/\\/g, '/')
            return imagePath.startsWith('/') ? `file://${imagePath}` : `file:///${imagePath}`
          })

          setState({
            isGenerating: false,
            progress: 100,
            statusMessage: 'Complete!',
            videoUrl: null,
            videoPath: null,
            imageUrl: fileUrls[0],
            imageUrls: fileUrls,
            error: null,
          })
        }
      } else if (result.status === 'cancelled') {
        setState(prev => ({
          ...prev,
          isGenerating: false,
          statusMessage: 'Cancelled',
        }))
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

  const reset = useCallback(() => {
    setState({
      isGenerating: false,
      progress: 0,
      statusMessage: '',
      videoUrl: null,
      videoPath: null,
      imageUrl: null,
      imageUrls: [],
      error: null,
    })
  }, [])

  return {
    ...state,
    generate,
    generateImage,
    editImage,
    cancel,
    reset,
  }
}
