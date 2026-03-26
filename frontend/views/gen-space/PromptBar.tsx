import {
ChevronUp,   Clock, Film,
  Image, Monitor, Music,
Scissors, Sparkles, Video, X} from 'lucide-react'
import { useEffect,useRef, useState } from 'react'

import type { ICLoraConditioningType } from '@/components/ICLoraPanel'
import { CONDITIONING_TYPES } from '@/components/ICLoraPanel'
import { logger } from '@/lib/logger'
import type { Asset } from '@/types/project'

import { urlToDataUri } from '../editor/utils/agent-generation-helper'

function SettingsDropdown({ 
  trigger, options, value, onChange, title 
}: { 
  trigger: React.ReactNode
  options: { value: string; label: string; disabled?: boolean; tooltip?: string; icon?: React.ReactNode }[]
  value: string
  onChange: (value: string) => void
  title: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsOpen(false)
    }
    if (isOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])
  
  return (
    <div ref={dropdownRef} className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={`flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-1.5 rounded-md transition-colors ${isOpen ? 'bg-zinc-700 hover:bg-zinc-700' : 'hover:bg-zinc-800'}`}
      >
        {trigger}
      </button>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 bg-zinc-800 border border-zinc-700 rounded-md p-2 min-w-[160px] shadow-xl z-[9999]">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">{title}</div>
          <div className="space-y-1">
            {options.map(option => (
              <div key={option.value} className="relative group/option">
                <button
                  onClick={() => { if (!option.disabled) { onChange(option.value); setIsOpen(false) } }}
                  className={`w-full flex items-center justify-between px-2 py-2 rounded-md transition-colors text-left ${
                    option.disabled ? 'cursor-not-allowed' : value === option.value ? 'bg-white/20 hover:bg-white/25' : 'hover:bg-zinc-700'
                  }`}
                >
                  <span className={`flex items-center gap-2.5 text-sm ${
                    option.disabled ? 'text-zinc-600' : value === option.value ? 'text-white' : 'text-zinc-400'
                  }`}>
                    {option.icon && <span className="flex-shrink-0">{option.icon}</span>}
                    {option.label}
                  </span>
                  {value === option.value && !option.disabled && (
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                {option.disabled && option.tooltip && (
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-zinc-700 rounded text-xs text-zinc-300 whitespace-nowrap opacity-0 group-hover/option:opacity-100 pointer-events-none z-[10000] transition-opacity">
                    {option.tooltip}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LightricksIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M17.0073 8.18934C16.3266 5.6556 14.9346 2.06903 12.3065 2.06903C9.27204 2.06903 6.86627 7.24621 5.45487 11.7948C4.79654 13.9203 4.35877 15.9049 4.17755 17.1736C4.10214 17.5829 4.06274 18.0044 4.06274 18.4347C4.06274 22.2903 7.22553 25.4338 11.1133 25.4338C15.5206 25.4338 23.9376 22.7073 23.9376 18.4347C23.9376 17.1179 23.1376 15.948 21.9018 14.9595L21.9039 14.9575C22.4493 13.7707 22.847 12.648 23.001 11.705C23.1934 10.5053 23.0074 9.5494 22.4429 8.88217C21.7692 8.07382 20.7107 7.85572 19.6586 7.84288C18.8826 7.84288 17.9777 7.96904 17.0073 8.18934ZM8.00176 9.17083C7.6945 9.93266 7.02317 11.7419 6.70157 12.9799C7.93005 11.9987 9.2965 11.1653 10.7091 10.4796C12.2325 9.73758 13.9171 9.06448 15.518 8.58411C15.08 6.98293 13.9585 3.62158 12.3129 3.62158C11.0298 3.62158 9.41958 5.69374 8.00176 9.17083ZM20.6201 14.083L20.6209 14.0786C21.0507 13.1163 21.3522 12.2118 21.4741 11.4547C21.5511 10.9607 21.5832 10.2872 21.2752 9.89577C20.9416 9.46599 20.1975 9.39543 19.6521 9.38901C18.9932 9.38901 18.2117 9.49943 17.3641 9.69208L17.3683 9.69702C17.586 10.7217 17.7526 11.772 17.8808 12.7968C18.8527 13.16 19.7877 13.5908 20.6201 14.083ZM15.8828 10.0897C14.6739 10.4588 13.4041 10.9464 12.209 11.4846C13.4346 11.588 14.8471 11.8527 16.2581 12.2608C16.1554 11.5367 16.0273 10.8061 15.8799 10.0948L15.8828 10.0897ZM11.1133 12.9816C8.07878 12.9816 5.60884 15.4258 5.60884 18.4347C5.60884 21.4435 8.07878 23.8878 11.1133 23.8878C13.8701 23.8878 16.3653 21.6639 16.6048 18.9158C16.7011 17.7546 16.669 15.9263 16.4637 13.9311C14.6294 13.3385 12.6763 12.9816 11.1133 12.9816ZM18.3883 22.2069C17.7984 22.4697 17.1711 22.7085 16.5284 22.9184C18.0872 21.3274 19.8832 18.8193 21.1982 16.3689L21.1997 16.3654C21.9756 17.0509 22.3915 17.7593 22.3915 18.4347C22.3915 19.6985 20.9288 21.0778 18.3883 22.2069ZM19.9493 15.4655L19.9473 15.4707C19.4291 16.4567 18.8221 17.4625 18.1833 18.4092C18.2214 17.4089 18.1892 16.0386 18.0611 14.5212C18.71 14.7948 19.3456 15.1021 19.9493 15.4655Z" fill="currentColor" />
    </svg>
  )
}

function ZitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.113 12.2515H16.5605L14.008 8.63382L6.04545 19.9068H8.60348L14.0079 12.2518L16.5605 12.2515L11.156 19.9068H13.721L19.113 12.2515V15.8693L16.2716 19.9073V22.0063H2L14.008 5L19.113 12.2515Z" fill="currentColor"/>
      <path d="M26 22.0064L21.9704 22.0063V19.9151L19.113 15.8693V12.2515L26 22.0064Z" fill="currentColor"/>
    </svg>
  )
}

function AspectIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
    </svg>
  )
}

import {
  FORCED_API_VIDEO_FPS,
  FORCED_API_VIDEO_RESOLUTIONS,
  getAllowedForcedApiDurations,
} from '@/lib/api-video-options'

export function PromptBar({
  mode, onModeChange, canUseIcLora, prompt, onPromptChange, onGenerate,
  isGenerating, inputImage, onInputImageChange, inputAudio, onInputAudioChange,
  settings, onSettingsChange, shouldVideoGenerateWithLtxApi, canGenerate,
  buttonLabel, buttonIcon, icLoraCondType, onIcLoraCondTypeChange,
  icLoraStrength, onIcLoraStrengthChange, editImages, onEditImagesChange,
}: {
  mode: 'image' | 'video' | 'retake' | 'ic-lora'
  onModeChange: (mode: 'image' | 'video' | 'retake' | 'ic-lora') => void
  canUseIcLora: boolean
  prompt: string
  onPromptChange: (prompt: string) => void
  onGenerate: () => void
  isGenerating: boolean
  canGenerate: boolean
  buttonLabel: string
  buttonIcon: React.ReactNode
  inputImage: string | null
  onInputImageChange: (url: string | null) => void
  inputAudio: string | null
  onInputAudioChange: (url: string | null) => void
  settings: {
    model: string; duration: number; videoResolution: string; fps: number
    aspectRatio: string; imageModel?: string; imageResolution: string
    nb2Resolution?: string; variations: number; audio?: boolean
  }
  onSettingsChange: (settings: any) => void
  shouldVideoGenerateWithLtxApi: boolean
  icLoraCondType?: ICLoraConditioningType
  onIcLoraCondTypeChange?: (type: ICLoraConditioningType) => void
  icLoraStrength?: number
  onIcLoraStrengthChange?: (strength: number) => void
  editImages: Array<{ dataUri: string; name: string }>
  onEditImagesChange: (images: Array<{ dataUri: string; name: string }>) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const nb2InputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isAudioDragOver, setIsAudioDragOver] = useState(false)
  const [isNb2DragOver, setIsNb2DragOver] = useState(false)
  const isRetake = mode === 'retake'
  const isIcLora = mode === 'ic-lora'
  const isNb2 = mode === 'image' && (settings.imageModel || 'nano-banana-2') !== 'z-image-turbo'
  const NB2_MAX_IMAGES = 10
  const LOCAL_MAX_DURATION: Record<string, number> = { '540p': 20, '720p': 10, '1080p': 5 }
  const localMaxDuration = LOCAL_MAX_DURATION[settings.videoResolution] ?? 20
  const videoDurationOptions = shouldVideoGenerateWithLtxApi
    ? [...getAllowedForcedApiDurations(settings.model, settings.videoResolution, settings.fps)]
    : [5, 6, 8, 10, 20].filter(d => d <= localMaxDuration)
  const videoResolutionOptions = shouldVideoGenerateWithLtxApi
    ? (inputAudio ? ['1080p'] : [...FORCED_API_VIDEO_RESOLUTIONS])
    : ['540p', '720p', '1080p']
  const videoFpsOptions = shouldVideoGenerateWithLtxApi ? [...FORCED_API_VIDEO_FPS] : [24, 25, 50]

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false)
    const assetData = e.dataTransfer.getData('asset')
    if (assetData) {
      const asset = JSON.parse(assetData) as Asset
      if (asset.type === 'image') onInputImageChange(asset.url)
    }
  }

  const handleAudioDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsAudioDragOver(false)
    const assetData = e.dataTransfer.getData('asset')
    if (assetData) {
      const asset = JSON.parse(assetData) as Asset
      if (asset.type === 'audio') onInputAudioChange(asset.url)
    }
    const file = e.dataTransfer.files?.[0]
    if (file) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext || '')) {
        const filePath = (file as any).path as string | undefined
        if (filePath) {
          const normalized = filePath.replace(/\\/g, '/')
          onInputAudioChange(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`)
        }
      }
    }
  }

  const handleAudioFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const filePath = (file as any).path as string | undefined
      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        onInputAudioChange(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      const filePath = (file as any).path as string | undefined
      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        onInputImageChange(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`)
      } else {
        onInputImageChange(URL.createObjectURL(file))
      }
    }
  }

  const fileToDataUri = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { if (typeof reader.result === 'string') resolve(reader.result); else reject(new Error('Failed to read file')) }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

  const handleNb2Drop = async (e: React.DragEvent) => {
    e.preventDefault(); setIsNb2DragOver(false)
    if (editImages.length >= NB2_MAX_IMAGES) return
    const assetData = e.dataTransfer.getData('asset')
    if (assetData) {
      try {
        const asset = JSON.parse(assetData) as Asset
        if (asset.type === 'image' && asset.url) {
          const dataUri = await urlToDataUri(asset.url)
          onEditImagesChange([...editImages, { dataUri, name: asset.prompt || 'image' }])
        }
      } catch (err) {
        logger.error(`NB2 drop failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    const toProcess = files.slice(0, NB2_MAX_IMAGES - editImages.length)
    const newImages = await Promise.all(toProcess.map(async (file) => ({ dataUri: await fileToDataUri(file), name: file.name })))
    if (newImages.length > 0) onEditImagesChange([...editImages, ...newImages])
  }

  const handleNb2FileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'))
    const toProcess = files.slice(0, NB2_MAX_IMAGES - editImages.length)
    const newImages = await Promise.all(toProcess.map(async (file) => ({ dataUri: await fileToDataUri(file), name: file.name })))
    if (newImages.length > 0) onEditImagesChange([...editImages, ...newImages])
    e.target.value = ''
  }

  const removeNb2Image = (index: number) => { onEditImagesChange(editImages.filter((_, i) => i !== index)) }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isGenerating && canGenerate) { e.preventDefault(); onGenerate() }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-visible">
      <div className="flex items-start">
        {mode === 'video' && !isRetake && !isIcLora && (
          <div
            className={`relative w-10 h-10 mx-2 mt-2 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center flex-shrink-0 cursor-pointer ${
              isDragOver ? 'border-blue-500 bg-blue-500/10' : 'border-zinc-700 hover:border-zinc-500'
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            {inputImage ? (
              <>
                <img src={inputImage} alt="" className="w-full h-full object-cover rounded-md" />
                <button onClick={(e) => { e.stopPropagation(); onInputImageChange(null) }} className="absolute -top-1 -right-1 p-0.5 rounded-full bg-zinc-800 text-zinc-400 hover:text-white z-10">
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <Image className="h-4 w-4 text-zinc-500" />
            )}
            <input ref={inputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
          </div>
        )}

        {mode === 'video' && !isRetake && !isIcLora && (
          <div
            className={`relative w-10 h-10 mt-2 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center flex-shrink-0 cursor-pointer ${
              isAudioDragOver ? 'border-emerald-500 bg-emerald-500/10' : inputAudio ? 'border-emerald-600' : 'border-zinc-700 hover:border-zinc-500'
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsAudioDragOver(true) }}
            onDragLeave={() => setIsAudioDragOver(false)}
            onDrop={handleAudioDrop}
            onClick={() => audioInputRef.current?.click()}
            title={inputAudio ? 'Audio attached — click to change' : 'Attach audio for A2V'}
          >
            {inputAudio ? (
              <>
                <Music className="h-4 w-4 text-emerald-400" />
                <button onClick={(e) => { e.stopPropagation(); onInputAudioChange(null) }} className="absolute -top-1 -right-1 p-0.5 rounded-full bg-zinc-800 text-zinc-400 hover:text-white z-10">
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <Music className="h-4 w-4 text-zinc-500" />
            )}
            <input ref={audioInputRef} type="file" accept=".mp3,.wav,.ogg,.aac,.flac,.m4a" onChange={handleAudioFileSelect} className="hidden" />
          </div>
        )}

        {isNb2 && (
          <div
            className="flex items-center gap-1 ml-2 mt-1 pt-1 flex-shrink-0 overflow-x-auto max-w-[240px] outline-none"
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsNb2DragOver(true) }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsNb2DragOver(false) }}
            onDrop={handleNb2Drop}
          >
            {editImages.map((img, i) => (
              <div key={i} className="relative w-10 h-10 rounded-lg bg-zinc-800 border border-zinc-700 flex-shrink-0 group">
                <img src={img.dataUri} alt={img.name} className="w-full h-full object-cover rounded-lg" />
                <button onClick={() => removeNb2Image(i)} className="absolute -top-1 -right-1 p-0.5 rounded-full bg-zinc-800 text-zinc-400 hover:text-white z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {editImages.length < NB2_MAX_IMAGES && (
              <div
                className={`relative w-10 h-10 rounded-lg border-2 border-dashed flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
                  isNb2DragOver ? 'border-amber-500 bg-amber-500/10' : 'border-zinc-700 hover:border-zinc-500'
                }`}
                onClick={() => nb2InputRef.current?.click()}
                title="Add reference image for editing"
              >
                <Image className={`h-4 w-4 transition-colors ${isNb2DragOver ? 'text-amber-500' : 'text-zinc-500'}`} />
                <input ref={nb2InputRef} type="file" accept="image/*" multiple onChange={handleNb2FileSelect} className="hidden" />
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 py-1">
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'retake' ? "Describe what should happen in the selected section..."
              : mode === 'ic-lora' ? "Describe the style or transformation to apply..."
              : mode === 'image' ? "A close-up of a woman talking on the phone..."
              : "The woman sips from a cup of coffee..."}
            className="w-full bg-transparent text-white text-sm placeholder:text-zinc-500 focus:outline-none px-2 py-2 resize-none overflow-y-auto h-[70px] leading-5"
          />
        </div>
      </div>
      
      <div className="flex items-center gap-0.5 px-1.5 py-1.5 border-t border-zinc-800/60 text-xs text-zinc-400">
        <SettingsDropdown
          title="MODE" value={mode}
          onChange={(v) => onModeChange(v as 'image' | 'video' | 'retake' | 'ic-lora')}
          options={[
            { value: 'image', label: 'Generate Images', icon: <Image className="h-4 w-4" /> },
            { value: 'video', label: 'Generate Videos', icon: <Video className="h-4 w-4" /> },
            { value: 'retake', label: 'Retake', icon: <Scissors className="h-4 w-4" /> },
            ...(canUseIcLora ? [{ value: 'ic-lora', label: 'IC-LoRA', icon: <Sparkles className="h-4 w-4" /> }] : []),
          ]}
          trigger={<>
            {mode === 'image' ? <Image className="h-3.5 w-3.5" /> : mode === 'retake' ? <Scissors className="h-3.5 w-3.5" /> : mode === 'ic-lora' ? <Sparkles className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
            <span className="text-zinc-300 font-medium">{mode === 'image' ? 'Image' : mode === 'retake' ? 'Retake' : mode === 'ic-lora' ? 'IC-LoRA' : 'Video'}</span>
            <ChevronUp className="h-3 w-3 text-zinc-500" />
          </>}
        />
        
        <div className="flex-1" />
        
        {isRetake ? (
          <div className="text-[10px] text-zinc-500 pr-2">Trim in the panel above, then retake</div>
        ) : isIcLora ? (
          <>
            <SettingsDropdown
              title="CONDITIONING TYPE" value={icLoraCondType || 'canny'}
              onChange={(v) => onIcLoraCondTypeChange?.(v as ICLoraConditioningType)}
              options={CONDITIONING_TYPES.map(ct => ({ value: ct.value, label: ct.label }))}
              trigger={<>
                <span className="text-zinc-300 font-medium">{CONDITIONING_TYPES.find(ct => ct.value === icLoraCondType)?.label || 'Canny Edges'}</span>
                <ChevronUp className="h-3 w-3 text-zinc-500" />
              </>}
            />
            <div className="w-px h-4 bg-zinc-700 mx-0.5" />
            <SettingsDropdown
              title="STRENGTH" value={String(icLoraStrength ?? 1.0)}
              onChange={(v) => onIcLoraStrengthChange?.(parseFloat(v))}
              options={[{ value: '0.5', label: '0.50' }, { value: '0.75', label: '0.75' }, { value: '1', label: '1.00' }, { value: '1.25', label: '1.25' }, { value: '1.5', label: '1.50' }, { value: '2', label: '2.00' }]}
              trigger={<>
                <span className="text-zinc-500 text-[10px]">STR</span>
                <span className="text-zinc-300 font-medium">{(icLoraStrength ?? 1.0).toFixed(2)}</span>
                <ChevronUp className="h-3 w-3 text-zinc-500" />
              </>}
            />
          </>
        ) : mode === 'image' ? (
          <>
            <SettingsDropdown
              title="IMAGE MODEL" value={settings.imageModel || 'nano-banana-2'}
              onChange={(v) => onSettingsChange({ ...settings, imageModel: v })}
              options={[{ value: 'nano-banana-2', label: 'Nano Banana 2' }, { value: 'z-image-turbo', label: 'Z-Image Turbo' }]}
              trigger={<>
                {(settings.imageModel || 'nano-banana-2') === 'z-image-turbo' ? <ZitIcon className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5 text-amber-400" />}
                <span className="text-zinc-300 font-medium">{(settings.imageModel || 'nano-banana-2') === 'z-image-turbo' ? 'Z-Image Turbo' : 'Nano Banana 2'}</span>
              </>}
            />
            {(settings.imageModel || 'nano-banana-2') === 'z-image-turbo' ? (
              <SettingsDropdown title="IMAGE RESOLUTION" value={settings.imageResolution}
                onChange={(v) => onSettingsChange({ ...settings, imageResolution: v })}
                options={[{ value: '1080p', label: '1080p' }, { value: '1440p', label: '1440p' }, { value: '2048p', label: '2048p' }]}
                trigger={<><Monitor className="h-3.5 w-3.5" /><span>{settings.imageResolution.replace('p', '')}</span></>}
              />
            ) : (
              <SettingsDropdown title="RESOLUTION" value={settings.nb2Resolution || '1K'}
                onChange={(v) => onSettingsChange({ ...settings, nb2Resolution: v })}
                options={[{ value: '0.5K', label: '0.5K' }, { value: '1K', label: '1K' }, { value: '2K', label: '2K' }, { value: '4K', label: '4K' }]}
                trigger={<><Monitor className="h-3.5 w-3.5" /><span>{settings.nb2Resolution || '1K'}</span></>}
              />
            )}
            <SettingsDropdown title="RATIO" value={settings.aspectRatio}
              onChange={(v) => onSettingsChange({ ...settings, aspectRatio: v })}
              options={(settings.imageModel || 'nano-banana-2') === 'z-image-turbo'
                ? [{ value: '16:9', label: '16:9' }, { value: '1:1', label: '1:1' }, { value: '9:16', label: '9:16' }]
                : [{ value: 'auto', label: 'Auto' }, { value: '16:9', label: '16:9' }, { value: '1:1', label: '1:1' }, { value: '9:16', label: '9:16' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' }, { value: '3:2', label: '3:2' }, { value: '2:3', label: '2:3' }, { value: '21:9', label: '21:9' }]}
              trigger={<><AspectIcon className="h-3.5 w-3.5" /><span>{settings.aspectRatio}</span></>}
            />
          </>
        ) : (
          <>
            <SettingsDropdown title="MODEL" value={settings.model}
              onChange={(v) => onSettingsChange({ ...settings, model: v })}
              options={shouldVideoGenerateWithLtxApi
                ? [{ value: 'fast', label: 'LTX-2.3 Fast (API)', disabled: !!inputAudio, tooltip: inputAudio ? 'Fast model is not available for Audio-to-Video' : undefined }, { value: 'pro', label: 'LTX-2.3 Pro (API)' }]
                : [{ value: 'fast', label: 'LTX 2.3 Fast' }]}
              trigger={<>
                <LightricksIcon className="h-3.5 w-3.5" />
                <span className="text-zinc-300 font-medium">{shouldVideoGenerateWithLtxApi ? (settings.model === 'pro' ? 'LTX-2.3 Pro (API)' : 'LTX-2.3 Fast (API)') : 'LTX 2.3 Fast'}</span>
              </>}
            />
            <div className="w-px h-4 bg-zinc-700 mx-0.5" />
            <SettingsDropdown title="DURATION" value={String(settings.duration)}
              onChange={(v) => onSettingsChange({ ...settings, duration: parseFloat(v) })}
              options={videoDurationOptions.map((value) => ({ value: String(value), label: `${value} Sec` }))}
              trigger={<><Clock className="h-3.5 w-3.5" /><span>{settings.duration}s</span></>}
            />
            <SettingsDropdown title="RESOLUTION" value={settings.videoResolution}
              onChange={(v) => {
                const maxDur = LOCAL_MAX_DURATION[v] ?? 20
                onSettingsChange({ ...settings, videoResolution: v, duration: settings.duration > maxDur ? maxDur : settings.duration })
              }}
              options={videoResolutionOptions.map((value) => ({ value, label: value }))}
              trigger={<><Monitor className="h-3.5 w-3.5" /><span>{settings.videoResolution.replace('p', '')}</span></>}
            />
            {shouldVideoGenerateWithLtxApi && (
              <SettingsDropdown title="FPS" value={String(settings.fps)}
                onChange={(v) => onSettingsChange({ ...settings, fps: parseInt(v) })}
                options={videoFpsOptions.map((value) => ({ value: String(value), label: `${value}` }))}
                trigger={<><Film className="h-3.5 w-3.5" /><span>{settings.fps} FPS</span></>}
              />
            )}
            <SettingsDropdown title="ASPECT RATIO" value={settings.aspectRatio}
              onChange={(v) => onSettingsChange({ ...settings, aspectRatio: v })}
              options={inputAudio ? [{ value: '16:9', label: '16:9' }] : [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }]}
              trigger={<><AspectIcon className="h-3.5 w-3.5" /><span>{settings.aspectRatio}</span></>}
            />
          </>
        )}
        
        <button
          onClick={onGenerate}
          disabled={isGenerating || !canGenerate}
          className={`flex items-center gap-1.5 ml-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all flex-shrink-0 ${
            isGenerating || !canGenerate ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed' : 'bg-white text-black hover:bg-zinc-200'
          }`}
        >
          <span className={isGenerating ? 'animate-pulse' : ''}>{buttonIcon}</span>
          {buttonLabel}
        </button>
      </div>
    </div>
  )
}
