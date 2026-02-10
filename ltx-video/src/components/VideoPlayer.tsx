import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Play, Pause, Download, RefreshCw, RotateCcw, Volume2, VolumeX, Maximize2 } from 'lucide-react'
import { Button } from './ui/button'

interface VideoPlayerProps {
  videoUrl: string | null
  videoPath?: string | null  // Local file path for upscaling
  videoResolution?: string   // Resolution of the video (540p, 720p, 1080p)
  isGenerating: boolean
  progress: number
  statusMessage: string
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function VideoPlayer({ videoUrl, videoPath, videoResolution, isGenerating, progress, statusMessage }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [isLooping, setIsLooping] = useState(true)
  const [isMuted, setIsMuted] = useState(false)
  const [isUpscaling, setIsUpscaling] = useState(false)
  const [upscaleStatus, setUpscaleStatus] = useState<string | null>(null)
  const [isHovering, setIsHovering] = useState(false)
  const [hasBeenUpscaled, setHasBeenUpscaled] = useState(false)
  const [currentResolution, setCurrentResolution] = useState<string | null>(null)
  const [upscaledVideoUrl, setUpscaledVideoUrl] = useState<string | null>(null)
  const [showingUpscaled, setShowingUpscaled] = useState(false)
  const [comparisonMode, setComparisonMode] = useState<'toggle' | 'curtain'>('toggle')
  const [curtainPosition, setCurtainPosition] = useState(50) // Percentage from left
  const [isDraggingCurtain, setIsDraggingCurtain] = useState(false)
  const upscaledVideoRef = useRef<HTMLVideoElement>(null)
  const curtainContainerRef = useRef<HTMLDivElement>(null)
  
  // Calculate upscale target resolution first (needed for displayedResolution)
  const upscaleTargetResolution = videoResolution === '540p' ? '1080p' : videoResolution === '720p' ? '1440p' : '2160p'
  
  // The video URL to display (original or upscaled)
  const displayedVideoUrl = showingUpscaled && upscaledVideoUrl ? upscaledVideoUrl : videoUrl
  const displayedResolution = showingUpscaled ? upscaleTargetResolution : videoResolution
  
  // Show upscale option for all resolutions that haven't been upscaled yet
  const canUpscale = (videoResolution === '540p' || videoResolution === '720p' || videoResolution === '1080p') && videoPath && !isUpscaling && !hasBeenUpscaled
  
  // Update current resolution when video changes or after upscaling
  useEffect(() => {
    if (videoResolution) {
      setCurrentResolution(videoResolution)
      setHasBeenUpscaled(false) // Reset when new video is generated
      setUpscaledVideoUrl(null) // Clear upscaled version
      setShowingUpscaled(false)
      setComparisonMode('toggle')
      setCurtainPosition(50)
    }
  }, [videoResolution, videoUrl])
  
  // Sync upscaled video with original in curtain mode
  useEffect(() => {
    if (comparisonMode === 'curtain' && videoRef.current && upscaledVideoRef.current && upscaledVideoUrl) {
      const originalVideo = videoRef.current
      const upscaledVideo = upscaledVideoRef.current
      
      const syncVideos = () => {
        if (Math.abs(originalVideo.currentTime - upscaledVideo.currentTime) > 0.1) {
          upscaledVideo.currentTime = originalVideo.currentTime
        }
      }
      
      originalVideo.addEventListener('timeupdate', syncVideos)
      originalVideo.addEventListener('play', () => upscaledVideo.play())
      originalVideo.addEventListener('pause', () => upscaledVideo.pause())
      originalVideo.addEventListener('seeked', () => {
        upscaledVideo.currentTime = originalVideo.currentTime
      })
      
      // Initial sync
      upscaledVideo.currentTime = originalVideo.currentTime
      upscaledVideo.muted = true // Mute upscaled to avoid double audio
      if (isPlaying) {
        upscaledVideo.play().catch(() => {})
      }
      
      return () => {
        originalVideo.removeEventListener('timeupdate', syncVideos)
      }
    }
  }, [comparisonMode, upscaledVideoUrl, isPlaying])
  
  // Handle curtain drag
  const handleCurtainDrag = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!curtainContainerRef.current) return
    const rect = curtainContainerRef.current.getBoundingClientRect()
    const x = ('clientX' in e ? e.clientX : 0) - rect.left
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100))
    setCurtainPosition(percentage)
  }, [])
  
  useEffect(() => {
    if (isDraggingCurtain) {
      const handleMouseMove = (e: MouseEvent) => handleCurtainDrag(e)
      const handleMouseUp = () => setIsDraggingCurtain(false)
      
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDraggingCurtain, handleCurtainDrag])

  // Track if this is a before/after toggle vs a new video
  const prevVideoUrlRef = useRef<string | null>(null)
  
  useEffect(() => {
    if (displayedVideoUrl && videoRef.current) {
      const isToggleBetweenVersions = prevVideoUrlRef.current !== null && 
        (prevVideoUrlRef.current === videoUrl || prevVideoUrlRef.current === upscaledVideoUrl)
      
      // Small delay to ensure src is updated before loading
      setTimeout(() => {
        if (videoRef.current) {
          const wasPlaying = isPlaying
          videoRef.current.load()
          
          // Only auto-play if it was playing before, or if this is a new video (not a toggle)
          if (wasPlaying || !isToggleBetweenVersions) {
            videoRef.current.play().catch(() => {
              // Autoplay might be blocked, that's ok
            })
            setIsPlaying(true)
          }
          
          // Reset time only for new videos, not when toggling
          if (!isToggleBetweenVersions) {
            setCurrentTime(0)
          }
        }
      }, 50)
      
      prevVideoUrlRef.current = displayedVideoUrl
    }
  }, [displayedVideoUrl])

  // Update time display
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(video.currentTime)
      }
    }

    const handleLoadedMetadata = () => {
      setDuration(video.duration)
    }

    const handleEnded = () => {
      if (!isLooping) {
        setIsPlaying(false)
      }
    }

    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('ended', handleEnded)

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('ended', handleEnded)
    }
  }, [isDragging, isLooping])

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause()
      } else {
        videoRef.current.play()
      }
      setIsPlaying(!isPlaying)
    }
  }

  const toggleLoop = () => {
    if (videoRef.current) {
      videoRef.current.loop = !isLooping
      setIsLooping(!isLooping)
    }
  }

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted
      setIsMuted(!isMuted)
    }
  }

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (progressRef.current && videoRef.current && duration > 0) {
      const rect = progressRef.current.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const percentage = clickX / rect.width
      const newTime = percentage * duration
      videoRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }

  const handleProgressDrag = useCallback((e: MouseEvent) => {
    if (progressRef.current && videoRef.current && duration > 0 && isDragging) {
      const rect = progressRef.current.getBoundingClientRect()
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const percentage = clickX / rect.width
      const newTime = percentage * duration
      videoRef.current.currentTime = newTime
      setCurrentTime(newTime)
    }
  }, [duration, isDragging])

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true)
    handleProgressClick(e)
  }

  useEffect(() => {
    const handleMouseUp = () => setIsDragging(false)
    
    if (isDragging) {
      window.addEventListener('mousemove', handleProgressDrag)
      window.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      window.removeEventListener('mousemove', handleProgressDrag)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, handleProgressDrag])

  const handleDownload = () => {
    if (displayedVideoUrl) {
      const a = document.createElement('a')
      a.href = displayedVideoUrl
      const suffix = showingUpscaled ? '-upscaled' : ''
      a.download = `ltx-video${suffix}-${Date.now()}.mp4`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const handleUpscale = async () => {
    if (!videoPath || isUpscaling) return
    
    setIsUpscaling(true)
    setUpscaleStatus(`Upscaling to ${upscaleTargetResolution}...`)
    
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      
      const response = await fetch(`${backendUrl}/api/upscale`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          video_path: videoPath
          // Backend auto-calculates target resolution based on original
        })
      })
      
      const data = await response.json()
      
      if (response.ok && data.status === 'complete') {
        setUpscaleStatus('Upscale complete!')
        setHasBeenUpscaled(true)
        setCurrentResolution(upscaleTargetResolution)
        
        // Get the upscaled video URL (Windows paths need file:///)
        if (data.upscaled_path) {
          const videoPathNormalized = data.upscaled_path.replace(/\\/g, '/')
          const upscaledUrl = videoPathNormalized.startsWith('/') 
            ? `file://${videoPathNormalized}` 
            : `file:///${videoPathNormalized}`
          setUpscaledVideoUrl(upscaledUrl)
          setShowingUpscaled(true) // Automatically show the upscaled version
        }
        
        setTimeout(() => setUpscaleStatus(null), 3000)
      } else {
        setUpscaleStatus(`Error: ${data.error || 'Unknown error'}`)
        setTimeout(() => setUpscaleStatus(null), 5000)
      }
    } catch (error) {
      console.error('Upscale error:', error)
      setUpscaleStatus(`Error: ${error}`)
      setTimeout(() => setUpscaleStatus(null), 5000)
    } finally {
      setIsUpscaling(false)
    }
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="w-full h-full flex flex-col">
      <label className="block text-[12px] font-semibold text-zinc-500 mb-2 uppercase leading-4">
        Result
      </label>
      
      <div className="flex-1 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden flex items-center justify-center relative min-h-[400px]">
        {isGenerating ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <RefreshCw className="h-12 w-12 text-primary animate-spin mb-4" />
            <p className="text-lg font-medium text-foreground mb-2">
              Generating Video...
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              {statusMessage}
            </p>
            <div className="w-64">
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {Math.round(progress)}% complete
              </p>
            </div>
          </div>
        ) : videoUrl ? (
          <div className="w-full h-full flex flex-col">
            {/* Video container with hover overlay */}
            <div 
              ref={curtainContainerRef}
              className="flex-1 flex items-center justify-center bg-black min-h-0 relative overflow-hidden"
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
            >
              {/* Normal video display (toggle mode or no upscale) */}
              {(!hasBeenUpscaled || !upscaledVideoUrl || comparisonMode === 'toggle') && (
                <video
                  ref={videoRef}
                  src={displayedVideoUrl || undefined}
                  className="max-w-full max-h-full object-contain"
                  loop={isLooping}
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onError={(e) => console.error('Video error:', e, 'URL:', displayedVideoUrl)}
                />
              )}
              
              {/* Curtain comparison mode */}
              {hasBeenUpscaled && upscaledVideoUrl && comparisonMode === 'curtain' && (
                <div className="relative w-full h-full flex items-center justify-center">
                  {/* Original video (left side) - scaled to fill container */}
                  <video
                    ref={videoRef}
                    src={videoUrl || undefined}
                    className="absolute w-full h-full object-contain"
                    style={{ clipPath: `inset(0 ${100 - curtainPosition}% 0 0)` }}
                    loop={isLooping}
                    playsInline
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  />
                  
                  {/* Upscaled video (right side) - scaled to fill container */}
                  <video
                    ref={upscaledVideoRef}
                    src={upscaledVideoUrl}
                    className="absolute w-full h-full object-contain"
                    style={{ clipPath: `inset(0 0 0 ${curtainPosition}%)` }}
                    loop={isLooping}
                    playsInline
                    muted
                  />
                  
                  {/* Curtain divider */}
                  <div
                    className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize z-10 shadow-lg"
                    style={{ left: `${curtainPosition}%`, transform: 'translateX(-50%)' }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setIsDraggingCurtain(true)
                    }}
                  >
                    {/* Handle */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg">
                      <span className="text-zinc-800 text-xs font-bold">↔</span>
                    </div>
                  </div>
                  
                  {/* Labels */}
                  <div className="absolute bottom-4 left-4 bg-black/70 px-2 py-1 rounded text-xs font-medium text-white">
                    {videoResolution} (Before)
                  </div>
                  <div className="absolute bottom-4 right-4 bg-black/70 px-2 py-1 rounded text-xs font-medium text-white">
                    {upscaleTargetResolution} (After)
                  </div>
                </div>
              )}
              
              {/* Resolution badge (only in toggle mode) */}
              {comparisonMode === 'toggle' && displayedResolution && (
                <div className="absolute top-3 left-3 bg-black/70 px-2 py-1 rounded text-xs font-medium text-white">
                  {displayedResolution}
                </div>
              )}
              
              {/* Comparison controls when upscaled version is available */}
              {hasBeenUpscaled && upscaledVideoUrl && comparisonMode === 'toggle' && (
                <div className="absolute top-3 right-3 flex gap-2">
                  {/* Mode switcher */}
                  <button
                    onClick={() => setComparisonMode('curtain')}
                    className="bg-black/70 px-2 py-1 rounded text-xs font-medium text-zinc-400 hover:text-white transition-colors"
                    title="Switch to curtain comparison"
                  >
                    ↔
                  </button>
                  {/* Before/After toggle */}
                  <div className="flex bg-black/70 rounded overflow-hidden">
                    <button
                      onClick={() => setShowingUpscaled(false)}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${
                        !showingUpscaled 
                          ? 'bg-violet-600 text-white' 
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      Before
                    </button>
                    <button
                      onClick={() => setShowingUpscaled(true)}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${
                        showingUpscaled 
                          ? 'bg-violet-600 text-white' 
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      After
                    </button>
                  </div>
                </div>
              )}
              
              {/* Curtain mode controls */}
              {hasBeenUpscaled && upscaledVideoUrl && comparisonMode === 'curtain' && (
                <div className="absolute top-3 right-3 flex gap-2">
                  <button
                    onClick={() => setComparisonMode('toggle')}
                    className="bg-black/70 px-2 py-1 rounded text-xs font-medium text-zinc-400 hover:text-white transition-colors"
                    title="Switch to toggle comparison"
                  >
                    ⇄
                  </button>
                  <div className="bg-black/70 px-3 py-1 rounded text-xs font-medium text-white">
                    Drag to compare
                  </div>
                </div>
              )}
              
              {/* Upscale overlay button for 540p/720p videos */}
              {canUpscale && isHovering && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity">
                  <Button
                    onClick={handleUpscale}
                    className="bg-violet-600 hover:bg-violet-700 text-white px-6 py-3 rounded-lg font-medium flex items-center gap-2 shadow-lg"
                  >
                    <Maximize2 className="h-5 w-5" />
                    Upscale to {upscaleTargetResolution}
                  </Button>
                </div>
              )}
              
              {/* Upscaling in progress overlay */}
              {isUpscaling && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
                  <RefreshCw className="h-8 w-8 text-violet-400 animate-spin mb-3" />
                  <p className="text-white font-medium">{upscaleStatus}</p>
                </div>
              )}
            </div>
            
            {/* Video controls bar */}
            <div className="bg-zinc-900 border-t border-zinc-800 px-4 py-3">
              {/* Progress bar / Playhead */}
              <div 
                ref={progressRef}
                className="w-full h-1.5 bg-zinc-700 rounded-full cursor-pointer mb-3 group relative"
                onClick={handleProgressClick}
                onMouseDown={handleMouseDown}
              >
                {/* Progress fill */}
                <div 
                  className="h-full bg-violet-500 rounded-full relative"
                  style={{ width: `${progressPercent}%` }}
                >
                  {/* Playhead dot - always visible */}
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md transform translate-x-1/2 group-hover:scale-125 transition-transform" />
                </div>
              </div>
              
              {/* Controls row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {/* Play/Pause */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={togglePlayPause}
                    className="h-8 w-8 text-white hover:bg-zinc-800"
                  >
                    {isPlaying ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4 ml-0.5" />
                    )}
                  </Button>
                  
                  {/* Time display */}
                  <span className="text-xs text-zinc-400 font-mono min-w-[80px]">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>
                
                <div className="flex items-center gap-1">
                  {/* Mute toggle */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={toggleMute}
                    className={`h-8 w-8 hover:bg-zinc-800 ${isMuted ? 'text-zinc-500' : 'text-zinc-400 hover:text-white'}`}
                    title={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </Button>
                  
                  {/* Loop toggle */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={toggleLoop}
                    className={`h-8 w-8 hover:bg-zinc-800 ${isLooping ? 'text-violet-400' : 'text-zinc-500'}`}
                    title={isLooping ? 'Loop: On' : 'Loop: Off'}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                  
                  {/* Download */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleDownload}
                    className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
                    title="Download video"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              
              {/* Upscale status message */}
              {upscaleStatus && (
                <div className="mt-2 text-xs text-center text-zinc-400">
                  {upscaleStatus}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
              <Play className="h-8 w-8 text-zinc-400" />
            </div>
            <p className="text-sm">Generated video will appear here</p>
          </div>
        )}
      </div>
    </div>
  )
}
