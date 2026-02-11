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
  generate: (prompt: string, image: File | null, settings: GenerationSettings) => Promise<void>
  generateImage: (prompt: string, settings: GenerationSettings) => Promise<void>
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
    image: File | null,
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

      // Step 1: Enhance prompt (if enabled) - determine mode based on whether image is provided
      const enhanceMode = image ? 'i2v' : 't2v'
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
            finalPrompt = enhanceResult.enhanced_prompt
            console.log(`Prompt enhanced (${enhanceMode}):`, finalPrompt.substring(0, 100) + '...')
          }
          // If skipped or no enhanced_prompt, use original
        } else {
          // Check for missing API key error
          const errorData = await enhanceResponse.json().catch(() => ({}))
          if (errorData.error === 'GEMINI_API_KEY_MISSING') {
            // Prompt enhancer enabled but no API key - use original prompt
            console.log('Prompt enhancement skipped: no Gemini API key')
          } else {
            console.warn('Prompt enhancement failed, using original:', errorData)
          }
        }
      } catch (enhanceError) {
        // If enhancement fails, continue with original prompt
        console.warn('Prompt enhancement error, using original:', enhanceError)
      }
      
      // Update status for video generation
      const statusMsg = settings.model === 'pro' 
        ? 'Loading Pro model & generating...' 
        : 'Generating video...'
      setState(prev => ({ ...prev, statusMessage: statusMsg }))

      // Prepare form data
      const formData = new FormData()
      formData.append('prompt', finalPrompt)
      formData.append('model', settings.model)
      formData.append('duration', String(settings.duration))
      formData.append('resolution', settings.resolution)
      formData.append('fps', String(settings.fps))
      formData.append('audio', String(settings.audio))
      formData.append('cameraMotion', settings.cameraMotion)
      
      if (image) {
        formData.append('image', image)
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
    cancel,
    reset,
  }
}
