import { useState, useRef, useEffect } from 'react'
import { Image, Video, Heart, Archive, ChevronDown } from 'lucide-react'

export type TypeFilter = 'all' | 'image' | 'video'
export type SortMode = 'newest' | 'oldest' | 'name-asc' | 'name-desc'

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

export type GallerySize = 'small' | 'medium' | 'large'

export const gallerySizeClasses: Record<GallerySize, string> = {
  small: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7',
  medium: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
  large: 'grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3',
}

const SORT_LABELS: Record<SortMode, string> = {
  'newest': 'Newest',
  'oldest': 'Oldest',
  'name-asc': 'Name A-Z',
  'name-desc': 'Name Z-A',
}

interface FilterSortBarProps {
  typeFilter: TypeFilter
  onTypeFilterChange: (filter: TypeFilter) => void
  sortMode: SortMode
  onSortModeChange: (mode: SortMode) => void
  showFavorites: boolean
  onShowFavoritesChange: (show: boolean) => void
  favoriteCount: number
  showArchived: boolean
  onShowArchivedChange: (show: boolean) => void
  gallerySize: GallerySize
  onGallerySizeChange: (size: GallerySize) => void
  imageCount: number
  videoCount: number
}

export function FilterSortBar({
  typeFilter,
  onTypeFilterChange,
  sortMode,
  onSortModeChange,
  showFavorites,
  onShowFavoritesChange,
  favoriteCount,
  showArchived,
  onShowArchivedChange,
  gallerySize,
  onGallerySizeChange,
  imageCount,
  videoCount,
}: FilterSortBarProps) {
  const [showSortMenu, setShowSortMenu] = useState(false)
  const [showSizeMenu, setShowSizeMenu] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setShowSortMenu(false)
      if (sizeRef.current && !sizeRef.current.contains(e.target as Node)) setShowSizeMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const typeBtn = (filter: TypeFilter, label: string, icon: React.ReactNode, count: number) => (
    <button
      key={filter}
      onClick={() => onTypeFilterChange(filter)}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
        typeFilter === filter
          ? 'bg-zinc-800 text-white'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
      }`}
    >
      {icon}
      {label}
      <span className="text-xs text-zinc-500">({count})</span>
    </button>
  )

  return (
    <div className="flex items-center gap-2 pb-2 flex-wrap">
      {/* Type filters */}
      <div className="flex items-center gap-0.5 bg-zinc-900/50 rounded-lg p-0.5">
        {typeBtn('all', 'All', null, imageCount + videoCount)}
        {typeBtn('image', 'Images', <Image className="h-3.5 w-3.5" />, imageCount)}
        {typeBtn('video', 'Videos', <Video className="h-3.5 w-3.5" />, videoCount)}
      </div>

      <div className="w-px h-5 bg-zinc-700" />

      {/* Sort */}
      <div ref={sortRef} className="relative">
        <button
          onClick={() => setShowSortMenu(!showSortMenu)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
            showSortMenu ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
          }`}
        >
          {SORT_LABELS[sortMode]}
          <ChevronDown className="h-3 w-3" />
        </button>
        {showSortMenu && (
          <div className="absolute top-full mt-1 left-0 bg-zinc-800 border border-zinc-700 rounded-md py-1 min-w-[140px] shadow-xl z-50">
            {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => { onSortModeChange(mode); setShowSortMenu(false) }}
                className={`w-full px-3 py-1.5 text-sm text-left transition-colors ${
                  sortMode === mode ? 'text-white bg-zinc-700' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                {SORT_LABELS[mode]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Favorites toggle */}
      <button
        onClick={() => onShowFavoritesChange(!showFavorites)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
          showFavorites
            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
            : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
        }`}
      >
        <Heart className={`h-4 w-4 ${showFavorites ? 'fill-current' : ''}`} />
        {favoriteCount > 0 && (
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
            showFavorites ? 'bg-red-500/30 text-red-300' : 'bg-zinc-800 text-zinc-500'
          }`}>
            {favoriteCount}
          </span>
        )}
      </button>

      {/* Show Archived toggle */}
      <button
        onClick={() => onShowArchivedChange(!showArchived)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
          showArchived
            ? 'bg-zinc-700 text-zinc-200'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
        }`}
        title={showArchived ? 'Hide archived' : 'Show archived'}
      >
        <Archive className="h-3.5 w-3.5" />
      </button>

      {/* Gallery size */}
      <div ref={sizeRef} className="relative">
        <button
          onClick={() => setShowSizeMenu(!showSizeMenu)}
          className={`p-2 rounded-md transition-colors ${
            showSizeMenu ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
          }`}
        >
          {gallerySize === 'small' ? <GridSmallIcon className="h-4 w-4" /> :
           gallerySize === 'medium' ? <GridMediumIcon className="h-4 w-4" /> :
           <GridLargeIcon className="h-4 w-4" />}
        </button>
        {showSizeMenu && (
          <div className="absolute top-full mt-1 right-0 bg-zinc-800 border border-zinc-700 rounded-md p-2 min-w-[160px] shadow-xl z-50">
            {([
              { value: 'small' as GallerySize, label: 'Small', icon: GridSmallIcon },
              { value: 'medium' as GallerySize, label: 'Medium', icon: GridMediumIcon },
              { value: 'large' as GallerySize, label: 'Large', icon: GridLargeIcon },
            ]).map(option => (
              <button
                key={option.value}
                onClick={() => { onGallerySizeChange(option.value); setShowSizeMenu(false) }}
                className={`w-full flex items-center justify-between px-2 py-2.5 rounded-md transition-colors text-left ${
                  gallerySize === option.value ? 'bg-white/20 hover:bg-white/25' : 'hover:bg-zinc-700'
                }`}
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
  )
}
