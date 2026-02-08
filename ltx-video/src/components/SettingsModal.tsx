import React, { useState } from 'react'
import { X, Settings, Zap, Sliders } from 'lucide-react'
import { Button } from './ui/button'

interface InferenceSettings {
  steps: number
  useUpscaler: boolean
}

interface AppSettings {
  keepModelsLoaded: boolean
  useTorchCompile: boolean
  loadOnStartup: boolean
  ltxApiKey: string
  fastModel: InferenceSettings
  proModel: InferenceSettings
  promptCacheSize: number
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

type TabId = 'general' | 'inference'

export function SettingsModal({ isOpen, onClose, settings, onSettingsChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('general')

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

  const tabs = [
    { id: 'general' as TabId, label: 'General', icon: Settings },
    { id: 'inference' as TabId, label: 'Inference', icon: Sliders },
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
              {/* LTX API Key */}
              <div className="space-y-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="h-4 w-4 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
                      <line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                    <label className="text-sm font-medium text-white">
                      LTX API Key
                    </label>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed mb-2">
                    Use the free LTX API for text encoding (~1s instead of 23s local load). 
                    Get your key from{' '}
                    <a 
                      href="https://console.ltx.io" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-violet-400 hover:text-violet-300 underline"
                    >
                      console.ltx.io
                    </a>
                  </p>
                  <input
                    type="password"
                    value={settings.ltxApiKey || ''}
                    onChange={handleApiKeyChange}
                    placeholder="Enter your LTX API key..."
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  />
                </div>
                
                {/* Status indicator */}
                <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
                  settings.ltxApiKey 
                    ? 'bg-green-500/10 text-green-400' 
                    : 'bg-zinc-800 text-zinc-500'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    settings.ltxApiKey ? 'bg-green-400' : 'bg-zinc-600'
                  }`} />
                  {settings.ltxApiKey ? 'Fast text encoding enabled (~1s)' : 'Using local encoder (~23s per generation)'}
                </div>
                
                {/* Prompt Cache Size - only show when API key is set */}
                {settings.ltxApiKey && (
                  <div className="flex items-center justify-between pt-3 mt-3 border-t border-zinc-700/50">
                    <div>
                      <label className="text-sm text-white">Prompt Cache Size</label>
                      <p className="text-xs text-zinc-500">Cached prompts skip API call (~4s saved)</p>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max="1000"
                      value={settings.promptCacheSize ?? 100}
                      onChange={handlePromptCacheSizeChange}
                      className="w-20 px-3 py-1.5 bg-zinc-700 border border-zinc-600 rounded-lg text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-violet-500"
                    />
                  </div>
                )}
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
