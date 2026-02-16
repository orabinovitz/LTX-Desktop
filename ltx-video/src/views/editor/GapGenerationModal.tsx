import React from 'react'
import {
  Play, X, Upload, Trash2, Video, Film, Image,
  Loader2, Sparkles
} from 'lucide-react'
import { SettingsPanel } from '../../components/SettingsPanel'
import type { GenerationSettings } from '../../components/SettingsPanel'
import type { GenerationMode } from '../../components/ModeTabs'

interface TimelineGap {
  trackIndex: number
  startTime: number
  endTime: number
}

interface GapGenerationModalProps {
  selectedGap: TimelineGap | null
  gapGenerateMode: GenerationMode | null
  setGapGenerateMode: (mode: GenerationMode | null) => void
  gapPrompt: string
  setGapPrompt: (prompt: string) => void
  gapSuggesting: boolean
  gapSuggestion: string | null
  gapBeforeFrame: string | null
  gapAfterFrame: string | null
  gapSettings: GenerationSettings
  setGapSettings: (settings: GenerationSettings) => void
  gapImageFile: File | null
  setGapImageFile: (file: File | null) => void
  gapImageInputRef: React.RefObject<HTMLInputElement>
  isRegenerating: boolean
  regenStatusMessage: string
  regenProgress: number
  regenReset: () => void
  handleGapGenerate: () => void
  deleteGap: (gap: TimelineGap) => void
  setSelectedGap: (gap: TimelineGap | null) => void
}

