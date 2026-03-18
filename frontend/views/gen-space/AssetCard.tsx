import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Trash2, Download, Heart, Film, Volume2, VolumeX, Sparkles,
  Scissors, Tag
} from 'lucide-react'
import type { Asset } from '@/types/project'
import { TagInput, TagPills } from '@/components/TagInput'
import { formatDuration } from '@/lib/utils'

export function AssetCard({
  asset,
  onDelete,
  onPlay,
  onDragStart,
  onCreateVideo,
  onRetake,
  onIcLora,
  onToggleFavorite,
  onUpdateName,
  onUpdateTags,
  onContextMenu,
  onArchive,
  projectTags,
}: {
  asset: Asset
  onDelete: () => void
  onPlay: () => void
  onDragStart: (e: React.DragEvent, asset: Asset) => void
  onCreateVideo?: (asset: Asset) => void
  onRetake?: (asset: Asset) => void
  onIcLora?: (asset: Asset) => void
  onToggleFavorite?: () => void
  onUpdateName?: (name: string) => void
  onUpdateTags?: (tags: string[]) => void
  onContextMenu?: (e: React.MouseEvent) => void
  onArchive?: () => void
  projectTags?: string[]
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState(asset.name || '')
  const [showTagPopover, setShowTagPopover] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const tagPopoverRef = useRef<HTMLDivElement>(null)
  const isFavorite = asset.favorite || false

  const displayName = asset.name || asset.prompt?.slice(0, 40) || 'Untitled'
  const hasCustomName = !!asset.name
  const assetTags = asset.tags || []

  const saveName = useCallback(() => {
    const trimmed = editNameValue.trim()
    onUpdateName?.(trimmed)
    setIsEditingName(false)
  }, [editNameValue, onUpdateName])

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [isEditingName])

  useEffect(() => {
    if (!showTagPopover) return
    const handleClickOutside = (e: MouseEvent) => {
      if (tagPopoverRef.current && !tagPopoverRef.current.contains(e.target as Node)) {
        setShowTagPopover(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showTagPopover])

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

  useEffect(() => {
    if (!isHovered || isEditingName || showTagPopover) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onArchive?.()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isHovered, isEditingName, showTagPopover, onArchive])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime)
    }
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
      className={`relative group cursor-pointer rounded-xl bg-zinc-900 ${asset.archived ? 'opacity-50' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onPlay}
      onContextMenu={onContextMenu}
      draggable={asset.type === 'image'}
      onDragStart={(e) => asset.type === 'image' && onDragStart(e, asset)}
    >
      <div className="relative rounded-t-xl overflow-hidden">
        {asset.type === 'video' ? (
          <video 
            ref={videoRef}
            src={asset.url} 
            className="w-full aspect-video object-contain"
            muted={isMuted}
            loop
            onTimeUpdate={handleTimeUpdate}
          />
        ) : (
          <img src={asset.url} alt="" className="w-full aspect-video object-contain" />
        )}
        
        {isFavorite && !isHovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite?.() }}
            className="absolute top-2 left-2 p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white transition-colors z-10"
          >
            <Heart className="h-3.5 w-3.5 fill-current" />
          </button>
        )}
        
        <div className={`absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30 transition-opacity duration-200 ${
          isHovered ? 'opacity-100' : 'opacity-0'
        }`}>
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
                <button
                  onClick={(e) => { e.stopPropagation(); onCreateVideo?.(asset) }}
                  className="px-2.5 py-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
                >
                  <Film className="h-3 w-3" />
                  Create video
                </button>
              )}
              {asset.type === 'video' && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRetake?.(asset) }}
                    className="px-2.5 py-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
                  >
                    <Scissors className="h-3 w-3" />
                    Retake
                  </button>
                  {onIcLora && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onIcLora(asset) }}
                      className="px-2.5 py-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
                    >
                      <Sparkles className="h-3 w-3" />
                      IC-LoRA
                    </button>
                  )}
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
              <button
                onClick={(e) => { e.stopPropagation(); onDelete() }}
                className="p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white/70 hover:bg-red-500/80 hover:text-white transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          
          {asset.type === 'video' && (
            <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="px-2 py-1 rounded-lg bg-black/50 backdrop-blur-md text-white text-xs font-mono">
                  {formatDuration(currentTime)}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setIsMuted(!isMuted) }}
                  className="p-1.5 rounded-lg bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors"
                >
                  {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-2 py-1.5 bg-zinc-900 rounded-b-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName()
                if (e.key === 'Escape') { setIsEditingName(false); setEditNameValue(asset.name || '') }
              }}
              onBlur={saveName}
              className="flex-1 bg-zinc-800 text-xs text-zinc-200 rounded px-1.5 py-0.5 outline-none ring-1 ring-zinc-600 focus:ring-violet-500 min-w-0"
              maxLength={60}
              placeholder="Add a name..."
            />
          ) : (
            <button
              className={`flex-1 text-left text-xs truncate min-w-0 rounded px-1 py-0.5 hover:bg-zinc-800 transition-colors ${
                hasCustomName ? 'text-zinc-200' : 'text-zinc-500 italic'
              }`}
              onClick={() => { setEditNameValue(asset.name || ''); setIsEditingName(true) }}
              title={hasCustomName ? displayName : 'Click to add a name'}
            >
              {displayName}
            </button>
          )}
          {!isEditingName && (
            <div className="relative">
              <button
                className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                onClick={() => setShowTagPopover(!showTagPopover)}
                title="Add tags"
              >
                <Tag className="h-3 w-3" />
              </button>
              {showTagPopover && (
                <div
                  ref={tagPopoverRef}
                  className="absolute right-0 bottom-full mb-1 z-50 w-48 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <TagInput
                    tags={assetTags}
                    onTagsChange={(tags) => onUpdateTags?.(tags)}
                    suggestions={projectTags}
                    compact
                    placeholder="Add tag..."
                  />
                </div>
              )}
            </div>
          )}
        </div>
        {assetTags.length > 0 && (
          <div className="mt-0.5">
            <TagPills tags={assetTags} max={3} compact />
          </div>
        )}
      </div>
    </div>
  )
}
