import React, { useRef, useEffect } from 'react'
import { Play, Pause, Download, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

interface VideoPlayerProps {
  videoUrl: string | null
  isGenerating: boolean
  progress: number
  statusMessage: string
}

export function VideoPlayer({ videoUrl, isGenerating, progress, statusMessage }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = React.useState(false)

  useEffect(() => {
    if (videoUrl && videoRef.current) {
      videoRef.current.load()
      videoRef.current.play()
      setIsPlaying(true)
    }
  }, [videoUrl])

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
          <>
            <video
              ref={videoRef}
              className="max-w-full max-h-full object-contain"
              loop
              playsInline
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            >
              <source src={videoUrl} type="video/mp4" />
            </video>
            
            {/* Video controls overlay */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
              <Button
                size="icon"
                variant="secondary"
                onClick={togglePlayPause}
                className="bg-black/50 hover:bg-black/70"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant="secondary"
                onClick={handleDownload}
                className="bg-black/50 hover:bg-black/70"
              >
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </>
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
