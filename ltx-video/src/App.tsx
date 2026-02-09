import { useState, useEffect, useRef } from 'react'
import { Sparkles, Trash2, AlertCircle, Loader2, Square, Settings, ImageIcon, FileText } from 'lucide-react'
import { ImageUploader } from './components/ImageUploader'
import { VideoPlayer } from './components/VideoPlayer'
import { ImageResult } from './components/ImageResult'
import { SettingsPanel, type GenerationSettings } from './components/SettingsPanel'
import { SettingsModal, type AppSettings } from './components/SettingsModal'
import { ModeTabs, type GenerationMode } from './components/ModeTabs'
import { FirstRunSetup } from './components/FirstRunSetup'
import { LtxLogo } from './components/LtxLogo'
import { ModelStatusDropdown } from './components/ModelStatusDropdown'
import { LogViewer } from './components/LogViewer'
import { Textarea } from './components/ui/textarea'
import { Button } from './components/ui/button'
import { useGeneration } from './hooks/use-generation'
import { useBackend } from './hooks/use-backend'

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'fast',
  duration: 5,
  resolution: '540p',
  fps: 24,
  audio: false,
  cameraMotion: 'none',
  // Image settings
  imageAspectRatio: '16:9',
  imageSteps: 4,
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  keepModelsLoaded: true, // Models always stay cached for fast generation
  useTorchCompile: false, // Disabled by default - can cause long compile times
  loadOnStartup: false, // Lazy loading - models load on first generation
  ltxApiKey: '', // LTX API key for fast text encoding
  useLocalTextEncoder: false, // Use LTX API by default (faster, requires key)
  fastModel: { steps: 8, useUpscaler: true },
  proModel: { steps: 20, useUpscaler: true },
  promptCacheSize: 100, // Cache up to 100 prompt embeddings to skip API calls
  // Prompt Enhancer settings
  promptEnhancerEnabled: true, // Prompt enhancer on by default
  geminiApiKey: '', // Gemini API key for prompt enhancement
  t2vSystemPrompt: '', // Empty means use default (stored in backend)
  i2vSystemPrompt: '', // Empty means use default (stored in backend)
  // Seed settings
  seedLocked: false, // Random seed by default
  lockedSeed: 42, // Default seed value when locked
}

