import React, { useState } from 'react'
import { Sparkles, Trash2, AlertCircle, Loader2, Square } from 'lucide-react'
import { ImageUploader } from './components/ImageUploader'
import { VideoPlayer } from './components/VideoPlayer'
import { SettingsPanel, type GenerationSettings } from './components/SettingsPanel'
import { ModeTabs, type GenerationMode } from './components/ModeTabs'
import { Textarea } from './components/ui/textarea'
import { Button } from './components/ui/button'
import { useGeneration } from './hooks/use-generation'
import { useBackend } from './hooks/use-backend'

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'pro',
  duration: 8,
  resolution: '1080p',
  fps: 25,
  audio: true,
  cameraMotion: 'none',
}

export default function App() {
  const [mode, setMode] = useState<GenerationMode>('text-to-video')
  const [prompt, setPrompt] = useState('')
  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS)

  const { status, isLoading: backendLoading, error: backendError } = useBackend()
  
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

  // For T2V: prompt is required
  // For I2V: image is required, prompt is optional
  const canGenerate = status.connected && !isGenerating && (
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
            disabled={isGenerating}
          />
        </div>
        
        {status.gpuInfo && (
          <div className="text-sm text-zinc-500">
            {status.gpuInfo.name} ({Math.round(status.gpuInfo.vramUsed / 1024)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB)
          </div>
        )}
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
    </div>
  )
}
