import React, { useMemo, useEffect } from 'react'
import {
  Play, X, Upload, Trash2, Video, Image,
  Loader2, Sparkles, ChevronDown, RefreshCw
} from 'lucide-react'
import { SettingsPanel } from '../../components/SettingsPanel'
import type { GenerationSettings } from '../../components/SettingsPanel'
import type { GenerationMode } from '../../components/ModeTabs'

interface TimelineGap {
  trackIndex: number
  startTime: number
  endTime: number
}

const SHOT_TYPES = [
  { value: 'none', label: 'Default' },
  { value: 'Extreme close-up', label: 'Extreme Close-up' },
  { value: 'Close-up', label: 'Close-up' },
  { value: 'Medium close-up', label: 'Medium Close-up' },
  { value: 'Medium shot', label: 'Medium Shot' },
  { value: 'Medium wide shot', label: 'Medium Wide' },
  { value: 'Wide shot', label: 'Wide Shot' },
  { value: 'Full shot', label: 'Full Shot' },
  { value: 'Over the shoulder', label: 'Over the Shoulder' },
  { value: 'POV shot', label: 'POV' },
]

const CAMERA_ANGLES = [
  { value: 'none', label: 'Default' },
  { value: 'eye level', label: 'Eye Level' },
  { value: 'low angle', label: 'Low Angle' },
  { value: 'high angle', label: 'High Angle' },
  { value: 'from the side', label: 'From the Side' },
  { value: 'from behind', label: 'From Behind' },
  { value: 'three-quarter view', label: '3/4 View' },
  { value: 'dutch angle', label: 'Dutch Angle' },
  { value: 'bird\'s eye view', label: 'Bird\'s Eye' },
  { value: 'worm\'s eye view', label: 'Worm\'s Eye' },
]

type GapGenerateMode = 'text-to-video' | 'image-to-video' | 'text-to-image'

