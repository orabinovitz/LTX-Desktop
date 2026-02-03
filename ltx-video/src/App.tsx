import React, { useState } from 'react'
import { Sparkles, Trash2, AlertCircle, Loader2 } from 'lucide-react'
import { ImageUploader } from './components/ImageUploader'
import { VideoPlayer } from './components/VideoPlayer'
import { SettingsPanel, type GenerationSettings } from './components/SettingsPanel'
import { Textarea } from './components/ui/textarea'
import { Button } from './components/ui/button'
import { useGeneration } from './hooks/use-generation'
import { useBackend } from './hooks/use-backend'

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'fast',
  duration: 5,
  resolution: '720p',
  fps: 24,
  audio: true,
  cameraMotion: 'none',
}

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS)

  const { status, isLoading: backendLoading, error: backendError } = useBackend()
  const { 
    isGenerating, 
    progress, 
    statusMessage, 
    videoUrl, 
    error: generationError,
    generate,
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
    reset()
  }

  const canGenerate = (prompt.trim() || selectedImage) && status.connected && !isGenerating

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
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">
            <span className="text-foreground">LTX Video</span>
            {' '}
            <span className="text-primary">Image-to-Video</span>
          </h1>
        </div>
        
        {status.gpuInfo && (
          <div className="text-sm text-muted-foreground">
            GPU: {status.gpuInfo.name} ({Math.round(status.gpuInfo.vramUsed / 1024)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB VRAM)
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel - Controls */}
        <div className="w-[480px] border-r border-border p-6 overflow-y-auto">
          <div className="space-y-6">
            {/* Image Upload */}
            <ImageUploader 
              selectedImage={selectedImage}
              onImageSelect={setSelectedImage}
            />

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
                className="flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Clear all
              </Button>
              
              <Button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="flex-1 flex items-center justify-center gap-2"
              >
                <Sparkles className="h-4 w-4" />
                Generate video
              </Button>
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
