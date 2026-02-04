import React, { useState, useEffect } from 'react'
import { Sparkles, Trash2, AlertCircle, Loader2, Square, Settings } from 'lucide-react'
import { ImageUploader } from './components/ImageUploader'
import { VideoPlayer } from './components/VideoPlayer'
import { SettingsPanel, type GenerationSettings } from './components/SettingsPanel'
import { SettingsModal, type AppSettings } from './components/SettingsModal'
import { ModeTabs, type GenerationMode } from './components/ModeTabs'
import { Textarea } from './components/ui/textarea'
import { Button } from './components/ui/button'
import { useGeneration } from './hooks/use-generation'
import { useBackend } from './hooks/use-backend'

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'fast',
  duration: 6,
  resolution: '720p',
  fps: 25,
  audio: false,
  cameraMotion: 'none',
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  keepModelsLoaded: false, // Don't keep text encoder loaded by default
  useTorchCompile: false, // Disabled by default - can cause long compile times
  loadOnStartup: false, // Lazy loading - models load on first generation
}

export default function App() {
  const [mode, setMode] = useState<GenerationMode>('text-to-video')
  const [prompt, setPrompt] = useState('')
  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  const { status, isLoading: backendLoading, error: backendError } = useBackend()
  
  // Sync app settings with backend
  useEffect(() => {
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
          }),
        })
      } catch (e) {
        console.error('Failed to sync settings:', e)
      }
    }
    syncSettings()
  }, [appSettings])
  
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
    error: generationError,
    generate,
    cancel,
    reset,
  } = useGeneration()

  const handleGenerate = () => {
    if (!prompt.trim() && !selectedImage) {
      return
    }
    generate(prompt, selectedImage, settings)
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
  const canGenerate = status.connected && !isGenerating && !isWarmingUp && (
    (mode === 'text-to-video' && prompt.trim()) ||
    (mode === 'image-to-video' && selectedImage)
  )

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
          <img src="/ltx-logo.png" alt="LTX" className="h-6" />
          <ModeTabs 
            mode={mode} 
            onModeChange={handleModeChange}
            disabled={isGenerating || isWarmingUp}
          />
        </div>
        
        <div className="flex items-center gap-4">
          {/* Warmup Status Indicator */}
          {isWarmingUp && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 rounded-full">
              <Loader2 className="h-3.5 w-3.5 text-violet-400 animate-spin" />
              <span className="text-xs text-zinc-400">
                {status.warmup.currentStep || 'Loading models...'}
              </span>
              <span className="text-xs text-violet-400 font-medium">
                {status.warmup.progress}%
              </span>
            </div>
          )}
          
          {/* Ready indicator */}
          {status.warmup.status === 'ready' && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-full">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
              <span className="text-xs text-green-500">Ready</span>
            </div>
          )}
          
          {status.gpuInfo && (
            <div className="text-sm text-zinc-500">
              {status.gpuInfo.name} ({(status.gpuInfo.vramUsed / 1024).toFixed(1)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB)
            </div>
          )}
          
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
            />

            {/* Error Display */}
            {generationError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                {generationError}
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
                  <Sparkles className="h-4 w-4" />
                  Generate video
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - Video Preview */}
        <div className="flex-1 p-6">
          <VideoPlayer
            videoUrl={videoUrl}
            isGenerating={isGenerating}
            progress={progress}
            statusMessage={statusMessage}
          />
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
