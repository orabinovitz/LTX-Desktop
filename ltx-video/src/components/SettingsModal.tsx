import React from 'react'
import { X, Settings, HardDrive } from 'lucide-react'
import { Button } from './ui/button'

interface AppSettings {
  keepModelsLoaded: boolean
  useTorchCompile: boolean
  loadOnStartup: boolean
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

export function SettingsModal({ isOpen, onClose, settings, onSettingsChange }: SettingsModalProps) {
  if (!isOpen) return null

  const handleToggleKeepModelsLoaded = () => {
    onSettingsChange({
      ...settings,
      keepModelsLoaded: !settings.keepModelsLoaded,
    })
  }

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4">
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
        
        {/* Content */}
        <div className="px-6 py-5 space-y-6">
          {/* Keep Models Loaded Setting */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <HardDrive className="h-4 w-4 text-violet-400" />
                  <label className="text-sm font-medium text-white">
                    Keep models loaded
                  </label>
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  When enabled, the text encoder stays in GPU memory between generations, 
                  making subsequent videos generate faster. Uses more VRAM (~8GB extra). 
                  Recommended for GPUs with 24GB+ VRAM.
                </p>
              </div>
              
              {/* Toggle Switch */}
              <button
                onClick={handleToggleKeepModelsLoaded}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  settings.keepModelsLoaded ? 'bg-violet-500' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    settings.keepModelsLoaded ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            
            {/* Status indicator */}
            <div className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 ${
              settings.keepModelsLoaded 
                ? 'bg-violet-500/10 text-violet-400' 
                : 'bg-zinc-800 text-zinc-500'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                settings.keepModelsLoaded ? 'bg-violet-400' : 'bg-zinc-600'
              }`} />
              {settings.keepModelsLoaded ? 'Faster generation, higher VRAM' : 'Lower VRAM, slower generation'}
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

export type { AppSettings }