export default function App() {
  const [mode, setMode] = useState<GenerationMode>('text-to-video')
  const [prompt, setPrompt] = useState('')
  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)  // Track if settings have been loaded
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false)
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null)

  const { status, isLoading: backendLoading, error: backendError } = useBackend()

  // Check for first run
  useEffect(() => {
    const checkFirstRun = async () => {
      try {
        const firstRun = await window.electronAPI.checkFirstRun()
        setIsFirstRun(firstRun)
      } catch (e) {
        console.error('Failed to check first run:', e)
        setIsFirstRun(false)
      }
    }
    checkFirstRun()
  }, [])
  
  // Fetch initial settings from backend
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const response = await fetch(`${backendUrl}/api/settings`)
        if (response.ok) {
          const data = await response.json()
          setAppSettings({
            keepModelsLoaded: data.keepModelsLoaded ?? DEFAULT_APP_SETTINGS.keepModelsLoaded,
            useTorchCompile: data.useTorchCompile ?? DEFAULT_APP_SETTINGS.useTorchCompile,
            loadOnStartup: data.loadOnStartup ?? DEFAULT_APP_SETTINGS.loadOnStartup,
            ltxApiKey: data.ltxApiKey ?? DEFAULT_APP_SETTINGS.ltxApiKey,
            useLocalTextEncoder: data.useLocalTextEncoder ?? DEFAULT_APP_SETTINGS.useLocalTextEncoder,
            fastModel: data.fastModel ?? DEFAULT_APP_SETTINGS.fastModel,
            proModel: data.proModel ?? DEFAULT_APP_SETTINGS.proModel,
            promptCacheSize: data.promptCacheSize ?? DEFAULT_APP_SETTINGS.promptCacheSize,
            // Prompt Enhancer settings
            promptEnhancerEnabled: data.promptEnhancerEnabled ?? DEFAULT_APP_SETTINGS.promptEnhancerEnabled,
            geminiApiKey: data.geminiApiKey ?? DEFAULT_APP_SETTINGS.geminiApiKey,
            t2vSystemPrompt: data.t2vSystemPrompt ?? DEFAULT_APP_SETTINGS.t2vSystemPrompt,
            i2vSystemPrompt: data.i2vSystemPrompt ?? DEFAULT_APP_SETTINGS.i2vSystemPrompt,
            // Seed settings
            seedLocked: data.seedLocked ?? DEFAULT_APP_SETTINGS.seedLocked,
            lockedSeed: data.lockedSeed ?? DEFAULT_APP_SETTINGS.lockedSeed,
          })
        }
      } catch (e) {
        console.error('Failed to fetch settings:', e)
      } finally {
        // Mark settings as loaded (even if fetch failed, we can now sync)
        setSettingsLoaded(true)
      }
    }
    fetchSettings()
  }, [])
  
  // Sync app settings with backend (only after initial load)
  useEffect(() => {
    // Don't sync until we've loaded settings from backend first
    if (!settingsLoaded) return
    
    const syncSettings = async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        await fetch(`${backendUrl}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            keepModelsLoaded: appSettings.keepModelsLoaded,
            useTorchCompile: appSettings.useTorchCompile,
            loadOnStartup: appSettings.loadOnStartup,
            ltxApiKey: appSettings.ltxApiKey,
            useLocalTextEncoder: appSettings.useLocalTextEncoder,
            fastModel: appSettings.fastModel,
            proModel: appSettings.proModel,
            promptCacheSize: appSettings.promptCacheSize,
            // Prompt Enhancer settings
            promptEnhancerEnabled: appSettings.promptEnhancerEnabled,
            geminiApiKey: appSettings.geminiApiKey,
            t2vSystemPrompt: appSettings.t2vSystemPrompt,
            i2vSystemPrompt: appSettings.i2vSystemPrompt,
            // Seed settings
            seedLocked: appSettings.seedLocked,
            lockedSeed: appSettings.lockedSeed,
          }),
        })
      } catch (e) {
        console.error('Failed to sync settings:', e)
      }
    }
    syncSettings()
  }, [appSettings, settingsLoaded])
  
  // Handle mode change
  const handleModeChange = (newMode: GenerationMode) => {
    setMode(newMode)
    if (newMode === 'text-to-video') {
      setSelectedImage(null) // Clear image when switching to T2V
    }
  }
  const { 
    isGenerating, 
    progress, 
    statusMessage, 
    videoUrl,
    videoPath,
    imageUrl, 
    error: generationError,
    generate,
    generateImage,
    cancel,
    reset,
  } = useGeneration()
  
  // Ref to store generated image URL for "Create video" flow
  const generatedImageRef = useRef<string | null>(null)

  const handleGenerate = () => {
    if (mode === 'text-to-image') {
      if (!prompt.trim()) return
      generateImage(prompt, settings)
    } else {
      if (!prompt.trim() && !selectedImage) return
      generate(prompt, selectedImage, settings)
    }
  }
  
  // Handle "Create video" from generated image
  const handleCreateVideoFromImage = async () => {
    if (!imageUrl) {
      console.error('No image URL available')
      return
    }
    
    try {
      // Read the local file via Electron IPC
      const { data, mimeType } = await window.electronAPI.readLocalFile(imageUrl)
      
      // Convert base64 to Blob then File
      const byteCharacters = atob(data)
      const byteNumbers = new Array(byteCharacters.length)
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
      }
      const byteArray = new Uint8Array(byteNumbers)
      const blob = new Blob([byteArray], { type: mimeType })
      const file = new File([blob], 'generated-image.png', { type: mimeType })
      
      // Switch to image-to-video mode with the generated image
      setSelectedImage(file)
      setMode('image-to-video')
      
      // Store the image URL for reference
      generatedImageRef.current = imageUrl
    } catch (error) {
      console.error('Failed to prepare image for video:', error)
    }
  }

  const handleClearAll = () => {
    setPrompt('')
    setSelectedImage(null)
    setSettings(DEFAULT_SETTINGS)
    setMode('text-to-video')
    reset()
  }

  // Check if models are warmed up and ready
  const isWarmingUp = status.warmup.status !== 'ready' && status.warmup.status !== 'error'
  
  // For T2V: prompt is required
  // For I2V: image is required, prompt is optional
  // For T2I: prompt is required
  const canGenerate = status.connected && !isGenerating && !isWarmingUp && (
    (mode === 'text-to-video' && prompt.trim()) ||
    (mode === 'image-to-video' && selectedImage) ||
    (mode === 'text-to-image' && prompt.trim())
  )

  // Show loading while checking first run
  if (isFirstRun === null) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 text-primary animate-spin" />
      </div>
    )
  }

  // Show first run setup
  if (isFirstRun) {
    return <FirstRunSetup onComplete={() => setIsFirstRun(false)} />
  }

  // Show loading screen while connecting to backend
  if (backendLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 text-primary animate-spin mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Starting LTX Video...</h2>
          <p className="text-muted-foreground">Initializing the inference engine</p>
        </div>
      </div>
    )
  }

  // Show error screen if backend failed
  if (backendError && !status.connected) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Connection Failed</h2>
          <p className="text-muted-foreground mb-4">{backendError}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <LtxLogo className="h-5 w-auto text-white" />
          <ModeTabs 
            mode={mode} 
            onModeChange={handleModeChange}
            disabled={isGenerating || isWarmingUp}
          />
        </div>
        
        <div className="flex items-center gap-4">
          {/* Model Status Dropdown */}
          <ModelStatusDropdown warmupStatus={status.warmup} />
          
          {/* GPU Info */}
          {status.gpuInfo && (
            <div className="text-sm text-zinc-500">
              {status.gpuInfo.name} ({(status.gpuInfo.vramUsed / 1024).toFixed(1)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB)
            </div>
          )}
          
          {/* Logs Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsLogViewerOpen(true)}
            className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
            title="View Backend Logs"
          >
            <FileText className="h-4 w-4" />
          </Button>
          
          {/* Settings Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsSettingsOpen(true)}
            className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>
      
      {/* Log Viewer Modal */}
      <LogViewer isOpen={isLogViewerOpen} onClose={() => setIsLogViewerOpen(false)} />

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel - Controls */}
        <div className="w-[500px] border-r border-zinc-800 p-6 overflow-y-auto">
          <div className="space-y-6">
            {/* Image Upload - Only shown in I2V mode */}
            {mode === 'image-to-video' && (
              <ImageUploader 
                selectedImage={selectedImage}
                onImageSelect={setSelectedImage}
              />
            )}

            {/* Prompt Input */}
            <Textarea
              label="Prompt"
              placeholder="Write a prompt..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              helperText="Longer, detailed prompts lead to better, more accurate results."
              charCount={prompt.length}
              maxChars={5000}
              disabled={isGenerating}
            />

            {/* Settings */}
            <SettingsPanel
              settings={settings}
              onSettingsChange={setSettings}
              disabled={isGenerating}
              mode={mode}
            />

            {/* Error Display */}
            {generationError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm">
                {generationError.includes('TEXT_ENCODING_NOT_CONFIGURED') ? (
                  <div className="space-y-2">
                    <p className="text-red-400 font-medium">Text encoding not configured</p>
                    <p className="text-red-400/80">
                      To generate videos, you need to set up text encoding in Settings.
                    </p>
                    <button
                      onClick={() => setIsSettingsOpen(true)}
                      className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-xs font-medium transition-colors"
                    >
                      Open Settings
                    </button>
                  </div>
                ) : generationError.includes('TEXT_ENCODER_NOT_DOWNLOADED') ? (
                  <div className="space-y-2">
                    <p className="text-red-400 font-medium">Text encoder not downloaded</p>
                    <p className="text-red-400/80">
                      The local text encoder needs to be downloaded (~8 GB).
                    </p>
                    <button
                      onClick={() => setIsSettingsOpen(true)}
                      className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-xs font-medium transition-colors"
                    >
                      Download in Settings
                    </button>
                  </div>
                ) : (
                  <span className="text-red-400">{generationError}</span>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                onClick={handleClearAll}
                disabled={isGenerating}
                className="flex items-center gap-2 border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700"
              >
                <Trash2 className="h-4 w-4" />
                Clear all
              </Button>
              
              {isGenerating ? (
                <Button
                  onClick={cancel}
                  className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 text-white"
                >
                  <Square className="h-4 w-4" />
                  Stop generation
                </Button>
              ) : (
                <Button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className="flex-1 flex items-center justify-center gap-2 bg-zinc-600 hover:bg-zinc-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  {mode === 'text-to-image' ? (
                    <>
                      <ImageIcon className="h-4 w-4" />
                      Generate image
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Generate video
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - Result Preview */}
        <div className="flex-1 p-6">
          {mode === 'text-to-image' ? (
            <ImageResult
              imageUrl={imageUrl}
              isGenerating={isGenerating}
              progress={progress}
              statusMessage={statusMessage}
              onCreateVideo={handleCreateVideoFromImage}
            />
          ) : (
            <VideoPlayer
              videoUrl={videoUrl}
              videoPath={videoPath}
              videoResolution={settings.resolution}
              isGenerating={isGenerating}
              progress={progress}
              statusMessage={statusMessage}
            />
          )}
        </div>
      </main>
      
      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={appSettings}
        onSettingsChange={setAppSettings}
      />
    </div>
  )
}
