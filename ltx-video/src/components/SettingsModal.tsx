import React, { useState, useEffect } from 'react'
import { X, Settings, Zap, Sliders, Download, Check, AlertCircle, Sparkles, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'

const DEFAULT_T2V_SYSTEM_PROMPT = `You are a prompt enhancer for a text-to-video model. Your task is to take user input and expand it into a fully realized, visually and acoustically specific scene.

CRITICAL INSTRUCTIONS:
Strictly follow all aspects of the user's input: include every element the user requests, such as style, visual details, motions, actions, camera movement, and audio.

The user's input may be vague. To prevent the video model from generating generic or "default" outputs (e.g., shirtless characters, textureless objects), you MUST invent reasonable, concrete details to fill in the visual gaps:
1. Visual Detail: Add fine-grained visual information about lighting, color palettes, textures, reflections, and atmospheric elements.
2. Subject Appearance: Define gender, clothing, hair, age and expressions if not specified, describe subjects interaction with the environment. Avoid mentioning charachter names unless specified, they are irrelevant and non visual.
3. Multiple Characters: When describing more than one person, introduce each with a clear subject (e.g., "A tall man... beside him, a shorter woman...") to avoid attribute confusion.
4. Object Texture & Environment: Define materials for objects and environments - Is the ground wet asphalt or dry sand? Is the light harsh neon or soft sun? For human skin and faces, keep descriptions natural and avoid "texture" language that could cause exaggerated features.
5. Physics & Movement: Describe exactly *how* things move (heavy trudging vs. light gliding, rigid impact vs. elastic bounce).

Guidelines for Enhancement:
- Audio Layer (Mandatory & Concrete): Abstract descriptions like "music plays" result in silent videos. You must describe the *source* and the *texture* of the sound (e.g., "The hollow drone of wind," "The wet splash of tires," "The metallic clank of machinery"). The audio may come from implied or off-screen sources, weave audio descriptions naturally into the chronological flow of the visual description. Do not add speech or dialogue if not mentioned in the input.
- Camera motion: DO NOT invent camera motion/movement unless requested by the user. Make sure to include camera motion if it is specified in the input.
- Temporal Flow: Suggest how the scene evolves over a few seconds — subtle changes in light, character movements, or environmental shifts.
- Avoid freezes: Throughout the prompt, use continuous motion verbs: "continues", "maintains", "keeps [verb]ing", "still [verb]ing" to sustain action from start to finish. NEVER use "static", "still", "frozen", "paused", "captures", "frames", "in the midst of"—even for camera descriptions—unless explicitly requested.
- Dialogue: Only if the input specifies dialogue, quote the exact lines within the action. Describe each speaker distinctively so it is unambiguous who speaks when. If a language other than English is required, explicitly state the language for the dialogue lines.

Output Format (Strict):
- Produce a single continuous paragraph in natural language.
- Length: Moderate (4-6 sentences). Enough to define physics, appearance and audio fully, but without fluff.
- Do NOT include titles, headings, prefaces, or sections.
- Do NOT include code fences or Markdown—plain prose only.`

const DEFAULT_I2V_SYSTEM_PROMPT = `<OBJECTIVE_AND_PERSONA>
You are a Creative Assistant specializing in writing detailed, chronological image-to-video prompts in a clear, factual, filmic style for a movie production company.
</OBJECTIVE_AND_PERSONA>

<CONTEXT>
You will be provided an image that must be adapted into a short video. You may also receive user input describing desired action or camera motion.
Your task is to write a single, self-contained 'video prompt': a dense, chronological description that precisely states the setting, subjects, actions, gestures, micro-movements, background activity, camera placement and movement, lighting, and other visual details observable in the shot.
</CONTEXT>

<INSTRUCTIONS>
1. Adhere strictly to the user's explicit intent: include every requested motion/action, camera movement, transition, timing, subject, and on-screen text.
2. Chronological flow: Describe subjects, actions, and camera moves in real-time order.
3. Camera work: Always specify framing, angle, lens feel, and mention camera behavior when not static.
4. Environment: Describe setting in concrete detail—architecture, surfaces, textures, lighting cues.
5. Continuity: Default to a single continuous shot.
6. Motion defaults: If no action is specified, describe subtle subject or environmental motion.
7. Dynamic action handling: Treat the image description as the starting state and begin motion within 0.5-1.0 seconds.
8. Sustain motion throughout: Maintain the subject's action for the full duration.
</INSTRUCTIONS>

<OUTPUT_FORMAT>
Output must be a single paragraph in English written as a cinematic, chronological shot description.
</OUTPUT_FORMAT>`

interface TextEncoderStatus {
  downloaded: boolean
  size_gb: number
  expected_size_gb: number
}

interface InferenceSettings {
  steps: number
  useUpscaler: boolean
}

interface AppSettings {
  keepModelsLoaded: boolean
  useTorchCompile: boolean
  loadOnStartup: boolean
  ltxApiKey: string
  useLocalTextEncoder: boolean
  fastModel: InferenceSettings
  proModel: InferenceSettings
  promptCacheSize: number
  // Prompt Enhancer settings
  promptEnhancerEnabled: boolean
  geminiApiKey: string
  t2vSystemPrompt: string
  i2vSystemPrompt: string
  // Seed settings
  seedLocked: boolean
  lockedSeed: number
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

type TabId = 'general' | 'inference' | 'promptEnhancer'

export function SettingsModal({ isOpen, onClose, settings, onSettingsChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [textEncoderStatus, setTextEncoderStatus] = useState<TextEncoderStatus | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState<'t2v' | 'i2v' | null>(null)

  // Fetch text encoder status when modal opens
  useEffect(() => {
    if (!isOpen) return
    
    const fetchStatus = async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const response = await fetch(`${backendUrl}/api/models/status`)
        if (response.ok) {
          const data = await response.json()
          setTextEncoderStatus(data.text_encoder_status)
        }
      } catch (e) {
        console.error('Failed to fetch text encoder status:', e)
      }
    }
    
    fetchStatus()
    // Poll while downloading
    const interval = setInterval(fetchStatus, 2000)
    return () => clearInterval(interval)
  }, [isOpen, isDownloading])

  // Handle text encoder download
  const handleDownloadTextEncoder = async () => {
    setIsDownloading(true)
    setDownloadError(null)
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const response = await fetch(`${backendUrl}/api/text-encoder/download`, { method: 'POST' })
      const data = await response.json()
      
      if (data.status === 'already_downloaded') {
        setTextEncoderStatus(prev => prev ? { ...prev, downloaded: true } : null)
      }
      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${backendUrl}/api/models/status`)
          if (statusRes.ok) {
            const statusData = await statusRes.json()
            setTextEncoderStatus(statusData.text_encoder_status)
            if (statusData.text_encoder_status?.downloaded) {
              setIsDownloading(false)
              clearInterval(pollInterval)
            }
          }
        } catch {
          // ignore
        }
      }, 2000)
      
      // Timeout after 30 minutes
      setTimeout(() => {
        clearInterval(pollInterval)
        if (isDownloading) setIsDownloading(false)
      }, 30 * 60 * 1000)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed')
      setIsDownloading(false)
    }
  }

  if (!isOpen) return null

  const handleToggleTorchCompile = () => {
    onSettingsChange({
      ...settings,
      useTorchCompile: !settings.useTorchCompile,
    })
  }

  const handleToggleLoadOnStartup = () => {
    onSettingsChange({
      ...settings,
      loadOnStartup: !settings.loadOnStartup,
    })
  }

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({
      ...settings,
      ltxApiKey: e.target.value,
    })
  }

  const handleToggleLocalEncoder = () => {
    onSettingsChange({
      ...settings,
      useLocalTextEncoder: !settings.useLocalTextEncoder,
    })
  }

  const handlePromptCacheSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const size = Math.max(0, Math.min(1000, parseInt(e.target.value) || 100))
    onSettingsChange({
      ...settings,
      promptCacheSize: size,
    })
  }

  const handleFastUpscalerToggle = () => {
    onSettingsChange({
      ...settings,
      fastModel: { ...settings.fastModel, useUpscaler: !settings.fastModel?.useUpscaler },
    })
  }

  const handleProStepsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const steps = Math.max(1, Math.min(100, parseInt(e.target.value) || 20))
    onSettingsChange({
      ...settings,
      proModel: { ...settings.proModel, steps },
    })
  }

  const handleProUpscalerToggle = () => {
    onSettingsChange({
      ...settings,
      proModel: { ...settings.proModel, useUpscaler: !settings.proModel.useUpscaler },
    })
  }

  // Prompt Enhancer handlers
  const handleTogglePromptEnhancer = () => {
    onSettingsChange({
      ...settings,
      promptEnhancerEnabled: !settings.promptEnhancerEnabled,
    })
  }

  const handleGeminiApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({
      ...settings,
      geminiApiKey: e.target.value,
    })
  }

  const handleT2vSystemPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onSettingsChange({
      ...settings,
      t2vSystemPrompt: e.target.value,
    })
  }

  const handleI2vSystemPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onSettingsChange({
      ...settings,
      i2vSystemPrompt: e.target.value,
    })
  }

  // Seed handlers
  const handleToggleSeedLock = () => {
    onSettingsChange({
      ...settings,
      seedLocked: !settings.seedLocked,
    })
  }

  const handleLockedSeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 0
    onSettingsChange({
      ...settings,
      lockedSeed: Math.max(0, Math.min(2147483647, value)),
    })
  }

  const handleRandomizeSeed = () => {
    onSettingsChange({
      ...settings,
      lockedSeed: Math.floor(Math.random() * 2147483647),
    })
  }

  const handleResetSystemPrompt = (promptType: 't2v' | 'i2v') => {
    if (promptType === 't2v') {
      onSettingsChange({
        ...settings,
        t2vSystemPrompt: DEFAULT_T2V_SYSTEM_PROMPT,
      })
    } else {
      onSettingsChange({
        ...settings,
        i2vSystemPrompt: DEFAULT_I2V_SYSTEM_PROMPT,
      })
    }
    setShowResetConfirm(null)
  }

  const tabs = [
    { id: 'general' as TabId, label: 'General', icon: Settings },
    { id: 'inference' as TabId, label: 'Inference', icon: Sliders },
    { id: 'promptEnhancer' as TabId, label: 'Prompt Enhancer', icon: Sparkles },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-zinc-400" />
            <h2 className="text-lg font-semibold text-white">Settings</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-white border-b-2 border-violet-500 -mb-px'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
        
        {/* Content */}
        <div className="px-6 py-5 space-y-6 max-h-[60vh] overflow-y-auto">
          {activeTab === 'general' && (
            <>
              {/* Text Encoding Section */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  <h3 className="text-sm font-semibold text-white">Text Encoding</h3>
                </div>
                
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Text encoding converts your prompt into data the AI understands. Choose how to do this.
                </p>

                {/* LTX API Option (Default) */}
                <div 
                  className={`bg-zinc-800/50 rounded-lg p-4 border-2 transition-colors cursor-pointer ${
                    !settings.useLocalTextEncoder ? 'border-violet-500' : 'border-transparent hover:border-zinc-600'
                  }`}
                  onClick={() => settings.useLocalTextEncoder && handleToggleLocalEncoder()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-violet-400" />
                        <span className="text-sm font-medium text-white">LTX API</span>
                        <span className="text-xs px-1.5 py-0.5 bg-violet-500/20 text-violet-400 rounded">Recommended</span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">
                        Fast encoding via cloud (~1 second). Requires API key.
                      </p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      !settings.useLocalTextEncoder ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                    }`}>
                      {!settings.useLocalTextEncoder && <Check className="h-3 w-3 text-white" />}
                    </div>
                  </div>
                  
                  {/* API Key Input - show when this option is selected */}
                  {!settings.useLocalTextEncoder && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50">
                      <input
                        type="password"
                        value={settings.ltxApiKey || ''}
                        onChange={handleApiKeyChange}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Enter your LTX API key..."
                        className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                      />
                      <div className="flex items-center justify-between mt-2">
                        <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                          settings.ltxApiKey 
                            ? 'bg-green-500/10 text-green-400' 
                            : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {settings.ltxApiKey ? (
                            <>
                              <Check className="h-3 w-3" />
                              Ready to generate
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-3 w-3" />
                              API key required
                            </>
                          )}
                        </div>
                        <a 
                          href="https://console.ltx.io" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-violet-400 hover:text-violet-300 underline"
                        >
                          Get a free key
                        </a>
                      </div>
                      
                      {/* Prompt Cache Size */}
                      {settings.ltxApiKey && (
                        <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-700/50">
                          <div>
                            <label className="text-xs text-white">Prompt Cache</label>
                            <p className="text-xs text-zinc-500">Skip repeat prompts</p>
                          </div>
                          <input
                            type="number"
                            min="0"
                            max="1000"
                            value={settings.promptCacheSize ?? 100}
                            onChange={handlePromptCacheSizeChange}
                            onClick={(e) => e.stopPropagation()}
                            className="w-16 px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-xs text-white text-center focus:outline-none focus:ring-2 focus:ring-violet-500"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Local Encoder Option */}
                <div 
                  className={`bg-zinc-800/50 rounded-lg p-4 border-2 transition-colors cursor-pointer ${
                    settings.useLocalTextEncoder ? 'border-violet-500' : 'border-transparent hover:border-zinc-600'
                  }`}
                  onClick={() => !settings.useLocalTextEncoder && handleToggleLocalEncoder()}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <svg className="h-4 w-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <path d="M9 9h6m-6 3h6m-6 3h4" />
                        </svg>
                        <span className="text-sm font-medium text-white">Local Encoder</span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">
                        Run on your computer (~23 seconds). Requires 8 GB download.
                      </p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      settings.useLocalTextEncoder ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                    }`}>
                      {settings.useLocalTextEncoder && <Check className="h-3 w-3 text-white" />}
                    </div>
                  </div>
                  
                  {/* Download Status - show when this option is selected */}
                  {settings.useLocalTextEncoder && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50">
                      {textEncoderStatus?.downloaded ? (
                        <div className="flex items-center gap-2 text-xs text-green-400">
                          <Check className="h-4 w-4" />
                          <span>Downloaded ({textEncoderStatus.size_gb} GB)</span>
                        </div>
                      ) : isDownloading ? (
                        <div className="flex items-center gap-2 text-xs text-violet-400">
                          <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                          <span>Downloading text encoder...</span>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-xs text-amber-400">
                            <AlertCircle className="h-4 w-4" />
                            <span>Not downloaded ({textEncoderStatus?.expected_size_gb || 8} GB required)</span>
                          </div>
                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDownloadTextEncoder()
                            }}
                            className="w-full bg-violet-600 hover:bg-violet-500 text-white text-xs"
                          >
                            <Download className="h-3 w-3 mr-2" />
                            Download Text Encoder
                          </Button>
                          {downloadError && (
                            <p className="text-xs text-red-400">{downloadError}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              
              {/* Load on Startup Setting */}
              <div className="space-y-3 pt-4 border-t border-zinc-800">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="h-4 w-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                      </svg>
                      <label className="text-sm font-medium text-white">
                        Preload models on startup
                      </label>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Load AI models when the app starts. When disabled, models load on first generation 
                      (faster startup, slower first generation). Requires app restart to take effect.
                    </p>
                  </div>
                  
                  {/* Toggle Switch */}
                  <button
                    onClick={handleToggleLoadOnStartup}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      settings.loadOnStartup ? 'bg-blue-500' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        settings.loadOnStartup ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                
                {/* Status indicator */}
                <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                  settings.loadOnStartup 
                    ? 'bg-blue-500/10 text-blue-400' 
                    : 'bg-zinc-800 text-zinc-500'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    settings.loadOnStartup ? 'bg-blue-400' : 'bg-zinc-600'
                  }`} />
                  {settings.loadOnStartup ? 'Models preload at startup' : 'Models load on first generation'}
                </div>
              </div>
              
              {/* Torch Compile Setting */}
              <div className="space-y-3 pt-4 border-t border-zinc-800">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="h-4 w-4 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                      <label className="text-sm font-medium text-white">
                        Torch Compile
                      </label>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Compiles the model for optimized inference. <span className="text-orange-400">Experimental:</span> First 
                      generation can take 5-10+ minutes for compilation. Subsequent generations may be 
                      20-40% faster. Requires app restart to take effect.
                    </p>
                  </div>
                  
                  {/* Toggle Switch */}
                  <button
                    onClick={handleToggleTorchCompile}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      settings.useTorchCompile ? 'bg-orange-500' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        settings.useTorchCompile ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                
                {/* Status indicator */}
                <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                  settings.useTorchCompile 
                    ? 'bg-orange-500/10 text-orange-400' 
                    : 'bg-zinc-800 text-zinc-500'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    settings.useTorchCompile ? 'bg-orange-400' : 'bg-zinc-600'
                  }`} />
                  {settings.useTorchCompile ? 'Optimized inference (recommended)' : 'Standard inference'}
                </div>
              </div>
              
              {/* Seed Lock Setting */}
              <div className="space-y-3 pt-4 border-t border-zinc-800">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      <label className="text-sm font-medium text-white">
                        Lock Seed
                      </label>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Use the same seed for reproducible generations. When unlocked, a random seed is used each time.
                    </p>
                  </div>
                  
                  {/* Toggle Switch */}
                  <button
                    onClick={handleToggleSeedLock}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      settings.seedLocked ? 'bg-emerald-500' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        settings.seedLocked ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                
                {/* Seed input - only show when locked */}
                {settings.seedLocked && (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      value={settings.lockedSeed ?? 42}
                      onChange={handleLockedSeedChange}
                      className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      placeholder="Enter seed..."
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRandomizeSeed}
                      className="h-9 px-3 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800"
                      title="Generate random seed"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
                      </svg>
                    </Button>
                  </div>
                )}
                
                {/* Status indicator */}
                <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                  settings.seedLocked 
                    ? 'bg-emerald-500/10 text-emerald-400' 
                    : 'bg-zinc-800 text-zinc-500'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    settings.seedLocked ? 'bg-emerald-400' : 'bg-zinc-600'
                  }`} />
                  {settings.seedLocked ? `Seed locked: ${settings.lockedSeed ?? 42}` : 'Random seed each generation'}
                </div>
              </div>
            </>
          )}

          {activeTab === 'inference' && (
            <>
              {/* Fast Model Settings */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-green-400" />
                  <h3 className="text-sm font-semibold text-white">Fast Model (Distilled)</h3>
                </div>
                
                <div className="bg-zinc-800/50 rounded-lg p-4 space-y-4">
                  {/* Steps Info */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-white">Inference Steps</label>
                      <p className="text-xs text-zinc-500">Fixed at 8 steps (built into distilled model)</p>
                    </div>
                    <span className="px-3 py-1.5 bg-zinc-700 rounded-lg text-sm text-zinc-400">8</span>
                  </div>
                  
                  {/* Upscaler Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-white">2x Upscaler</label>
                      <p className="text-xs text-zinc-500">When off, generates at native resolution</p>
                    </div>
                    <button
                      onClick={handleFastUpscalerToggle}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        settings.fastModel?.useUpscaler !== false ? 'bg-green-500' : 'bg-zinc-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          settings.fastModel?.useUpscaler !== false ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
                
                {/* Summary */}
                <div className="text-xs text-zinc-500">
                  Current: 8 steps, {settings.fastModel?.useUpscaler !== false ? 'with upscaler (2-stage, recommended)' : 'native resolution (experimental)'}
                </div>
              </div>

              {/* Pro Model Settings */}
              <div className="space-y-4 pt-4 border-t border-zinc-800">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  <h3 className="text-sm font-semibold text-white">Pro Model (Full)</h3>
                </div>
                
                <div className="bg-zinc-800/50 rounded-lg p-4 space-y-4">
                  {/* Steps */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-white">Inference Steps</label>
                      <p className="text-xs text-zinc-500">More steps = better quality, slower</p>
                    </div>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={settings.proModel?.steps ?? 20}
                      onChange={handleProStepsChange}
                      className="w-20 px-3 py-1.5 bg-zinc-700 border border-zinc-600 rounded-lg text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  
                  {/* Upscaler Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-white">2x Upscaler</label>
                      <p className="text-xs text-zinc-500">Doubles resolution in second pass</p>
                    </div>
                    <button
                      onClick={handleProUpscalerToggle}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        settings.proModel?.useUpscaler !== false ? 'bg-purple-500' : 'bg-zinc-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          settings.proModel?.useUpscaler !== false ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
                
                {/* Summary */}
                <div className="text-xs text-zinc-500">
                  Current: {settings.proModel?.steps ?? 20} steps, {settings.proModel?.useUpscaler !== false ? 'with upscaler (2-stage, recommended)' : 'native resolution'}
                </div>
              </div>

              {/* Info Box */}
              <div className="bg-zinc-800/30 rounded-lg p-3 mt-4">
                <p className="text-xs text-zinc-400">
                  <span className="text-violet-400 font-medium">Tip:</span> Lower steps = faster but lower quality. 
                  Higher steps = better quality but slower.
                </p>
              </div>
            </>
          )}

          {activeTab === 'promptEnhancer' && (
            <>
              {/* Enable/Disable Toggle */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-violet-400" />
                    <h3 className="text-sm font-semibold text-white">Prompt Enhancer</h3>
                  </div>
                  <button
                    onClick={handleTogglePromptEnhancer}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      settings.promptEnhancerEnabled ? 'bg-violet-500' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        settings.promptEnhancerEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Automatically enhances your prompts with rich visual details, sound descriptions, and motion cues 
                  to help the AI generate higher quality videos.
                </p>

                {/* Status */}
                <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                  settings.promptEnhancerEnabled 
                    ? 'bg-violet-500/10 text-violet-400' 
                    : 'bg-zinc-800 text-zinc-500'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    settings.promptEnhancerEnabled ? 'bg-violet-400' : 'bg-zinc-600'
                  }`} />
                  {settings.promptEnhancerEnabled ? 'Prompts will be enhanced before generation' : 'Prompts used as-is'}
                </div>
              </div>

              {/* Gemini API Key - only show when enabled */}
              {settings.promptEnhancerEnabled && (
                <div className="space-y-3 pt-4 border-t border-zinc-800">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-blue-400" />
                    <label className="text-sm font-medium text-white">Gemini API Key</label>
                  </div>
                  
                  <input
                    type="password"
                    value={settings.geminiApiKey || ''}
                    onChange={handleGeminiApiKeyChange}
                    placeholder="Enter your Gemini API key..."
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  />
                  
                  <div className="flex items-center justify-between">
                    <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                      settings.geminiApiKey 
                        ? 'bg-green-500/10 text-green-400' 
                        : 'bg-amber-500/10 text-amber-400'
                    }`}>
                      {settings.geminiApiKey ? (
                        <>
                          <Check className="h-3 w-3" />
                          API key configured
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-3 w-3" />
                          Required for prompt enhancement
                        </>
                      )}
                    </div>
                    <a 
                      href="https://aistudio.google.com/app/apikey" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-xs text-violet-400 hover:text-violet-300 underline"
                    >
                      Get a free key
                    </a>
                  </div>
                </div>
              )}

              {/* T2V System Prompt */}
              {settings.promptEnhancerEnabled && (
                <div className="space-y-3 pt-4 border-t border-zinc-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Settings className="h-4 w-4 text-violet-400" />
                      <label className="text-sm font-medium text-white">Text-to-Video Prompt</label>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowResetConfirm('t2v')}
                      className="h-7 px-2 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Reset
                    </Button>
                  </div>
                  
                  <p className="text-xs text-zinc-500">
                    System prompt for enhancing text-to-video generations.
                  </p>
                  
                  <textarea
                    value={settings.t2vSystemPrompt || DEFAULT_T2V_SYSTEM_PROMPT}
                    onChange={handleT2vSystemPromptChange}
                    rows={8}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-none font-mono"
                  />
                  
                  <p className="text-xs text-zinc-600">
                    {(settings.t2vSystemPrompt || DEFAULT_T2V_SYSTEM_PROMPT).length} characters
                  </p>
                </div>
              )}

              {/* I2V System Prompt */}
              {settings.promptEnhancerEnabled && (
                <div className="space-y-3 pt-4 border-t border-zinc-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Settings className="h-4 w-4 text-blue-400" />
                      <label className="text-sm font-medium text-white">Image-to-Video Prompt</label>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowResetConfirm('i2v')}
                      className="h-7 px-2 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Reset
                    </Button>
                  </div>
                  
                  <p className="text-xs text-zinc-500">
                    System prompt for enhancing image-to-video generations.
                  </p>
                  
                  <textarea
                    value={settings.i2vSystemPrompt || DEFAULT_I2V_SYSTEM_PROMPT}
                    onChange={handleI2vSystemPromptChange}
                    rows={8}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-none font-mono"
                  />
                  
                  <p className="text-xs text-zinc-600">
                    {(settings.i2vSystemPrompt || DEFAULT_I2V_SYSTEM_PROMPT).length} characters
                  </p>
                </div>
              )}
              
              {/* Note about T2I */}
              {settings.promptEnhancerEnabled && (
                <div className="bg-zinc-800/30 rounded-lg p-3 mt-2">
                  <p className="text-xs text-zinc-500">
                    <span className="text-zinc-400">Note:</span> Prompt enhancement is not applied to text-to-image generation.
                  </p>
                </div>
              )}

              {/* Reset Confirmation Modal */}
              {showResetConfirm && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center">
                  <div 
                    className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    onClick={() => setShowResetConfirm(null)}
                  />
                  <div className="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Reset {showResetConfirm === 't2v' ? 'Text-to-Video' : 'Image-to-Video'} Prompt?
                    </h3>
                    <p className="text-sm text-zinc-400 mb-4">
                      This will restore the default system prompt. Any changes you've made will be lost.
                    </p>
                    <div className="flex gap-3 justify-end">
                      <Button
                        variant="ghost"
                        onClick={() => setShowResetConfirm(null)}
                        className="text-zinc-400 hover:text-white hover:bg-zinc-800"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => handleResetSystemPrompt(showResetConfirm)}
                        className="bg-red-600 hover:bg-red-500 text-white"
                      >
                        Reset
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end">
          <Button
            onClick={onClose}
            className="bg-zinc-700 hover:bg-zinc-600 text-white"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

export type { AppSettings, InferenceSettings }
