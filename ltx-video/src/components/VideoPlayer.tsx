import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  Play,
  Pause,
  Download,
  RefreshCw,
  RotateCcw,
  Volume2,
  VolumeX,
  Maximize2,
} from "lucide-react";
import { Button } from "./ui/button";

interface VideoPlayerProps {
  videoUrl: string | null;
  videoPath?: string | null; // Local file path for upscaling
  videoResolution?: string; // Resolution of the video (540p, 720p, 1080p)
  isGenerating: boolean;
  progress: number;
  statusMessage: string;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function VideoPlayer({
  videoUrl,
  videoPath,
  videoResolution,
  isGenerating,
  progress,
  statusMessage,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [hasBeenUpscaled, setHasBeenUpscaled] = useState(false);
  const [upscaledVideoUrl, setUpscaledVideoUrl] = useState<string | null>(null);
  const [showingUpscaled, setShowingUpscaled] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<"toggle" | "curtain">(
    "toggle",
  );
  const [curtainPosition, setCurtainPosition] = useState(50); // Percentage from left
  const [isDraggingCurtain, setIsDraggingCurtain] = useState(false);
  const upscaledVideoRef = useRef<HTMLVideoElement>(null);
  const curtainContainerRef = useRef<HTMLDivElement>(null);

  // Calculate upscale target resolution first (needed for displayedResolution)
  const upscaleTargetResolution =
    videoResolution === "540p"
      ? "1080p"
      : videoResolution === "720p"
        ? "1440p"
        : "2160p";

  // The video URL to display (original or upscaled)
  const displayedVideoUrl =
    showingUpscaled && upscaledVideoUrl ? upscaledVideoUrl : videoUrl;
  const displayedResolution = showingUpscaled
    ? upscaleTargetResolution
    : videoResolution;

  // Reset comparison state when video changes
  useEffect(() => {
    if (videoResolution) {
      setHasBeenUpscaled(false);
      setUpscaledVideoUrl(null);
      setShowingUpscaled(false);
      setComparisonMode("toggle");
      setCurtainPosition(50);
    }
  }, [videoResolution, videoUrl]);

  // Sync upscaled video with original in curtain mode
  useEffect(() => {
    if (
      comparisonMode === "curtain" &&
      videoRef.current &&
      upscaledVideoRef.current &&
      upscaledVideoUrl
    ) {
      const originalVideo = videoRef.current;
      const upscaledVideo = upscaledVideoRef.current;

      const syncVideos = () => {
        if (
          Math.abs(originalVideo.currentTime - upscaledVideo.currentTime) > 0.1
        ) {
          upscaledVideo.currentTime = originalVideo.currentTime;
        }
      };

      originalVideo.addEventListener("timeupdate", syncVideos);
      originalVideo.addEventListener("play", () => upscaledVideo.play());
      originalVideo.addEventListener("pause", () => upscaledVideo.pause());
      originalVideo.addEventListener("seeked", () => {
        upscaledVideo.currentTime = originalVideo.currentTime;
      });

      // Initial sync
      upscaledVideo.currentTime = originalVideo.currentTime;
      upscaledVideo.muted = true; // Mute upscaled to avoid double audio
      if (isPlaying) {
        upscaledVideo.play().catch(() => {});
      }

      return () => {
        originalVideo.removeEventListener("timeupdate", syncVideos);
      };
    }
  }, [comparisonMode, upscaledVideoUrl, isPlaying]);

  // Handle curtain drag
  const handleCurtainDrag = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!curtainContainerRef.current) return;
    const rect = curtainContainerRef.current.getBoundingClientRect();
    const x = ("clientX" in e ? e.clientX : 0) - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setCurtainPosition(percentage);
  }, []);

  useEffect(() => {
    if (isDraggingCurtain) {
      const handleMouseMove = (e: MouseEvent) => handleCurtainDrag(e);
      const handleMouseUp = () => setIsDraggingCurtain(false);

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);

      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDraggingCurtain, handleCurtainDrag]);

  // Track if this is a before/after toggle vs a new video
  const prevVideoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (displayedVideoUrl && videoRef.current) {
      const isToggleBetweenVersions =
        prevVideoUrlRef.current !== null &&
        (prevVideoUrlRef.current === videoUrl ||
          prevVideoUrlRef.current === upscaledVideoUrl);

      // Small delay to ensure src is updated before loading
      setTimeout(() => {
        if (videoRef.current) {
          const wasPlaying = isPlaying;
          videoRef.current.load();

          // Only auto-play if it was playing before, or if this is a new video (not a toggle)
          if (wasPlaying || !isToggleBetweenVersions) {
            videoRef.current.play().catch(() => {
              // Autoplay might be blocked, that's ok
            });
            setIsPlaying(true);
          }

          // Reset time only for new videos, not when toggling
          if (!isToggleBetweenVersions) {
            setCurrentTime(0);
          }
        }
      }, 50);

      prevVideoUrlRef.current = displayedVideoUrl;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on URL change; adding isPlaying/videoUrl/upscaledVideoUrl would cause unnecessary video reloads
  }, [displayedVideoUrl]);

  // Update time display - re-attach listeners when video URL changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(video.currentTime);
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handleEnded = () => {
      if (!isLooping) {
        setIsPlaying(false);
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("ended", handleEnded);

    // If metadata is already loaded (e.g. after URL change), update duration immediately
    if (video.readyState >= 1 && video.duration) {
      setDuration(video.duration);
    }

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("ended", handleEnded);
    };
  }, [isDragging, isLooping, displayedVideoUrl]);

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const toggleLoop = () => {
    if (videoRef.current) {
      videoRef.current.loop = !isLooping;
      setIsLooping(!isLooping);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (progressRef.current && videoRef.current && duration > 0) {
      const rect = progressRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percentage = clickX / rect.width;
      const newTime = percentage * duration;
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleProgressDrag = useCallback(
    (e: MouseEvent) => {
      if (
        progressRef.current &&
        videoRef.current &&
        duration > 0 &&
        isDragging
      ) {
        const rect = progressRef.current.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percentage = clickX / rect.width;
        const newTime = percentage * duration;
        videoRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
    },
    [duration, isDragging],
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    handleProgressClick(e);
  };

  useEffect(() => {
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener("mousemove", handleProgressDrag);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleProgressDrag);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleProgressDrag]);

  const handleDownload = () => {
    if (displayedVideoUrl) {
      const a = document.createElement("a");
      a.href = displayedVideoUrl;
      const suffix = showingUpscaled ? "-upscaled" : "";
      a.download = `ltx-desktop${suffix}-${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex h-full w-full flex-col">
      <label className="mb-2 block text-[12px] font-semibold uppercase leading-4 text-zinc-500">
        Result
      </label>

      <div className="relative flex min-h-[400px] flex-1 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        {isGenerating ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <RefreshCw className="mb-4 h-12 w-12 animate-spin text-primary" />
            <p className="mb-2 text-lg font-medium text-foreground">
              Generating Video...
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              {statusMessage}
            </p>
            <div className="w-64">
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {Math.round(progress)}% complete
              </p>
            </div>
          </div>
        ) : videoUrl ? (
          <div className="flex h-full w-full flex-col">
            {/* Video container with hover overlay */}
            <div
              ref={curtainContainerRef}
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
            >
              {/* Normal video display (toggle mode or no upscale) */}
              {(!hasBeenUpscaled ||
                !upscaledVideoUrl ||
                comparisonMode === "toggle") && (
                <video
                  ref={videoRef}
                  src={displayedVideoUrl || undefined}
                  className="max-h-full max-w-full object-contain"
                  loop={isLooping}
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onError={(e) =>
                    console.error("Video error:", e, "URL:", displayedVideoUrl)
                  }
                />
              )}

              {/* Curtain comparison mode */}
              {hasBeenUpscaled &&
                upscaledVideoUrl &&
                comparisonMode === "curtain" && (
                  <div className="relative flex h-full w-full items-center justify-center">
                    {/* Original video (left side) - scaled to fill container */}
                    <video
                      ref={videoRef}
                      src={videoUrl || undefined}
                      className="absolute h-full w-full object-contain"
                      style={{
                        clipPath: `inset(0 ${100 - curtainPosition}% 0 0)`,
                      }}
                      loop={isLooping}
                      playsInline
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />

                    {/* Upscaled video (right side) - scaled to fill container */}
                    <video
                      ref={upscaledVideoRef}
                      src={upscaledVideoUrl}
                      className="absolute h-full w-full object-contain"
                      style={{ clipPath: `inset(0 0 0 ${curtainPosition}%)` }}
                      loop={isLooping}
                      playsInline
                      muted
                    />

                    {/* Curtain divider */}
                    <div
                      className="absolute bottom-0 top-0 z-10 w-1 cursor-ew-resize bg-white shadow-lg"
                      style={{
                        left: `${curtainPosition}%`,
                        transform: "translateX(-50%)",
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsDraggingCurtain(true);
                      }}
                    >
                      {/* Handle */}
                      <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-lg">
                        <span className="text-xs font-bold text-zinc-800">
                          ↔
                        </span>
                      </div>
                    </div>

                    {/* Labels */}
                    <div className="absolute bottom-4 left-4 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
                      {videoResolution} (Before)
                    </div>
                    <div className="absolute bottom-4 right-4 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
                      {upscaleTargetResolution} (After)
                    </div>
                  </div>
                )}

              {/* Resolution badge (only in toggle mode) */}
              {comparisonMode === "toggle" && displayedResolution && (
                <div className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
                  {displayedResolution}
                </div>
              )}

              {/* Comparison controls when upscaled version is available */}
              {hasBeenUpscaled &&
                upscaledVideoUrl &&
                comparisonMode === "toggle" && (
                  <div className="absolute right-3 top-3 flex gap-2">
                    {/* Mode switcher */}
                    <button
                      onClick={() => setComparisonMode("curtain")}
                      className="rounded bg-black/70 px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:text-white"
                      title="Switch to curtain comparison"
                    >
                      ↔
                    </button>
                    {/* Before/After toggle */}
                    <div className="flex overflow-hidden rounded bg-black/70">
                      <button
                        onClick={() => setShowingUpscaled(false)}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          !showingUpscaled
                            ? "bg-blue-600 text-white"
                            : "text-zinc-400 hover:text-white"
                        }`}
                      >
                        Before
                      </button>
                      <button
                        onClick={() => setShowingUpscaled(true)}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          showingUpscaled
                            ? "bg-blue-600 text-white"
                            : "text-zinc-400 hover:text-white"
                        }`}
                      >
                        After
                      </button>
                    </div>
                  </div>
                )}

              {/* Curtain mode controls */}
              {hasBeenUpscaled &&
                upscaledVideoUrl &&
                comparisonMode === "curtain" && (
                  <div className="absolute right-3 top-3 flex gap-2">
                    <button
                      onClick={() => setComparisonMode("toggle")}
                      className="rounded bg-black/70 px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:text-white"
                      title="Switch to toggle comparison"
                    >
                      ⇄
                    </button>
                    <div className="rounded bg-black/70 px-3 py-1 text-xs font-medium text-white">
                      Drag to compare
                    </div>
                  </div>
                )}

              {/* Upscale overlay button — Coming Soon */}
              {videoPath &&
                isHovering &&
                !hasBeenUpscaled &&
                (videoResolution === "540p" ||
                  videoResolution === "720p" ||
                  videoResolution === "1080p") && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity">
                    <Button
                      disabled
                      title="Coming Soon!"
                      className="flex cursor-not-allowed items-center gap-2 rounded-lg bg-zinc-600 px-6 py-3 font-medium text-white opacity-50 shadow-lg"
                    >
                      <Maximize2 className="h-5 w-5" />
                      Upscale to {upscaleTargetResolution}
                    </Button>
                  </div>
                )}
            </div>

            {/* Video controls bar */}
            <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
              {/* Progress bar / Playhead */}
              <div
                ref={progressRef}
                className="group relative mb-3 h-1.5 w-full cursor-pointer rounded-full bg-zinc-700"
                onClick={handleProgressClick}
                onMouseDown={handleMouseDown}
              >
                {/* Progress fill */}
                <div
                  className="relative h-full rounded-full bg-blue-500"
                  style={{ width: `${progressPercent}%` }}
                >
                  {/* Playhead dot - always visible */}
                  <div className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 translate-x-1/2 transform rounded-full bg-white shadow-md transition-transform group-hover:scale-125" />
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
                      <Play className="ml-0.5 h-4 w-4" />
                    )}
                  </Button>

                  {/* Time display */}
                  <span className="min-w-[80px] font-mono text-xs text-zinc-400">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  {/* Mute toggle */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={toggleMute}
                    className={`h-8 w-8 hover:bg-zinc-800 ${isMuted ? "text-zinc-500" : "text-zinc-400 hover:text-white"}`}
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted ? (
                      <VolumeX className="h-4 w-4" />
                    ) : (
                      <Volume2 className="h-4 w-4" />
                    )}
                  </Button>

                  {/* Loop toggle */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={toggleLoop}
                    className={`h-8 w-8 hover:bg-zinc-800 ${isLooping ? "text-blue-400" : "text-zinc-500"}`}
                    title={isLooping ? "Loop: On" : "Loop: Off"}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>

                  {/* Download */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleDownload}
                    className="h-8 w-8 text-zinc-400 hover:bg-zinc-800 hover:text-white"
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
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800">
              <Play className="h-8 w-8 text-zinc-400" />
            </div>
            <p className="text-sm">Generated video will appear here</p>
          </div>
        )}
      </div>
    </div>
  );
}
