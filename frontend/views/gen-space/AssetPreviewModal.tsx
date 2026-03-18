import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, Copy, Check } from 'lucide-react'
import type { Asset } from '@/types/project'
import { TagInput } from '@/components/TagInput'

function ModalNameEditor({ asset, onSave }: { asset: Asset; onSave: (name: string) => void }) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(asset.name || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(asset.name || '')
  }, [asset.id, asset.name])

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const save = () => {
    onSave(value.trim())
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') { setIsEditing(false); setValue(asset.name || '') }
        }}
        onBlur={save}
        className="bg-zinc-800 text-lg text-zinc-100 font-medium rounded-lg px-3 py-1.5 outline-none ring-1 ring-zinc-600 focus:ring-violet-500 text-center max-w-md w-full"
        maxLength={60}
        placeholder="Add a name..."
      />
    )
  }

  return (
    <button
      onClick={() => setIsEditing(true)}
      className={`text-lg font-medium rounded-lg px-3 py-1.5 hover:bg-zinc-800/60 transition-colors max-w-md truncate ${
        asset.name ? 'text-zinc-100' : 'text-zinc-500 italic'
      }`}
    >
      {asset.name || 'Add a name...'}
    </button>
  )
}

export function AssetPreviewModal({
  asset,
  assets,
  projectTags,
  onClose,
  onUpdateAsset,
}: {
  asset: Asset
  assets: Asset[]
  projectTags: string[]
  onClose: () => void
  onUpdateAsset: (assetId: string, updates: Partial<Asset>) => void
}) {
  const [selectedAsset, setSelectedAsset] = useState(asset)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  useEffect(() => {
    setSelectedAsset(asset)
  }, [asset])

  const selectedIndex = assets.findIndex(a => a.id === selectedAsset.id)
  const canGoPrev = selectedIndex > 0
  const canGoNext = selectedIndex >= 0 && selectedIndex < assets.length - 1

  const goToPrev = useCallback(() => {
    if (canGoPrev) setSelectedAsset(assets[selectedIndex - 1])
  }, [canGoPrev, assets, selectedIndex])

  const goToNext = useCallback(() => {
    if (canGoNext) setSelectedAsset(assets[selectedIndex + 1])
  }, [canGoNext, assets, selectedIndex])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goToPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goToNext() }
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goToPrev, goToNext, onClose])

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
      onClick={onClose}
    >
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

      <div className="relative max-w-5xl w-full max-h-full px-20 py-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-zinc-500 font-medium">
            {selectedIndex + 1} / {assets.length}
          </span>
          <button
            onClick={onClose}
            className="p-2 rounded-md text-zinc-400 hover:text-white transition-colors"
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
            className="w-full rounded-xl object-contain max-h-[75vh]"
          />
        ) : (
          <img
            key={selectedAsset.id}
            src={selectedAsset.url}
            alt=""
            className="w-full rounded-xl object-contain max-h-[75vh]"
          />
        )}
        <div className="mt-4">
          <div className="flex justify-center mb-2">
            <ModalNameEditor
              asset={selectedAsset}
              onSave={(name) => {
                onUpdateAsset(selectedAsset.id, { name: name || undefined })
                setSelectedAsset({ ...selectedAsset, name: name || undefined })
              }}
            />
          </div>

          <div className="flex justify-center mb-3">
            <div className="max-w-md w-full">
              <TagInput
                tags={selectedAsset.tags || []}
                onTagsChange={(tags) => {
                  onUpdateAsset(selectedAsset.id, { tags })
                  setSelectedAsset({ ...selectedAsset, tags })
                }}
                suggestions={projectTags}
                placeholder="Add tag..."
              />
            </div>
          </div>

          <div className="text-center">
            <div className="inline-flex items-start gap-2 max-w-full">
              <p className="text-zinc-400 text-sm">{selectedAsset.prompt}</p>
              {selectedAsset.prompt && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(selectedAsset.prompt)
                    setCopiedPrompt(true)
                    setTimeout(() => setCopiedPrompt(false), 2000)
                  }}
                  className="shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                  title="Copy prompt"
                >
                  {copiedPrompt ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              )}
            </div>
            <p className="text-zinc-500 text-sm mt-1">
              {selectedAsset.resolution} • {selectedAsset.duration ? `${selectedAsset.duration}s` : 'Image'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
