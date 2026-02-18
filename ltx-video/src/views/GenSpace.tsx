import { useState, useRef, useEffect, useCallback } from 'react'
import { 
  Plus, Trash2, Download, Image, Video, X,
  Heart, Pencil, Film, Volume2, VolumeX, Sparkles,
  Music, Zap, Move3D, Clock, Monitor, ChevronUp, ChevronDown, Scissors, AudioLines,
  Paintbrush, ChevronLeft, ChevronRight
} from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { useGeneration } from '../hooks/use-generation'
import type { Asset } from '../types/project'
import { copyToAssetFolder } from '../lib/asset-copy'
import { fileUrlToPath } from '../lib/url-to-path'

// Asset card with hover overlays
function AssetCard({ 
  asset, 
  onDelete, 
  onPlay,
  onDragStart,
  onCreateVideo,
  onEditImage,
  onToggleFavorite
}: { 
  asset: Asset
  onDelete: () => void
  onPlay: () => void
  onDragStart: (e: React.DragEvent, asset: Asset) => void
  onCreateVideo?: (asset: Asset) => void
  onEditImage?: (asset: Asset) => void
  onToggleFavorite?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const isFavorite = asset.favorite || false

  useEffect(() => {
    if (asset.type === 'video' && videoRef.current) {
      if (isHovered) {
        videoRef.current.play().catch(() => {})
      } else {
        videoRef.current.pause()
        videoRef.current.currentTime = 0
        setCurrentTime(0)
      }
    }
  }, [isHovered, asset.type])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime)
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = asset.url
    a.download = asset.path.split('/').pop() || `${asset.type}-${asset.id}`
    a.click()
  }

  return (
    <div
      className="relative group cursor-pointer rounded-xl overflow-hidden bg-zinc-900"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onPlay}
      draggable
      onDragStart={(e) => onDragStart(e, asset)}
    >
      {asset.type === 'video' ? (
        <video 
          ref={videoRef}
          src={asset.url} 
          className="w-full aspect-video object-cover" 
          muted={isMuted}
          loop
          onTimeUpdate={handleTimeUpdate}
        />
      ) : (
        <img src={asset.url} alt="" className="w-full aspect-video object-cover" />
      )}
      
      {/* Favorite heart - always visible when favorited */}
      {isFavorite && !isHovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite?.() }}
          className="absolute top-2 left-2 p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white transition-colors z-10"
        >
          <Heart className="h-3.5 w-3.5 fill-current" />
        </button>
      )}
      
      {/* Hover overlay */}
      <div className={`absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30 transition-opacity duration-200 ${
        isHovered ? 'opacity-100' : 'opacity-0'
      }`}>
        {/* Top buttons */}
        <div className="absolute top-2 left-2 right-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite?.() }}
              className={`p-1.5 rounded-lg backdrop-blur-md transition-colors ${
                isFavorite ? 'bg-white/20 text-white' : 'bg-black/40 text-white hover:bg-black/60'
              }`}
            >
              <Heart className={`h-3.5 w-3.5 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
            
            {asset.type === 'image' && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onEditImage?.(asset) }}
                  className="px-2.5 py-1.5 rounded-lg bg-violet-500/70 backdrop-blur-md text-white hover:bg-violet-400/80 transition-colors flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
                >
                  <Paintbrush className="h-3 w-3" />
                  Edit
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onCreateVideo?.(asset) }}
                  className="px-2.5 py-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
                >
                  <Film className="h-3 w-3" />
                  Create video
                </button>
              </>
            )}
          </div>
          
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            {/* Tools button hidden for now */}
          </div>
        </div>
        
        {/* Bottom controls for video */}
        {asset.type === 'video' && (
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
            <div className="px-2 py-1 rounded-lg bg-black/50 backdrop-blur-md text-white text-xs font-mono">
              {formatTime(currentTime)}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setIsMuted(!isMuted) }}
              className="p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
            >
              {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
        
        {/* Delete button (subtle, bottom right for images) */}
        {asset.type === 'image' && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-red-600/70 backdrop-blur-md text-white hover:bg-red-500 transition-colors opacity-0 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      
      {/* Drag indicator */}
      <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-opacity ${
        isHovered ? 'opacity-0' : 'opacity-0'
      } group-active:opacity-100`}>
        <div className="p-3 rounded-full bg-violet-500/80 backdrop-blur-sm">
          <Move3D className="h-6 w-6 text-white" />
        </div>
      </div>
    </div>
  )
}