function dataUriToFile(dataUri: string, filename: string): File {
  const [header, b64] = dataUri.split(',')
  const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg'
  const bytes = atob(b64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new File([arr], filename, { type: mime })
}

interface GapGenerationModalProps {
  selectedGap: TimelineGap | null
  gapGenerateMode: GapGenerateMode | null
  setGapGenerateMode: (mode: GapGenerateMode | null) => void
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
  gapShotType: string
  setGapShotType: (v: string) => void
  gapCameraAngle: string
  setGapCameraAngle: (v: string) => void
  gapApplyAudioToTrack: boolean
  setGapApplyAudioToTrack: (v: boolean) => void
  regenerateSuggestion: () => void
}

function Dropdown({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex-1">
      <label className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold mb-1 block">{label}</label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-violet-500/50 cursor-pointer pr-7"
        >
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
      </div>
    </div>
  )
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
  gapShotType,
  setGapShotType,
  gapCameraAngle,
  setGapCameraAngle,
  gapApplyAudioToTrack,
  setGapApplyAudioToTrack,
  regenerateSuggestion,
}: GapGenerationModalProps) {
  if (!selectedGap) return null

  const isVideoMode = gapGenerateMode === 'text-to-video' || gapGenerateMode === 'image-to-video'
  const isImageMode = gapGenerateMode === 'text-to-image'

  const gapImageUrl = useMemo(() => {
    if (!gapImageFile) return null
    return URL.createObjectURL(gapImageFile)
  }, [gapImageFile])

  const modalTitle = isVideoMode
    ? (gapImageFile ? 'Image to Video' : 'Generate Video')
    : (gapImageFile ? 'Edit Image' : 'Generate Image')

  const settingsMode: GenerationMode = isVideoMode
    ? (gapImageFile ? 'image-to-video' : 'text-to-video')
    : 'text-to-image'

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (gapGenerateMode) {
          setGapGenerateMode(null)
          regenReset()
        } else {
          setSelectedGap(null)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [gapGenerateMode, setGapGenerateMode, regenReset, setSelectedGap])

  return (
    <>
      {gapGenerateMode && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[520px] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden my-auto shrink-0">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  isVideoMode ? 'bg-violet-600/20' : 'bg-emerald-600/20'
                }`}>
                  {isVideoMode
                    ? <Video className="h-3.5 w-3.5 text-violet-400" />
                    : <Image className="h-3.5 w-3.5 text-emerald-400" />}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">{modalTitle}</h2>
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
            
            {/* Timeline visualization */}
            <div className="px-5 pt-4 pb-2">
              <div className="relative rounded-lg overflow-hidden bg-zinc-800/50 border border-zinc-700/40 flex h-[72px]">
                {/* Before frame */}
                {gapBeforeFrame ? (
                  <div
                    className="relative w-[30%] h-full flex-shrink-0 overflow-hidden cursor-pointer group/before"
                    onClick={() => {
                      if (gapImageFile) return
                      try {
                        setGapImageFile(dataUriToFile(gapBeforeFrame, 'frame-before.jpg'))
                      } catch {}
                    }}
                    title={gapImageFile ? undefined : 'Click to use as input'}
                  >
                    <img src={gapBeforeFrame} alt="" className="w-full h-full object-cover" />
                    <div className="absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-zinc-900/80 to-transparent" />
                    {!gapImageFile && (
                      <div className="absolute inset-0 bg-black/0 group-hover/before:bg-black/40 transition-colors flex items-center justify-center">
                        <span className="text-[9px] text-white font-medium opacity-0 group-hover/before:opacity-100 transition-opacity bg-black/50 px-2 py-0.5 rounded">Use this</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-[30%] h-full flex-shrink-0 bg-zinc-800/80 flex items-center justify-center">
                    <span className="text-zinc-600 text-[8px]">No clip</span>
                  </div>
                )}

                {/* Center gap area */}
                <div className="flex-1 relative overflow-hidden">
                  {gapImageFile && gapImageUrl ? (
                    <div className="relative w-full h-full group/center">
                      <img src={gapImageUrl} alt="" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 ring-2 ring-inset ring-violet-500/50 rounded-sm" />
                      <button
                        onClick={() => setGapImageFile(null)}
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/70 text-white/70 hover:text-red-400 opacity-0 group-hover/center:opacity-100 transition-opacity"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent py-1 px-2 flex items-center justify-center">
                        <span className="text-[8px] text-violet-200/90 font-medium">
                          {isVideoMode ? 'Source frame' : 'Edit reference'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="w-full h-full relative cursor-pointer group/center"
                      onClick={() => gapImageInputRef.current?.click()}
                    >
                      <div className="absolute inset-0 bg-zinc-900/90" />
                      <div className="absolute inset-0 border border-dashed border-zinc-600 group-hover/center:border-violet-500/50 transition-colors" />
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <Sparkles className="h-3.5 w-3.5 text-violet-400/30" />
                        <span className="text-[8px] text-zinc-500 font-medium">AI fills this gap</span>
                        <span className="text-[7px] text-zinc-600 group-hover/center:text-violet-400/70 transition-colors flex items-center gap-0.5">
                          <Upload className="h-2 w-2" /> Add image
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* After frame */}
                {gapAfterFrame ? (
                  <div
                    className="relative w-[30%] h-full flex-shrink-0 overflow-hidden cursor-pointer group/after"
                    onClick={() => {
                      if (gapImageFile) return
                      try {
                        setGapImageFile(dataUriToFile(gapAfterFrame, 'frame-after.jpg'))
                      } catch {}
                    }}
                    title={gapImageFile ? undefined : 'Click to use as input'}
                  >
                    <img src={gapAfterFrame} alt="" className="w-full h-full object-cover" />
                    <div className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-zinc-900/80 to-transparent" />
                    {!gapImageFile && (
                      <div className="absolute inset-0 bg-black/0 group-hover/after:bg-black/40 transition-colors flex items-center justify-center">
                        <span className="text-[9px] text-white font-medium opacity-0 group-hover/after:opacity-100 transition-opacity bg-black/50 px-2 py-0.5 rounded">Use this</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-[30%] h-full flex-shrink-0 bg-zinc-800/80 flex items-center justify-center">
                    <span className="text-zinc-600 text-[8px]">No clip</span>
                  </div>
                )}
              </div>
            </div>
            
            {/* Body */}
            <div className="flex-1 overflow-auto p-5 space-y-4">
              {/* Prompt */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Prompt</label>
                  <div className="flex items-center gap-2">
                    {gapSuggesting && (
                      <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Analyzing timeline context...</span>
                      </div>
                    )}
                    {!gapSuggesting && gapSuggestion && gapPrompt === gapSuggestion && (
                      <div className="flex items-center gap-1 text-[10px] text-emerald-400/70">
                        <Sparkles className="h-3 w-3" />
                        <span>AI-suggested</span>
                      </div>
                    )}
                    {!gapSuggesting && (
                      <button
                        onClick={regenerateSuggestion}
                        className="flex items-center gap-1 text-[10px] text-violet-400/80 hover:text-violet-300 transition-colors px-1.5 py-0.5 rounded hover:bg-violet-900/30"
                        title="Re-analyze surrounding clips and generate a new prompt suggestion"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>Re-analyze</span>
                      </button>
                    )}
                  </div>
                </div>
                <div className="relative">
                  <textarea
                    value={gapPrompt}
                    onChange={(e) => setGapPrompt(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={gapSuggesting 
                      ? 'Analyzing surrounding shots for context...'
                      : isImageMode
                      ? (gapImageFile ? 'Describe the edits to apply...' : 'Describe the image to generate...')
                      : (gapImageFile ? 'Describe the video to generate from the image...' : 'Describe the video shot to generate...')}
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

              {/* Shot type & camera angle — only for image editing (T2I with input image) */}
              {isImageMode && gapImageFile && (
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Shot Framing</label>
                  <div className="flex gap-3">
                    <Dropdown label="SHOT TYPE" value={gapShotType} onChange={setGapShotType} options={SHOT_TYPES} />
                    <Dropdown label="CAMERA ANGLE" value={gapCameraAngle} onChange={setGapCameraAngle} options={CAMERA_ANGLES} />
                  </div>
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
                    mode={settingsMode}
                  />
                </div>
              </div>

              {/* Apply audio to audio track toggle — only in video mode when audio is on */}
              {isVideoMode && gapSettings.audio && (
                <div
                  className={`flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2.5 border border-zinc-700/50 ${
                    isRegenerating ? 'opacity-40 pointer-events-none' : 'cursor-pointer'
                  }`}
                  onClick={() => !isRegenerating && setGapApplyAudioToTrack(!gapApplyAudioToTrack)}
                >
                  <div>
                    <span className="text-xs text-zinc-300">Apply audio to audio track</span>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Place the generated audio as a linked clip on the audio track</p>
                  </div>
                  <div className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                    gapApplyAudioToTrack ? 'bg-violet-600' : 'bg-zinc-700'
                  }`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform pointer-events-none ${
                      gapApplyAudioToTrack ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </div>
                </div>
              )}
              
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

            {/* Hidden file input */}
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
                  disabled={isRegenerating || !gapPrompt.trim()}
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
        <div className="fixed inset-0 z-[90]" onClick={() => setSelectedGap(null)} />
        <div 
          className="fixed z-[100] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-3"
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
            <span className="text-[10px] text-zinc-500 px-1">Fill with:</span>
            <button
              onClick={() => setGapGenerateMode('text-to-video')}
              className="px-3 py-1.5 rounded-lg bg-violet-900/30 border border-violet-700/30 text-violet-400 text-[11px] hover:bg-violet-900/50 transition-colors flex items-center gap-1.5"
            >
              <Video className="h-3 w-3" />
              Video
            </button>
            <button
              onClick={() => setGapGenerateMode('text-to-image')}
              className="px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 text-[11px] hover:bg-emerald-900/50 transition-colors flex items-center gap-1.5"
            >
              <Image className="h-3 w-3" />
              Image
            </button>
          </div>
        </div>
        </>
      )}
    </>
  )
}