export function GapGenerationModal({
  selectedGap,
  gapGenerateMode,
  setGapGenerateMode,
  gapPrompt,
  setGapPrompt,
  gapSuggesting,
  gapSuggestion,
  gapBeforeFrame,
  gapAfterFrame,
  gapSettings,
  setGapSettings,
  gapImageFile,
  setGapImageFile,
  gapImageInputRef,
  isRegenerating,
  regenStatusMessage,
  regenProgress,
  regenReset,
  handleGapGenerate,
  deleteGap,
  setSelectedGap,
}: GapGenerationModalProps) {
  if (!selectedGap) return null

  return (
    <>
      {/* Gap generate modal */}
      {gapGenerateMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  gapGenerateMode === 'text-to-video' ? 'bg-violet-600/20' : 
                  gapGenerateMode === 'image-to-video' ? 'bg-blue-600/20' : 'bg-emerald-600/20'
                }`}>
                  {gapGenerateMode === 'text-to-video' ? <Video className="h-3.5 w-3.5 text-violet-400" /> :
                   gapGenerateMode === 'image-to-video' ? <Film className="h-3.5 w-3.5 text-blue-400" /> :
                   <Image className="h-3.5 w-3.5 text-emerald-400" />}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    {gapGenerateMode === 'text-to-video' ? 'Generate Video' :
                     gapGenerateMode === 'image-to-video' ? 'Image to Video' : 'Generate Image'}
                  </h2>
                  <p className="text-[10px] text-zinc-500">
                    Fill {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s gap on Track {selectedGap.trackIndex + 1}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => { setGapGenerateMode(null); regenReset() }}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            {/* Animated gap fill visualization */}
            {(gapBeforeFrame || gapAfterFrame) && (
              <div className="px-5 pt-4 pb-2">
                <div className="relative h-20 rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 flex">
                  {/* Before frame (left) */}
                  <div className="relative w-1/3 h-full flex-shrink-0 overflow-hidden">
                    {gapBeforeFrame ? (
                      <img src={gapBeforeFrame} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-zinc-600 text-[9px]">No clip</span>
                      </div>
                    )}
                    <div className="absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-zinc-900/80 to-transparent" />
                  </div>
                  
                  {/* Center: animated "new shot" breathing placeholder */}
                  <div 
                    className="flex-1 relative overflow-hidden"
                    style={{ animation: 'gapBreathe 3s ease-in-out infinite' }}
                  >
                    <div className="absolute inset-0 bg-zinc-900" />
                    <div 
                      className="absolute inset-0"
                      style={{ animation: 'gapGlow 3s ease-in-out infinite' }}
                    />
                    <div 
                      className="absolute inset-0"
                      style={{
                        background: 'linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.12) 40%, rgba(139,92,246,0.2) 50%, rgba(139,92,246,0.12) 60%, transparent 100%)',
                        animation: 'gapFillSweep 3s ease-in-out infinite',
                      }}
                    />
                    <div 
                      className="absolute inset-0 border border-violet-500/20 rounded-sm"
                      style={{ animation: 'gapBorderGlow 3s ease-in-out infinite' }}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
                      <Sparkles className="h-3.5 w-3.5 text-violet-400/50 mb-1.5" />
                      <span className="text-[9px] text-violet-300/60 font-semibold tracking-wide">AI Shot Suggestion</span>
                      <span className="text-[7px] text-zinc-500 mt-0.5 text-center leading-tight">Visually &amp; narratively consistent with your timeline</span>
                    </div>
                  </div>
                  
                  {/* After frame (right) */}
                  <div className="relative w-1/3 h-full flex-shrink-0 overflow-hidden">
                    {gapAfterFrame ? (
                      <img src={gapAfterFrame} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-zinc-600 text-[9px]">No clip</span>
                      </div>
                    )}
                    <div className="absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-zinc-900/80 to-transparent" />
                  </div>
                </div>
                <style>{`
                  @keyframes gapFillSweep {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                  }
                  @keyframes gapBreathe {
                    0%, 100% { transform: scaleX(0.97); opacity: 0.85; }
                    50% { transform: scaleX(1); opacity: 1; }
                  }
                  @keyframes gapGlow {
                    0%, 100% { background: radial-gradient(ellipse at center, rgba(139,92,246,0.06) 0%, transparent 70%); }
                    50% { background: radial-gradient(ellipse at center, rgba(139,92,246,0.15) 0%, transparent 70%); }
                  }
                  @keyframes gapBorderGlow {
                    0%, 100% { border-color: rgba(139,92,246,0.1); }
                    50% { border-color: rgba(139,92,246,0.35); }
                  }
                `}</style>
              </div>
            )}
            
            {/* Body */}
            <div className="flex-1 overflow-auto p-5 space-y-4">
              {/* Prompt */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Prompt</label>
                  {gapSuggesting && (
                    <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Analyzing timeline context...</span>
                    </div>
                  )}
                  {!gapSuggesting && gapSuggestion && gapPrompt === gapSuggestion && (
                    <div className="flex items-center gap-1 text-[10px] text-emerald-400/70">
                      <Sparkles className="h-3 w-3" />
                      <span>AI-suggested from timeline</span>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <textarea
                    value={gapPrompt}
                    onChange={(e) => setGapPrompt(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={gapSuggesting 
                      ? 'Analyzing surrounding shots for context...'
                      : gapGenerateMode === 'text-to-image' 
                      ? 'Describe the image to generate...' 
                      : 'Describe the video shot to generate...'}
                    className={`w-full bg-zinc-800 border rounded-lg p-3 text-sm text-white resize-none focus:outline-none focus:ring-1 placeholder-zinc-600 ${
                      gapSuggesting 
                        ? 'border-amber-600/40 focus:border-amber-500/50 focus:ring-amber-500/30 animate-pulse' 
                        : 'border-zinc-700 focus:border-violet-500/50 focus:ring-violet-500/30'
                    }`}
                    rows={3}
                  />
                  {gapSuggestion && gapPrompt !== gapSuggestion && !gapSuggesting && (
                    <button
                      onClick={() => setGapPrompt(gapSuggestion)}
                      className="absolute top-1.5 right-1.5 px-2 py-1 rounded-md bg-amber-900/40 border border-amber-700/30 text-amber-300 text-[10px] hover:bg-amber-900/60 transition-colors flex items-center gap-1"
                      title="Use AI-suggested prompt"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      Use suggestion
                    </button>
                  )}
                </div>
              </div>
              
              {/* Image input for I2V */}
              {gapGenerateMode === 'image-to-video' && (
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Input Image</label>
                  {gapImageFile ? (
                    <div className="flex items-center gap-3 bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                      <img 
                        src={URL.createObjectURL(gapImageFile)} 
                        alt="" 
                        className="w-16 h-10 object-cover rounded" 
                      />
                      <span className="text-xs text-zinc-300 flex-1 truncate">{gapImageFile.name}</span>
                      <button 
                        onClick={() => setGapImageFile(null)}
                        className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-red-400"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => gapImageInputRef.current?.click()}
                      className="w-full border-2 border-dashed border-zinc-700 hover:border-blue-500/50 rounded-lg p-4 text-center cursor-pointer transition-colors group"
                    >
                      <Upload className="h-5 w-5 text-zinc-600 group-hover:text-blue-400 mx-auto mb-1 transition-colors" />
                      <p className="text-xs text-zinc-500 group-hover:text-zinc-400">Click to select input image</p>
                    </button>
                  )}
                  <input
                    ref={gapImageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) setGapImageFile(file)
                      if (gapImageInputRef.current) gapImageInputRef.current.value = ''
                    }}
                    className="hidden"
                  />
                </div>
              )}
              
              {/* Settings */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Settings</label>
                <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                  <SettingsPanel
                    settings={gapSettings}
                    onSettingsChange={setGapSettings}
                    disabled={isRegenerating}
                    mode={gapGenerateMode as GenerationMode}
                  />
                </div>
              </div>
              
              {/* Progress */}
              {isRegenerating && (
                <div className="bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                  <div className="flex items-center gap-2 mb-2">
                    <Loader2 className="h-3.5 w-3.5 text-violet-400 animate-spin" />
                    <span className="text-xs text-zinc-300">{regenStatusMessage || 'Generating...'}</span>
                  </div>
                  <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-violet-500 rounded-full transition-all duration-300"
                      style={{ width: `${regenProgress * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            
            {/* Footer */}
            <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between">
              <span className="text-[10px] text-zinc-600">
                Duration: {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setGapGenerateMode(null); regenReset() }}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleGapGenerate}
                  disabled={isRegenerating || !gapPrompt.trim() || (gapGenerateMode === 'image-to-video' && !gapImageFile)}
                  className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-500 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {isRegenerating ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" />
                      Generate
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Gap action bar - shown when gap is selected but no generate mode yet */}
      {!gapGenerateMode && (
        <>
        <div className="fixed inset-0 z-40" onClick={() => setSelectedGap(null)} />
        <div 
          className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-3"
          style={{
            bottom: '220px',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-zinc-400 font-medium">
              {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s gap selected
            </span>
            <span className="text-[9px] text-zinc-600">
              (Press <kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 text-[8px] font-mono">Del</kbd> to close gap)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => deleteGap(selectedGap)}
              className="px-3 py-1.5 rounded-lg bg-red-900/30 border border-red-800/30 text-red-400 text-[11px] hover:bg-red-900/50 transition-colors flex items-center gap-1.5"
            >
              <Trash2 className="h-3 w-3" />
              Close Gap
            </button>
            <div className="w-px h-5 bg-zinc-700" />
            <span className="text-[10px] text-zinc-500 px-1">Generate:</span>
            <button
              onClick={() => setGapGenerateMode('text-to-video')}
              className="px-3 py-1.5 rounded-lg bg-violet-900/30 border border-violet-700/30 text-violet-400 text-[11px] hover:bg-violet-900/50 transition-colors flex items-center gap-1.5"
            >
              <Video className="h-3 w-3" />
              T2V
            </button>
            <button
              onClick={() => setGapGenerateMode('image-to-video')}
              className="px-3 py-1.5 rounded-lg bg-blue-900/30 border border-blue-700/30 text-blue-400 text-[11px] hover:bg-blue-900/50 transition-colors flex items-center gap-1.5"
            >
              <Film className="h-3 w-3" />
              I2V
            </button>
            <button
              onClick={() => setGapGenerateMode('text-to-image')}
              className="px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 text-[11px] hover:bg-emerald-900/50 transition-colors flex items-center gap-1.5"
            >
              <Image className="h-3 w-3" />
              T2I
            </button>
          </div>
        </div>
        </>
      )}
    </>
  )
}
