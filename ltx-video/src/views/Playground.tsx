import { useState, useRef } from 'react'
import { Sparkles, Trash2, Square, ImageIcon, ArrowLeft } from 'lucide-react'
import { ImageUploader } from '../components/ImageUploader'
import { VideoPlayer } from '../components/VideoPlayer'
import { ImageResult } from '../components/ImageResult'
import { SettingsPanel, type GenerationSettings } from '../components/SettingsPanel'
import { ModeTabs, type GenerationMode } from '../components/ModeTabs'
import { LtxLogo } from '../components/LtxLogo'
import { ModelStatusDropdown } from '../components/ModelStatusDropdown'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import { useGeneration } from '../hooks/use-generation'
import { useBackend } from '../hooks/use-backend'
import { useProjects } from '../contexts/ProjectContext'
import { fileUrlToPath } from '../lib/url-to-path'

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'fast',
  duration: 5,
  videoResolution: '540p',
  fps: 24,
  audio: true,
  cameraMotion: 'none',
  // Image settings
  imageResolution: '1080p',
  imageAspectRatio: '16:9',
  imageSteps: 4,
}

export function Playground() {
  const { goHome } = useProjects()
  const [mode, setMode] = useState<GenerationMode>('text-to-video')
  const [prompt, setPrompt] = useState('')
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS)

  const { status } = useBackend()

  // Handle mode change
  const handleModeChange = (newMode: GenerationMode) => {
    setMode(newMode)
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
      // Auto-detect: if image is loaded → I2V, otherwise → T2V
      if (!prompt.trim() && !selectedImage) return
      const imagePath = selectedImage ? fileUrlToPath(selectedImage) : null
      generate(prompt, imagePath, settings)
    }
  }
  
  // Handle "Create video" from generated image
  const handleCreateVideoFromImage = () => {
    if (!imageUrl) {
      console.error('No image URL available')
      return
    }

    // imageUrl is already a file:// URL — just pass it as the selected image path
    setSelectedImage(imageUrl)
    setMode('image-to-video')
    generatedImageRef.current = imageUrl
  }

  const handleClearAll = () => {
    setPrompt('')
    setSelectedImage(null)
    setSettings(DEFAULT_SETTINGS)
    if (mode !== 'text-to-image') setMode('text-to-video')
    reset()
  }

  // Video mode: prompt required (T2V) or image loaded (I2V, prompt optional)
  // Image mode: prompt required
  const isVideoMode = mode !== 'text-to-image'
  const canGenerate = status.connected && !isGenerating && (
    (isVideoMode && (prompt.trim() || selectedImage)) ||
    (mode === 'text-to-image' && prompt.trim())
  )

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <button 
            onClick={goHome}
            className="p-2 rounded-lg hover:bg-zinc-800 transition-colors"
            title="Back to Home"
          >
            <ArrowLeft className="h-5 w-5 text-zinc-400" />
          </button>
          <LtxLogo className="h-5 w-auto text-white" />
          <span className="text-zinc-500 text-sm">Playground</span>
          <ModeTabs 
            mode={mode} 
            onModeChange={handleModeChange}
            disabled={isGenerating}
          />
        </div>
        
        <div className="flex items-center gap-4 pr-20">
          {/* Model Status Dropdown */}
          <ModelStatusDropdown />
          
          {/* GPU Info */}
          {status.gpuInfo && (
            <div className="text-sm text-zinc-500">
              {status.gpuInfo.name} ({(status.gpuInfo.vramUsed / 1024).toFixed(1)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB)
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel - Controls */}
        <div className="w-[500px] border-r border-zinc-800 p-6 overflow-y-auto">
          <div className="space-y-6">
            {/* Image Upload - Always shown in video mode (optional: makes it I2V) */}
            {isVideoMode && (
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
                  </div>
                ) : generationError.includes('TEXT_ENCODER_NOT_DOWNLOADED') ? (
                  <div className="space-y-2">
                    <p className="text-red-400 font-medium">Text encoder not downloaded</p>
                    <p className="text-red-400/80">
                      The local text encoder needs to be downloaded (~8 GB).
                    </p>
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
              videoResolution={settings.videoResolution}
              isGenerating={isGenerating}
              progress={progress}
              statusMessage={statusMessage}
            />
          )}
        </div>
      </main>
    </div>
  )
}
