import React, { useState, useRef, useEffect, useCallback } from "react";
import { X, Play, Pause, Volume2, VolumeX, Loader2, Film } from "lucide-react";

type RetakeMode = "replace_audio_and_video" | "replace_video" | "replace_audio";

interface RetakeModalProps {
  isOpen: boolean;
  videoUrl: string;
  videoPath: string;
  clipName: string;
  videoDuration: number;
  onClose: () => void;
  onSubmit: (params: {
    videoPath: string;
    startTime: number;
    duration: number;
    prompt: string;
    mode: RetakeMode;
  }) => void;
  isProcessing: boolean;
  processingStatus: string;
}

const MIN_DURATION = 2;

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

export function RetakeModal({
  isOpen,
  videoUrl,
  videoPath,
  clipName,
  videoDuration,
  onClose,
  onSubmit,
  isProcessing,
  processingStatus,
}: RetakeModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const filmstripRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrenTime] = useState(0);

  // Selection handles (in seconds)
  const [selStart, setSelStart] = useState(0);
  const [selEnd, setSelEnd] = useState(Math.min(videoDuration, 5));
  const [draggingHandle, setDraggingHandle] = useState<
    "start" | "end" | "range" | null
  >(null);
  const dragStartRef = useRef<{
    mouseX: number;
    selStart: number;
    selEnd: number;
  } | null>(null);

  const [prompt, setPrompt] = useState("");

  // Filmstrip thumbnails
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [thumbCount] = useState(20);
  const extractingRef = useRef(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- State reset when modal opens
      setIsPlaying(false);
      setCurrenTime(0);
      setSelStart(0);
      setSelEnd(Math.min(videoDuration, 5));
      setPrompt("");
      setThumbnails([]);
      extractingRef.current = false;
    }
  }, [isOpen, videoDuration]);

  // Extract filmstrip thumbnails
  useEffect(() => {
    if (!isOpen || !videoUrl || extractingRef.current || videoDuration <= 0)
      return;
    extractingRef.current = true;

    const extractThumbnails = async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.src = videoUrl;

      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () =>
          reject(new Error("Failed to load video for thumbnails"));
        setTimeout(() => reject(new Error("Timeout loading video")), 10000);
      });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const thumbWidth = 80;
      const thumbHeight = Math.round(
        thumbWidth * (video.videoHeight / video.videoWidth),
      );
      canvas.width = thumbWidth;
      canvas.height = thumbHeight;

      const frames: string[] = [];
      const count = Math.min(
        thumbCount,
        Math.max(5, Math.floor(videoDuration / 0.25)),
      );

      for (let i = 0; i < count; i++) {
        const seekTime = (i / count) * videoDuration;
        video.currentTime = seekTime;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          setTimeout(resolve, 500);
        });
        ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
        frames.push(canvas.toDataURL("image/jpeg", 0.6));
      }

      video.src = "";
      video.load();
      setThumbnails(frames);
    };

    extractThumbnails().catch((err) => {
      console.warn("Filmstrip extraction failed:", err);
    });
  }, [isOpen, videoUrl, videoDuration, thumbCount]);

  // Video time update
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handler = () => setCurrenTime(video.currentTime);
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [isOpen]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  // Keyboard shortcuts: Space, I, O, arrow keys — intercept so timeline doesn't get them
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      const key = e.key.toLowerCase();
      const video = videoRef.current;

      if (key === " ") {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (key === "i") {
        e.preventDefault();
        e.stopPropagation();
        // Mark In — move selection start to current playback time
        if (video) {
          const t = video.currentTime;
          if (t < selEnd - MIN_DURATION) setSelStart(t);
        }
      } else if (key === "o") {
        e.preventDefault();
        e.stopPropagation();
        // Mark Out — move selection end to current playback time
        if (video) {
          const t = video.currentTime;
          if (t > selStart + MIN_DURATION) setSelEnd(t);
        }
      } else if (key === "arrowleft") {
        e.preventDefault();
        e.stopPropagation();
        // Step back 1 frame
        if (video) {
          video.pause();
          setIsPlaying(false);
          video.currentTime = Math.max(0, video.currentTime - 1 / 24);
        }
      } else if (key === "arrowright") {
        e.preventDefault();
        e.stopPropagation();
        // Step forward 1 frame
        if (video) {
          video.pause();
          setIsPlaying(false);
          video.currentTime = Math.min(
            videoDuration,
            video.currentTime + 1 / 24,
          );
        }
      } else if (key === "j" || key === "k" || key === "l") {
        // Capture JKL so timeline shuttle doesn't activate
        e.preventDefault();
        e.stopPropagation();
        if (key === "k") {
          if (video) {
            video.pause();
            setIsPlaying(false);
          }
        } else if (key === "l") {
          if (video) {
            video.play();
            setIsPlaying(true);
          }
        }
      }
    };
    // Use capture phase so this fires before the timeline's window-level listener
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isOpen, togglePlay, selStart, selEnd, videoDuration]);

  // Refs for latest selection values so the drag effect never reads stale state
  const selStartRef = useRef(selStart);
  const selEndRef = useRef(selEnd);
  useEffect(() => {
    selStartRef.current = selStart;
    selEndRef.current = selEnd;
  }, [selStart, selEnd]);

  // Handle drag on the filmstrip handles or the range itself
  const handleFilmstripMouseDown = useCallback(
    (e: React.MouseEvent, handle: "start" | "end" | "range") => {
      e.preventDefault();
      e.stopPropagation();
      dragStartRef.current = {
        mouseX: e.clientX,
        selStart: selStartRef.current,
        selEnd: selEndRef.current,
      };
      setDraggingHandle(handle);
    },
    [],
  );

  useEffect(() => {
    if (!draggingHandle) return;

    const handleMouseMove = (e: MouseEvent) => {
      const strip = filmstripRef.current;
      const origin = dragStartRef.current;
      if (!strip || !origin) return;
      const rect = strip.getBoundingClientRect();

      if (draggingHandle === "range") {
        // Move the entire range as a chunk
        const dx = e.clientX - origin.mouseX;
        const dtSeconds = (dx / rect.width) * videoDuration;
        const rangeDuration = origin.selEnd - origin.selStart;
        let newStart = origin.selStart + dtSeconds;
        let newEnd = origin.selEnd + dtSeconds;
        // Clamp to bounds
        if (newStart < 0) {
          newStart = 0;
          newEnd = rangeDuration;
        }
        if (newEnd > videoDuration) {
          newEnd = videoDuration;
          newStart = videoDuration - rangeDuration;
        }
        setSelStart(Math.max(0, newStart));
        setSelEnd(Math.min(videoDuration, newEnd));
      } else {
        const fraction = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width),
        );
        const time = fraction * videoDuration;
        if (draggingHandle === "start") {
          const maxStart = selEndRef.current - MIN_DURATION;
          setSelStart(Math.max(0, Math.min(maxStart, time)));
        } else {
          const minEnd = selStartRef.current + MIN_DURATION;
          setSelEnd(Math.min(videoDuration, Math.max(minEnd, time)));
        }
      }
    };

    const handleMouseUp = () => {
      setDraggingHandle(null);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingHandle, videoDuration]);

  // Seek video when clicking on the filmstrip (outside the selected range)
  const handleFilmstripClick = useCallback(
    (e: React.MouseEvent) => {
      if (draggingHandle) return;
      const strip = filmstripRef.current;
      const video = videoRef.current;
      if (!strip || !video) return;
      const rect = strip.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      video.currentTime = fraction * videoDuration;
    },
    [draggingHandle, videoDuration],
  );

  const handleSubmit = useCallback(() => {
    onSubmit({
      videoPath,
      startTime: selStart,
      duration: selEnd - selStart,
      prompt,
      mode: "replace_audio_and_video",
    });
  }, [videoPath, selStart, selEnd, prompt, onSubmit]);

  if (!isOpen) return null;

  const selStartFrac = videoDuration > 0 ? selStart / videoDuration : 0;
  const selEndFrac = videoDuration > 0 ? selEnd / videoDuration : 1;
  const playheadFrac = videoDuration > 0 ? currentTime / videoDuration : 0;
  const selDuration = selEnd - selStart;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        className="flex max-h-[90vh] w-[640px] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <Film className="h-4 w-4 text-blue-400" />
            <span className="text-sm font-semibold text-white">Retake</span>
            <span className="max-w-[200px] truncate text-xs text-zinc-500">
              {clipName}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Video Preview */}
          <div className="relative flex-shrink-0 bg-black">
            <video
              ref={videoRef}
              src={videoUrl}
              className="max-h-[320px] w-full object-contain"
              onClick={togglePlay}
              onEnded={() => setIsPlaying(false)}
            />
            {/* Play/Mute overlay */}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
              <button
                onClick={toggleMute}
                className="rounded bg-black/60 p-1.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
              >
                {isMuted ? (
                  <VolumeX className="h-3.5 w-3.5" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Playback bar */}
          <div className="flex items-center justify-center gap-3 border-b border-zinc-800 bg-zinc-900 px-5 py-2">
            <button
              onClick={togglePlay}
              className="rounded p-1 text-white transition-colors hover:bg-zinc-800"
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
            <span className="font-mono text-xs text-zinc-400">
              {formatTimecode(currentTime)} / {formatTimecode(videoDuration)}
            </span>
          </div>

          {/* Section selector instructions */}
          <div className="px-5 pb-1 pt-3">
            <p className="text-xs font-semibold text-white">
              Select the video part to regenerate
            </p>
            <p className="mt-0.5 text-[10px] text-zinc-500">
              Then tap continue and describe what should happen in the prompt
              panel
            </p>
          </div>

          {/* Filmstrip section selector */}
          <div className="px-5 pb-3">
            {/* Playhead notch sits above the filmstrip */}
            <div className="relative mb-0 h-3">
              <div
                className="pointer-events-none absolute z-10"
                style={{
                  left: `${playheadFrac * 100}%`,
                  transform: "translateX(-50%)",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <polygon points="0,0 10,0 5,8" fill="#fff" />
                </svg>
              </div>
            </div>
            <div
              ref={filmstripRef}
              className="relative h-14 cursor-pointer select-none overflow-hidden rounded-md"
              onClick={handleFilmstripClick}
            >
              {/* Thumbnail strip background */}
              <div className="absolute inset-0 flex">
                {thumbnails.length > 0 ? (
                  thumbnails.map((thumb, i) => (
                    <img
                      key={i}
                      src={thumb}
                      alt=""
                      className="h-full flex-1 object-cover"
                      style={{ minWidth: 0 }}
                      draggable={false}
                    />
                  ))
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-zinc-800">
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
                  </div>
                )}
              </div>

              {/* Dimmed regions outside selection */}
              <div
                className="pointer-events-none absolute bottom-0 left-0 top-0 bg-black/75"
                style={{ width: `${selStartFrac * 100}%` }}
              />
              <div
                className="pointer-events-none absolute bottom-0 right-0 top-0 bg-black/75"
                style={{ width: `${(1 - selEndFrac) * 100}%` }}
              />

              {/* Solid white overlay on the selected range */}
              <div
                className="pointer-events-none absolute bottom-0 top-0 bg-white"
                style={{
                  left: `${selStartFrac * 100}%`,
                  width: `${(selEndFrac - selStartFrac) * 100}%`,
                }}
              />

              {/* Draggable range area (grab the middle to slide the whole selection) */}
              <div
                className={`absolute bottom-0 top-0 z-[12] ${draggingHandle === "range" ? "cursor-grabbing" : "cursor-grab"}`}
                style={{
                  left: `calc(${selStartFrac * 100}% + 14px)`,
                  width: `calc(${(selEndFrac - selStartFrac) * 100}% - 28px)`,
                }}
                onMouseDown={(e) => handleFilmstripMouseDown(e, "range")}
              />

              {/* Selection border (blue frame) */}
              <div
                className="pointer-events-none absolute bottom-0 top-0 border-2 border-blue-500"
                style={{
                  left: `${selStartFrac * 100}%`,
                  width: `${(selEndFrac - selStartFrac) * 100}%`,
                }}
              />

              {/* Start handle — wide hit area */}
              <div
                className="group absolute bottom-0 top-0 z-20 cursor-ew-resize"
                style={{
                  left: `calc(${selStartFrac * 100}% - 6px)`,
                  width: "20px",
                }}
                onMouseDown={(e) => handleFilmstripMouseDown(e, "start")}
              >
                <div
                  className="absolute bottom-0 top-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    left: "5px",
                    width: "4px",
                    borderRadius: "2px 0 0 2px",
                  }}
                />
                <div
                  className="absolute top-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    left: "5px",
                    width: "10px",
                    height: "3px",
                    borderRadius: "2px 0 0 0",
                  }}
                />
                <div
                  className="absolute bottom-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    left: "5px",
                    width: "10px",
                    height: "3px",
                    borderRadius: "0 0 0 2px",
                  }}
                />
              </div>

              {/* End handle — wide hit area */}
              <div
                className="group absolute bottom-0 top-0 z-20 cursor-ew-resize"
                style={{
                  left: `calc(${selEndFrac * 100}% - 14px)`,
                  width: "20px",
                }}
                onMouseDown={(e) => handleFilmstripMouseDown(e, "end")}
              >
                <div
                  className="absolute bottom-0 top-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    right: "5px",
                    width: "4px",
                    borderRadius: "0 2px 2px 0",
                  }}
                />
                <div
                  className="absolute top-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    right: "5px",
                    width: "10px",
                    height: "3px",
                    borderRadius: "0 2px 0 0",
                  }}
                />
                <div
                  className="absolute bottom-0 bg-blue-500 transition-colors group-hover:bg-blue-400"
                  style={{
                    right: "5px",
                    width: "10px",
                    height: "3px",
                    borderRadius: "0 0 2px 0",
                  }}
                />
              </div>

              {/* Playhead line */}
              <div
                className="pointer-events-none absolute bottom-0 top-0 z-[15] w-0.5 bg-zinc-800"
                style={{ left: `${playheadFrac * 100}%` }}
              />

              {/* Timecode label at center of selection */}
              <div
                className="pointer-events-none absolute top-1/2 z-10"
                style={{
                  left: `${((selStartFrac + selEndFrac) / 2) * 100}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span className="rounded bg-white/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-zinc-700 shadow">
                  {formatTimecode(selDuration)}
                </span>
              </div>
            </div>

            {/* Selection time labels */}
            <div className="mt-1.5 flex justify-between">
              <span className="font-mono text-[10px] text-blue-400">
                {formatTimecode(selStart)}
              </span>
              <span className="font-mono text-[10px] text-zinc-500">
                Duration: {formatTimecode(selDuration)}
              </span>
              <span className="font-mono text-[10px] text-blue-400">
                {formatTimecode(selEnd)}
              </span>
            </div>
          </div>

          {/* Prompt */}
          <div className="space-y-3 border-t border-zinc-800 px-5 pb-3 pt-3">
            {/* Prompt input */}
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">
                Prompt <span className="text-zinc-600">(optional)</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isProcessing}
                placeholder="Describe what should happen in the selected section..."
                className="h-16 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-white placeholder-zinc-600 transition-colors focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          {/* Processing status */}
          {isProcessing && (
            <div className="px-5 pb-3">
              <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-600/10 px-3 py-2">
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-400" />
                <span className="text-xs text-blue-300">
                  {processingStatus || "Processing retake..."}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="rounded-lg px-4 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isProcessing || selDuration < MIN_DURATION}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isProcessing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Processing...
              </>
            ) : (
              "Continue"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