// Dropdown component for settings
function SettingsDropdown({ 
  trigger, 
  options, 
  value, 
  onChange,
  title 
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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])
  
  const btnRef = useRef<HTMLButtonElement>(null)
  
  return (
    <div ref={dropdownRef} className="relative">
      <button 
        ref={btnRef}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors"
      >
        {trigger}
      </button>
      
      {isOpen && (() => {
        const rect = btnRef.current?.getBoundingClientRect()
        const menuBottom = rect ? rect.top - 8 : 0
        const menuRight = rect ? rect.right : 0
        return (
          <>
            <div className="fixed inset-0 z-[9998]" onMouseDown={() => setIsOpen(false)} />
            <div
              className="fixed bg-zinc-800 border border-zinc-700 rounded-xl py-3 px-4 min-w-[160px] shadow-xl z-[9999]"
              style={{ bottom: window.innerHeight - menuBottom, right: window.innerWidth - menuRight }}
            >
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-3">{title}</div>
              <div className="space-y-1">
                {options.map(option => (
                  <div key={option.value} className="relative group/option">
                    <button
                      onClick={() => { if (!option.disabled) { onChange(option.value); setIsOpen(false) } }}
                      className={`w-full flex items-center justify-between px-2 py-2 rounded-lg transition-colors text-left ${
                        option.disabled 
                          ? 'cursor-not-allowed' 
                          : 'hover:bg-zinc-700'
                      }`}
                    >
                      <span className={`flex items-center gap-2.5 text-sm ${
                        option.disabled 
                          ? 'text-zinc-600' 
                          : value === option.value ? 'text-white' : 'text-zinc-400'
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
          </>
        )
      })()}
    </div>
  )
}

// Grid icon for variations
function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

// Square icon for aspect ratio
function AspectIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
    </svg>
  )
}

// Prompt bar component matching the design
// Two-row layout: prompt row on top, settings row below
function PromptBar({
  mode,
  onModeChange,
  prompt,
  onPromptChange,
  onGenerate,
  isGenerating,
  inputImage,
  onInputImageChange,
  settings,
  onSettingsChange,
}: {
  mode: 'image' | 'video'
  onModeChange: (mode: 'image' | 'video') => void
  prompt: string
  onPromptChange: (prompt: string) => void
  onGenerate: () => void
  isGenerating: boolean
  inputImage: string | null
  onInputImageChange: (url: string | null) => void
  settings: {
    model: string
    duration: number
    resolution: string
    aspectRatio: string
    imageResolution: string
    variations: number
    motion?: string
    audio?: boolean
  }
  onSettingsChange: (settings: any) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    
    const assetData = e.dataTransfer.getData('asset')
    if (assetData) {
      const asset = JSON.parse(assetData) as Asset
      if (asset.type === 'image') {
        onInputImageChange(asset.url)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      // In Electron, File objects have a .path property with the full filesystem path
      const filePath = (file as any).path as string | undefined
      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
        onInputImageChange(fileUrl)
      } else {
        const url = URL.createObjectURL(file)
        onInputImageChange(url)
      }
    }
  }
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && prompt.trim() && !isGenerating) {
      e.preventDefault()
      onGenerate()
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-visible">
      {/* Top row: Image ref | Prompt | Generate */}
      <div className="flex items-center">
        {/* Input image drop zone */}
        <div
          className={`relative w-10 h-10 mx-2 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center flex-shrink-0 cursor-pointer ${
            isDragOver ? 'border-violet-500 bg-violet-500/10' : 'border-zinc-700 hover:border-zinc-500'
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          {inputImage ? (
            <>
              <img src={inputImage} alt="" className="w-full h-full object-cover rounded-md" />
              <button
                onClick={(e) => { e.stopPropagation(); onInputImageChange(null) }}
                className="absolute -top-1 -right-1 p-0.5 rounded-full bg-zinc-800 text-zinc-400 hover:text-white z-10"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          ) : (
            <Plus className="h-4 w-4 text-zinc-500" />
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Prompt input - fills remaining width */}
        <div className="flex-1 min-w-0 py-1">
          <input
            type="text"
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'image' 
              ? (inputImage ? "Change the background to a sunset beach..." : "A close-up of a woman talking on the phone...")
              : "The woman sips from a cup of coffee..."
            }
            className="w-full bg-transparent text-white text-sm placeholder:text-zinc-500 focus:outline-none px-2 py-2"
          />
        </div>

      </div>
      
      {/* Bottom row: Mode selector + Settings */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-t border-zinc-800/60 text-xs text-zinc-400">
        {/* Mode dropdown */}
        <SettingsDropdown
          title="MODE"
          value={mode}
          onChange={(v) => onModeChange(v as 'image' | 'video')}
          options={[
            { value: 'image', label: 'Generate Images', icon: <Image className="h-4 w-4" /> },
            { value: 'video', label: 'Generate Videos', icon: <Video className="h-4 w-4" /> },
            { value: 'audio-to-video', label: 'Audio to Video', icon: <AudioLines className="h-4 w-4" />, disabled: true, tooltip: 'Coming soon' },
            { value: 'retake', label: 'Retake', icon: <Scissors className="h-4 w-4" />, disabled: true, tooltip: 'Coming soon' },
          ]}
          trigger={
            <>
              {mode === 'image' ? <Image className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
              <span className="text-zinc-300 font-medium">{mode === 'image' ? 'Image' : 'Video'}</span>
              <ChevronUp className="h-3 w-3 text-zinc-500" />
            </>
          }
        />
        
        <div className="flex-1" />
        
        {mode === 'image' ? (
          <>
            {/* Model indicator */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800/50">
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-zinc-300 font-medium">FLUX Klein</span>
            </div>
            
            {/* Resolution dropdown */}
            <SettingsDropdown
              title="IMAGE RESOLUTION"
              value={settings.imageResolution}
              onChange={(v) => onSettingsChange({ ...settings, imageResolution: v })}
              options={[
                { value: '1080p', label: '1080p' },
                { value: '1440p', label: '1440p' },
                { value: '2048p', label: '2048p' },
              ]}
              trigger={
                <>
                  <Monitor className="h-3.5 w-3.5" />
                  <span>{settings.imageResolution.replace('p', '')}</span>
                </>
              }
            />
            
            {/* Aspect ratio dropdown */}
            <SettingsDropdown
              title="RATIO"
              value={settings.aspectRatio}
              onChange={(v) => onSettingsChange({ ...settings, aspectRatio: v })}
              options={[
                { value: '16:9', label: '16:9' },
                { value: '1:1', label: '1:1' },
                { value: '9:16', label: '9:16' },
              ]}
              trigger={
                <>
                  <AspectIcon className="h-3.5 w-3.5" />
                  <span>{settings.aspectRatio}</span>
                </>
              }
            />
            
            {/* Variations dropdown */}
            <SettingsDropdown
              title="VARIATIONS"
              value={String(settings.variations)}
              onChange={(v) => onSettingsChange({ ...settings, variations: parseInt(v) })}
              options={[
                { value: '12', label: '12' },
                { value: '9', label: '9' },
                { value: '6', label: '6' },
                { value: '3', label: '3' },
                { value: '1', label: '1' },
              ]}
              trigger={
                <>
                  <GridIcon className="h-3.5 w-3.5" />
                  <span>{settings.variations}</span>
                </>
              }
            />
          </>
        ) : (
          <>
            {/* Model dropdown */}
            <SettingsDropdown
              title="MODEL"
              value={settings.model}
              onChange={(v) => onSettingsChange({ ...settings, model: v })}
              options={[
                { value: 'fast', label: 'LTX-2 Fast' },
                { value: 'pro', label: 'LTX-2 Pro' },
              ]}
              trigger={
                <>
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-zinc-300 font-medium">{settings.model === 'fast' ? 'LTX-2 Fast' : 'LTX-2 Pro'}</span>
                </>
              }
            />
            
            {/* Motion dropdown */}
            <SettingsDropdown
              title="MOTION"
              value={settings.motion || 'normal'}
              onChange={(v) => onSettingsChange({ ...settings, motion: v })}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'normal', label: 'Normal' },
                { value: 'high', label: 'High' },
                { value: 'extreme', label: 'Extreme' },
              ]}
              trigger={
                <>
                  <Move3D className="h-3.5 w-3.5" />
                  <span>{(settings.motion || 'normal').charAt(0).toUpperCase() + (settings.motion || 'normal').slice(1)}</span>
                </>
              }
            />
            
            {/* Audio toggle */}
            <button 
              onClick={() => onSettingsChange({ ...settings, audio: !settings.audio })}
              className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors relative"
            >
              <Music className="h-3.5 w-3.5" />
              <span className={settings.audio ? 'text-zinc-300' : 'text-zinc-500'}>{settings.audio ? 'On' : 'Off'}</span>
              <span className="absolute -top-2 -right-2 text-[8px] bg-blue-500 text-white px-1 rounded leading-tight">BETA</span>
            </button>
            
            <div className="w-px h-4 bg-zinc-700 mx-0.5" />
            
            {/* Duration dropdown */}
            <SettingsDropdown
              title="DURATION"
              value={String(settings.duration)}
              onChange={(v) => onSettingsChange({ ...settings, duration: parseFloat(v) })}
              options={[
                { value: '5', label: '5 Sec' },
                { value: '6', label: '6 Sec' },
                { value: '8', label: '8 Sec' },
                { value: '10', label: '10 Sec' },
                { value: '20', label: '20 Sec' },
              ]}
              trigger={
                <>
                  <Clock className="h-3.5 w-3.5" />
                  <span>{settings.duration}s</span>
                </>
              }
            />
            
            {/* Resolution dropdown */}
            <SettingsDropdown
              title="RESOLUTION"
              value={settings.resolution}
              onChange={(v) => onSettingsChange({ ...settings, resolution: v })}
              options={[
                { value: '540p', label: '540p' },
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
              ]}
              trigger={
                <>
                  <Monitor className="h-3.5 w-3.5" />
                  <span>{settings.resolution.replace('p', '')}</span>
                </>
              }
            />
            
            {/* Aspect Ratio dropdown */}
            <SettingsDropdown
              title="ASPECT RATIO"
              value={settings.aspectRatio}
              onChange={(v) => onSettingsChange({ ...settings, aspectRatio: v })}
              options={[
                { value: '1:1', label: '1:1', disabled: true, tooltip: 'Coming soon' },
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16', disabled: true, tooltip: 'Coming soon' },
              ]}
              trigger={
                <>
                  <AspectIcon className="h-3.5 w-3.5" />
                  <span>{settings.aspectRatio}</span>
                </>
              }
            />
            
            {/* Variations dropdown */}
            <SettingsDropdown
              title="VARIATIONS"
              value={String(settings.variations)}
              onChange={(v) => onSettingsChange({ ...settings, variations: parseInt(v) })}
              options={[
                { value: '12', label: '12' },
                { value: '9', label: '9' },
                { value: '6', label: '6' },
                { value: '3', label: '3' },
                { value: '1', label: '1' },
              ]}
              trigger={
                <>
                  <GridIcon className="h-3.5 w-3.5" />
                  <span>{settings.variations}</span>
                </>
              }
            />
          </>
        )}
        
        {/* Generate button */}
        <button
          onClick={onGenerate}
          disabled={isGenerating || !prompt.trim()}
          className={`flex items-center gap-1.5 ml-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${
            isGenerating || !prompt.trim()
              ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
              : 'bg-white text-black hover:bg-zinc-200'
          }`}
        >
          <Sparkles className={`h-3.5 w-3.5 ${isGenerating ? 'animate-pulse' : ''}`} />
          Generate
        </button>
      </div>
    </div>
  )
}

// Gallery size icon components
function GridSmallIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="2" y="2" width="4" height="4" rx="0.5" />
      <rect x="8" y="2" width="4" height="4" rx="0.5" />
      <rect x="14" y="2" width="4" height="4" rx="0.5" />
      <rect x="20" y="2" width="2" height="4" rx="0.5" />
      <rect x="2" y="8" width="4" height="4" rx="0.5" />
      <rect x="8" y="8" width="4" height="4" rx="0.5" />
      <rect x="14" y="8" width="4" height="4" rx="0.5" />
      <rect x="20" y="8" width="2" height="4" rx="0.5" />
      <rect x="2" y="14" width="4" height="4" rx="0.5" />
      <rect x="8" y="14" width="4" height="4" rx="0.5" />
      <rect x="14" y="14" width="4" height="4" rx="0.5" />
      <rect x="20" y="14" width="2" height="4" rx="0.5" />
    </svg>
  )
}

function GridMediumIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="2" y="2" width="6" height="6" rx="1" />
      <rect x="10" y="2" width="6" height="6" rx="1" />
      <rect x="18" y="2" width="4" height="6" rx="1" />
      <rect x="2" y="10" width="6" height="6" rx="1" />
      <rect x="10" y="10" width="6" height="6" rx="1" />
      <rect x="18" y="10" width="4" height="6" rx="1" />
      <rect x="2" y="18" width="6" height="4" rx="1" />
      <rect x="10" y="18" width="6" height="4" rx="1" />
      <rect x="18" y="18" width="4" height="4" rx="1" />
    </svg>
  )
}

function GridLargeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="2" y="2" width="9" height="9" rx="1.5" />
      <rect x="13" y="2" width="9" height="9" rx="1.5" />
      <rect x="2" y="13" width="9" height="9" rx="1.5" />
      <rect x="13" y="13" width="9" height="9" rx="1.5" />
    </svg>
  )
}

type GallerySize = 'small' | 'medium' | 'large'

const gallerySizeClasses: Record<GallerySize, string> = {
  small: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7',
  medium: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
  large: 'grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3',
}

export function GenSpace() {
  const { currentProject, currentProjectId, addAsset, deleteAsset, toggleFavorite, genSpaceEditImageUrl, setGenSpaceEditImageUrl, genSpaceEditMode, setGenSpaceEditMode } = useProjects()
  const [mode, setMode] = useState<'image' | 'video'>('video')
  const [prompt, setPrompt] = useState('')
  const [inputImage, setInputImage] = useState<string | null>(null)
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)
  const [showFavorites, setShowFavorites] = useState(false)
  const [gallerySize, setGallerySize] = useState<GallerySize>('medium')
  const [showSizeMenu, setShowSizeMenu] = useState(false)
  const sizeMenuRef = useRef<HTMLDivElement>(null)
  const [settings, setSettings] = useState({
    model: 'fast',
    duration: 5,
    resolution: '540p',
    aspectRatio: '16:9',
    imageResolution: '1080p',
    variations: 1,
    motion: 'normal',
    audio: true,
  })
  
  const {
    generate,
    generateImage,
    editImage,
    isGenerating,
    progress,
    statusMessage,
    videoUrl,
    videoPath,
    imageUrls,
  } = useGeneration()
  
  // Handle incoming frame from the Video Editor for editing
  useEffect(() => {
    if (genSpaceEditImageUrl) {
      const targetMode = genSpaceEditMode || 'image'
      setMode(targetMode)
      setInputImage(genSpaceEditImageUrl)
      setPrompt('')
      setGenSpaceEditImageUrl(null)
      setGenSpaceEditMode(null)
    }
  }, [genSpaceEditImageUrl, setGenSpaceEditImageUrl, genSpaceEditMode, setGenSpaceEditMode])

  // Only show assets that were generated (have generationParams), not imported files
  const assets = (currentProject?.assets || []).filter(a => a.generationParams)
  const [lastPrompt, setLastPrompt] = useState('')
  
  const assetSavePath = currentProject?.assetSavePath

  // When video generation completes, add to project assets
  useEffect(() => {
    if (videoUrl && videoPath && currentProjectId && !isGenerating) {
      const exists = assets.some(a => a.url === videoUrl)
      if (!exists) {
        const genMode = inputImage ? 'image-to-video' : 'text-to-video'
        ;(async () => {
          const { path: finalPath, url: finalUrl } = await copyToAssetFolder(videoPath, videoUrl, assetSavePath)
          addAsset(currentProjectId, {
            type: 'video',
            path: finalPath,
            url: finalUrl,
            prompt: lastPrompt,
            resolution: settings.resolution,
            duration: settings.duration,
            generationParams: {
              mode: genMode as 'text-to-video' | 'image-to-video',
              prompt: lastPrompt,
              model: settings.model,
              duration: settings.duration,
              resolution: settings.resolution,
              fps: 24,
              audio: settings.audio || false,
              cameraMotion: 'none',
              imageAspectRatio: settings.aspectRatio,
              imageSteps: 4,
              inputImageUrl: inputImage || undefined,
            },
            takes: [{
              url: finalUrl,
              path: finalPath,
              createdAt: Date.now(),
            }],
            activeTakeIndex: 0,
          })
        })()
      }
    }
  }, [videoUrl, videoPath, currentProjectId, isGenerating])
  
  // When image generation/editing completes, add all images to project assets
  useEffect(() => {
    if (imageUrls.length > 0 && currentProjectId && !isGenerating) {
      const genMode = inputImage ? 'image-edit' : 'text-to-image'
      ;(async () => {
        for (const imageUrl of imageUrls) {
          const exists = assets.some(a => a.url === imageUrl)
          if (!exists) {
            const { path: finalPath, url: finalUrl } = await copyToAssetFolder(imageUrl, imageUrl, assetSavePath)
            addAsset(currentProjectId, {
              type: 'image',
              path: finalPath,
              url: finalUrl,
              prompt: lastPrompt,
              resolution: settings.imageResolution,
              generationParams: {
                mode: genMode as any,
                prompt: lastPrompt,
                model: 'fast',
                duration: 5,
                resolution: settings.imageResolution,
                fps: 24,
                audio: false,
                cameraMotion: 'none',
                imageAspectRatio: settings.aspectRatio,
                imageSteps: 4,
                inputImageUrl: genMode === 'image-edit' ? inputImage || undefined : undefined,
              },
              takes: [{
                url: finalUrl,
                path: finalPath,
                createdAt: Date.now(),
              }],
              activeTakeIndex: 0,
            })
          }
        }
      })()
    }
  }, [imageUrls, currentProjectId, isGenerating])
  
  const handleGenerate = async () => {
    if (!prompt.trim()) return
    
    // Save the prompt before generation starts
    setLastPrompt(prompt)
    
    if (mode === 'image') {
      if (inputImage) {
        // Image + input image → edit image mode (auto-detected)
        let imageFile: File | null = null
        try {
          if (inputImage.startsWith('blob:')) {
            const response = await fetch(inputImage)
            const blob = await response.blob()
            imageFile = new File([blob], 'input-image.png', { type: blob.type })
          } else if (inputImage.startsWith('file:///') || inputImage.startsWith('file://')) {
            let filePath = inputImage
            if (filePath.startsWith('file:///')) filePath = filePath.slice(8)
            else if (filePath.startsWith('file://')) filePath = filePath.slice(7)
            filePath = decodeURIComponent(filePath)
            const fileName = filePath.split(/[/\\]/).pop() || 'input-image.png'
            
            const img = document.createElement('img')
            img.crossOrigin = 'anonymous'
            const blob = await new Promise<Blob>((resolve, reject) => {
              img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                const ctx = canvas.getContext('2d')
                if (!ctx) { reject(new Error('No canvas context')); return }
                ctx.drawImage(img, 0, 0)
                canvas.toBlob((b) => {
                  if (b) resolve(b)
                  else reject(new Error('Failed to convert canvas to blob'))
                }, 'image/png')
              }
              img.onerror = () => reject(new Error('Failed to load image'))
              img.src = inputImage
            })
            imageFile = new File([blob], fileName, { type: 'image/png' })
          } else if (inputImage.startsWith('http://') || inputImage.startsWith('https://')) {
            const response = await fetch(inputImage)
            const blob = await response.blob()
            imageFile = new File([blob], 'input-image.png', { type: blob.type })
          }
        } catch (e) {
          console.error('Failed to convert input image for editing:', e)
          return
        }
        
        if (!imageFile) return
        
        editImage(
          prompt,
          [imageFile],
          {
            model: 'fast' as 'fast' | 'pro',
            duration: 5,
            resolution: settings.resolution,
            fps: 24,
            audio: false,
            cameraMotion: 'none',
            imageAspectRatio: settings.aspectRatio,
            imageSteps: 4,
          }
        )
      } else {
        // No input image → generate image(s)
        generateImage(
          prompt,
          {
            model: 'fast' as 'fast' | 'pro',
            duration: 5,
            resolution: settings.resolution,
            fps: 24,
            audio: false,
            cameraMotion: 'none',
            imageAspectRatio: settings.aspectRatio,
            imageSteps: 4,
            variations: settings.variations,
          }
        )
      }
    } else {
      // Generate video (t2v if no image, i2v if image is provided)
      // Extract filesystem path from the file:// URL for the backend
      const imagePath = inputImage ? fileUrlToPath(inputImage) : null

      generate(
        prompt,
        imagePath,
        {
          model: settings.model as 'fast' | 'pro',
          duration: settings.duration,
          resolution: settings.resolution,
          fps: 24,
          audio: settings.audio || false,
          cameraMotion: 'none',
          imageAspectRatio: settings.aspectRatio,
          imageSteps: 4,
        }
      )
    }
  }
  
  const handleDelete = (assetId: string) => {
    if (currentProjectId) {
      deleteAsset(currentProjectId, assetId)
    }
  }
  
  const handleDragStart = (e: React.DragEvent, asset: Asset) => {
    e.dataTransfer.setData('asset', JSON.stringify(asset))
    e.dataTransfer.setData('assetId', asset.id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  
  const handleCreateVideo = (imageAsset: Asset) => {
    setMode('video')
    setInputImage(imageAsset.url)
    setPrompt(`${imageAsset.prompt || 'The scene comes to life...'}`)
  }
  
  const handleEditImage = (imageAsset: Asset) => {
    setMode('image')
    setInputImage(imageAsset.url)
    setPrompt('')
  }
  
  // Close size menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(e.target as Node)) {
        setShowSizeMenu(false)
      }
    }
    if (showSizeMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSizeMenu])

  const filteredAssets = showFavorites ? assets.filter(a => a.favorite) : assets
  const favoriteCount = assets.filter(a => a.favorite).length

  // Navigation for the asset preview modal
  const selectedIndex = selectedAsset ? filteredAssets.findIndex(a => a.id === selectedAsset.id) : -1
  const canGoPrev = selectedIndex > 0
  const canGoNext = selectedIndex >= 0 && selectedIndex < filteredAssets.length - 1

  const goToPrev = useCallback(() => {
    if (canGoPrev) setSelectedAsset(filteredAssets[selectedIndex - 1])
  }, [canGoPrev, filteredAssets, selectedIndex])

  const goToNext = useCallback(() => {
    if (canGoNext) setSelectedAsset(filteredAssets[selectedIndex + 1])
  }, [canGoNext, filteredAssets, selectedIndex])

  // Keyboard navigation for the preview modal
  useEffect(() => {
    if (!selectedAsset) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goToPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goToNext() }
      else if (e.key === 'Escape') setSelectedAsset(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectedAsset, goToPrev, goToNext])

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Top bar with Favorites and Gallery Size */}
      {(assets.length > 0 || isGenerating) && (
        <div className="flex items-center justify-end px-6 pt-4 pb-0 gap-2">
          {/* Favorites filter */}
          <button
            onClick={() => setShowFavorites(!showFavorites)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showFavorites 
                ? 'bg-red-500/20 text-red-400 border border-red-500/30' 
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
          >
            <Heart className={`h-4 w-4 ${showFavorites ? 'fill-current' : ''}`} />
            Favorites
            {favoriteCount > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                showFavorites ? 'bg-red-500/30 text-red-300' : 'bg-zinc-800 text-zinc-500'
              }`}>
                {favoriteCount}
              </span>
            )}
          </button>
          
          {/* Gallery size */}
          <div ref={sizeMenuRef} className="relative">
            <button
              onClick={() => setShowSizeMenu(!showSizeMenu)}
              className={`p-2 rounded-lg transition-colors ${
                showSizeMenu ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              }`}
            >
              {gallerySize === 'small' ? <GridSmallIcon className="h-4 w-4" /> : 
               gallerySize === 'medium' ? <GridMediumIcon className="h-4 w-4" /> : 
               <GridLargeIcon className="h-4 w-4" />}
            </button>
            
            {showSizeMenu && (
              <div className="absolute top-full mt-2 right-0 bg-zinc-800 border border-zinc-700 rounded-xl py-3 px-4 min-w-[160px] shadow-xl z-50">
                {([
                  { value: 'small' as GallerySize, label: 'Small', icon: GridSmallIcon },
                  { value: 'medium' as GallerySize, label: 'Medium', icon: GridMediumIcon },
                  { value: 'large' as GallerySize, label: 'Large', icon: GridLargeIcon },
                ]).map(option => (
                  <button
                    key={option.value}
                    onClick={() => { setGallerySize(option.value); setShowSizeMenu(false) }}
                    className="w-full flex items-center justify-between px-2 py-2.5 rounded-lg hover:bg-zinc-700 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <option.icon className={`h-4 w-4 ${gallerySize === option.value ? 'text-white' : 'text-zinc-500'}`} />
                      <span className={`text-sm ${gallerySize === option.value ? 'text-white font-medium' : 'text-zinc-400'}`}>
                        {option.label}
                      </span>
                    </div>
                    {gallerySize === option.value && (
                      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Assets grid */}
      <div className="flex-1 overflow-auto p-6">
        {assets.length === 0 && !isGenerating ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 rounded-2xl bg-zinc-900 border-2 border-dashed border-zinc-700 flex items-center justify-center mb-4">
              <Sparkles className="h-10 w-10 text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Start Creating</h3>
            <p className="text-zinc-500 max-w-md">
              Use the prompt bar below to generate images and videos. 
              Drag assets into the input box to use them as references.
            </p>
          </div>
        ) : showFavorites && filteredAssets.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <Heart className="h-12 w-12 text-zinc-700 mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">No favorites yet</h3>
            <p className="text-zinc-500 text-sm">
              Click the heart icon on any asset to add it to your favorites.
            </p>
          </div>
        ) : (
          <div className={`grid ${gallerySizeClasses[gallerySize]} gap-4`}>
            {/* Generating placeholder */}
            {isGenerating && (
              <div className="relative rounded-xl overflow-hidden bg-zinc-900 aspect-video">
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="relative w-16 h-16 mb-3">
                    <div className="absolute inset-0 rounded-full border-2 border-violet-500/30" />
                    <div 
                      className="absolute inset-0 rounded-full border-2 border-violet-500 border-t-transparent animate-spin"
                    />
                    <div className="absolute inset-2 rounded-full bg-zinc-800 flex items-center justify-center">
                      <Sparkles className="h-6 w-6 text-violet-400" />
                    </div>
                  </div>
                  <p className="text-sm text-zinc-400">{statusMessage || 'Generating...'}</p>
                  {progress > 0 && (
                    <div className="w-32 h-1 bg-zinc-800 rounded-full mt-2 overflow-hidden">
                      <div 
                        className="h-full bg-violet-500 transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* Assets */}
            {filteredAssets.map(asset => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onDelete={() => handleDelete(asset.id)}
                onPlay={() => setSelectedAsset(asset)}
                onDragStart={handleDragStart}
                onCreateVideo={handleCreateVideo}
                onEditImage={handleEditImage}
                onToggleFavorite={() => currentProjectId && toggleFavorite(currentProjectId, asset.id)}
              />
            ))}
          </div>
        )}
      </div>
      
      {/* Bottom prompt bar */}
      <div className="border-t border-zinc-800 p-4 bg-zinc-950">
        <div className="max-w-5xl mx-auto">
          <PromptBar
            mode={mode}
            onModeChange={setMode}
            prompt={prompt}
            onPromptChange={setPrompt}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            inputImage={inputImage}
            onInputImageChange={setInputImage}
            settings={settings}
            onSettingsChange={setSettings}
          />
        </div>
      </div>
      
      {/* Asset preview modal */}
      {selectedAsset && (
        <div 
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setSelectedAsset(null)}
        >
          {/* Previous button */}
          <button
            onClick={(e) => { e.stopPropagation(); goToPrev() }}
            disabled={!canGoPrev}
            className={`absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full backdrop-blur-md transition-all ${
              canGoPrev
                ? 'bg-white/10 text-white hover:bg-white/20 cursor-pointer'
                : 'bg-white/5 text-zinc-600 cursor-default'
            }`}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>

          {/* Next button */}
          <button
            onClick={(e) => { e.stopPropagation(); goToNext() }}
            disabled={!canGoNext}
            className={`absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full backdrop-blur-md transition-all ${
              canGoNext
                ? 'bg-white/10 text-white hover:bg-white/20 cursor-pointer'
                : 'bg-white/5 text-zinc-600 cursor-default'
            }`}
          >
            <ChevronRight className="h-6 w-6" />
          </button>

          {/* Content area */}
          <div className="relative max-w-5xl w-full max-h-full px-20 py-8" onClick={e => e.stopPropagation()}>
            {/* Top bar: counter + close */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-zinc-500 font-medium">
                {selectedIndex + 1} / {filteredAssets.length}
              </span>
              <button
                onClick={() => setSelectedAsset(null)}
                className="p-2 rounded-lg text-zinc-400 hover:text-white transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {selectedAsset.type === 'video' ? (
              <video
                key={selectedAsset.id}
                src={selectedAsset.url}
                controls
                autoPlay
                className="w-full rounded-xl"
              />
            ) : (
              <img
                key={selectedAsset.id}
                src={selectedAsset.url}
                alt=""
                className="w-full rounded-xl object-contain max-h-[75vh]"
              />
            )}
            <div className="mt-4 text-center">
              <p className="text-zinc-300">{selectedAsset.prompt}</p>
              <p className="text-zinc-500 text-sm mt-1">
                {selectedAsset.resolution} • {selectedAsset.duration ? `${selectedAsset.duration}s` : 'Image'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
