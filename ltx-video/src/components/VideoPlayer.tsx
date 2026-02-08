import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Play, Pause, Download, RefreshCw, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { Button } from './ui/button'

interface VideoPlayerProps {
  videoUrl: string | null
  isGenerating: boolean
  progress: number
  statusMessage: string
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function VideoPlayer({ videoUrl, isGenerating, progress, statusMessage }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [isLooping, setIsLooping] = useState(true)
  const [isMuted, setIsMuted] = useState(false)

  useEffect(() => {
    if (videoUrl && videoRef.current) {
      videoRef.current.load()
      videoRef.current.play()
      setIsPlaying(true)
      setCurrentTime(0)
    }
  }, [videoUrl])

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
    if (videoUrl) {
      const a = document.createElement('a')
      a.href = videoUrl
      a.download = `ltx-video-${Date.now()}.mp4`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
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
            {/* Video container */}
            <div className="flex-1 flex items-center justify-center bg-black min-h-0">
              <video
                ref={videoRef}
                className="max-w-full max-h-full object-contain"
                loop={isLooping}
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              >
                <source src={videoUrl} type="video/mp4" />
              </video>
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
