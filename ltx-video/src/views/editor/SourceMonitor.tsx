import React, { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  Square,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Video,
  Music,
  X,
} from "lucide-react";
import type { Asset } from "../../types/project";
import { formatTime } from "./video-editor-utils";
import { Tooltip } from "../../components/ui/tooltip";

export interface SourceMonitorProps {
  sourceAsset: Asset | null;
  sourceTime: number;
  setSourceTime: (t: number | ((prev: number) => number)) => void;
  sourceIsPlaying: boolean;
  setSourceIsPlaying: (v: boolean) => void;
  sourceIn: number | null;
  sourceOut: number | null;
  setSourceIn: (
    v: number | null | ((prev: number | null) => number | null),
  ) => void;
  setSourceOut: (
    v: number | null | ((prev: number | null) => number | null),
  ) => void;
  setShowSourceMonitor: (v: boolean) => void;
  activePanel: "source" | "timeline";
  setActivePanel: (p: "source" | "timeline") => void;
  sourceSplitPercent: number;
  draggingMarker:
    | "timelineIn"
    | "timelineOut"
    | "sourceIn"
    | "sourceOut"
    | null;
  setDraggingMarker: React.Dispatch<
    React.SetStateAction<
      "timelineIn" | "timelineOut" | "sourceIn" | "sourceOut" | null
    >
  >;
  sourceVideoRef: React.RefObject<HTMLVideoElement | null>;
  onInsertEdit: () => void;
  onOverwriteEdit: () => void;
}

export function SourceMonitor({
  sourceAsset,
  sourceTime,
  setSourceTime,
  sourceIsPlaying,
  setSourceIsPlaying,
  sourceIn,
  sourceOut,
  setSourceIn,
  setSourceOut,
  setShowSourceMonitor,
  activePanel,
  setActivePanel,
  sourceSplitPercent,
  setDraggingMarker,
  sourceVideoRef,
  onInsertEdit,
  onOverwriteEdit,
}: SourceMonitorProps) {
  const [sourceReversePlaying, setSourceReversePlaying] = useState(false);
  const reverseRafRef = useRef<number | null>(null);
  const reverseLastRef = useRef<number | null>(null);

  useEffect(() => {
    if (!sourceReversePlaying) {
      if (reverseRafRef.current) cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = null;
      reverseLastRef.current = null;
      return;
    }
    sourceVideoRef.current?.pause();
    const tick = (ts: number) => {
      if (!sourceReversePlaying) return;
      if (reverseLastRef.current !== null) {
        const delta = (ts - reverseLastRef.current) / 1000;
        const next = Math.max(
          0,
          (sourceVideoRef.current?.currentTime ?? sourceTime) - delta,
        );
        if (sourceVideoRef.current) sourceVideoRef.current.currentTime = next;
        setSourceTime(next);
        if (next <= 0) {
          setSourceReversePlaying(false);
          return;
        }
      }
      reverseLastRef.current = ts;
      reverseRafRef.current = requestAnimationFrame(tick);
    };
    reverseRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (reverseRafRef.current) cancelAnimationFrame(reverseRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- RAF loop reads sourceTime/sourceVideoRef via refs; adding them would restart the animation on every frame
  }, [sourceReversePlaying]);

  return (
    <div
      className={`flex flex-col ${activePanel === "source" ? "ring-2 ring-inset ring-blue-500" : "border-r border-zinc-800"}`}
      style={{ width: `${sourceSplitPercent}%` }}
      onMouseDown={() => setActivePanel("source")}
    >
      {/* Header */}
      <div className="flex h-7 flex-shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400">
          Clip Viewer
        </span>
        <Tooltip content="Close clip viewer" side="left">
          <button
            onClick={() => {
              setShowSourceMonitor(false);
              setSourceIsPlaying(false);
            }}
            className="text-zinc-500 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      {/* Video Area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {sourceAsset ? (
          <>
            {sourceAsset.type === "video" ? (
              <video
                ref={sourceVideoRef as React.RefObject<HTMLVideoElement>}
                src={sourceAsset.url}
                className="max-h-full max-w-full object-contain"
                onTimeUpdate={() => {
                  if (sourceVideoRef.current)
                    setSourceTime(sourceVideoRef.current.currentTime);
                }}
                onEnded={() => setSourceIsPlaying(false)}
                playsInline
              />
            ) : sourceAsset.type === "image" ? (
              <img
                src={sourceAsset.url}
                alt=""
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <div className="text-center text-zinc-500">
                <Music className="mx-auto mb-2 h-12 w-12" />
                <p className="text-sm">
                  {sourceAsset.path?.split("/").pop() || "Audio"}
                </p>
              </div>
            )}
            {/* Timecode overlays moved to bottom status bar */}
          </>
        ) : (
          <div className="text-center text-zinc-600">
            <Video className="mx-auto mb-2 h-10 w-10" />
            <p className="text-xs">Double-click an asset to load it here</p>
          </div>
        )}
      </div>
      {/* Scrub bar with In/Out markers */}
      {/* Premiere-style scrub bar with In/Out range */}
      {sourceAsset &&
        (sourceAsset.type === "video" || sourceAsset.type === "audio") && (
          <div className="relative flex-shrink-0 border-t border-zinc-800 bg-zinc-900 px-2 py-1">
            {/* Scrub track */}
            <div
              id="source-scrub-bar"
              className="group relative h-6 cursor-pointer"
              onMouseDown={(e) => {
                const bar = e.currentTarget;
                const rect = bar.getBoundingClientRect();
                const dur = sourceAsset.duration || 5;
                const seek = (clientX: number) => {
                  const frac = Math.max(
                    0,
                    Math.min(1, (clientX - rect.left) / rect.width),
                  );
                  const t = frac * dur;
                  setSourceTime(t);
                  if (sourceVideoRef.current)
                    sourceVideoRef.current.currentTime = t;
                };
                seek(e.clientX);
                const onMove = (ev: MouseEvent) => seek(ev.clientX);
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            >
              {/* Base track line */}
              <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-700" />

              {/* Dimmed regions outside In/Out (darker overlay) */}
              {sourceIn !== null && (
                <div
                  className="absolute bottom-0 left-0 top-0 rounded-l bg-black/50"
                  style={{
                    width: `${(sourceIn / (sourceAsset.duration || 5)) * 100}%`,
                  }}
                />
              )}
              {sourceOut !== null && (
                <div
                  className="absolute bottom-0 right-0 top-0 rounded-r bg-black/50"
                  style={{
                    width: `${100 - (sourceOut / (sourceAsset.duration || 5)) * 100}%`,
                  }}
                />
              )}

              {/* Selected range highlight */}
              {(sourceIn !== null || sourceOut !== null) && (
                <div
                  className="absolute bottom-0 top-0 border-b-2 border-t-2 border-blue-400/70"
                  style={{
                    left: `${((sourceIn ?? 0) / (sourceAsset!.duration || 5)) * 100}%`,
                    width: `${(((sourceOut ?? sourceAsset!.duration ?? 5) - (sourceIn ?? 0)) / (sourceAsset!.duration || 5)) * 100}%`,
                  }}
                >
                  <div className="absolute inset-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-blue-400/40" />
                </div>
              )}

              {/* In bracket marker — draggable */}
              {sourceIn !== null && (
                <div
                  className="absolute bottom-0 top-0 z-10 flex cursor-ew-resize items-center"
                  style={{
                    left: `calc(${(sourceIn / (sourceAsset!.duration || 5)) * 100}% - 8px)`,
                    width: 14,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setDraggingMarker("sourceIn");
                  }}
                >
                  <div className="pointer-events-none ml-auto flex h-full w-1.5 flex-col justify-between rounded-l-sm bg-blue-400 py-0.5">
                    <div className="h-0.5 w-2.5 rounded-r bg-blue-400" />
                    <div className="h-0.5 w-2.5 rounded-r bg-blue-400" />
                  </div>
                </div>
              )}

              {/* Out bracket marker — draggable */}
              {sourceOut !== null && (
                <div
                  className="absolute bottom-0 top-0 z-10 flex cursor-ew-resize items-center"
                  style={{
                    left: `${(sourceOut / (sourceAsset!.duration || 5)) * 100}%`,
                    width: 14,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setDraggingMarker("sourceOut");
                  }}
                >
                  <div className="pointer-events-none flex h-full w-1.5 flex-col justify-between rounded-r-sm bg-blue-400 py-0.5">
                    <div className="-ml-1 h-0.5 w-2.5 rounded-l bg-blue-400" />
                    <div className="-ml-1 h-0.5 w-2.5 rounded-l bg-blue-400" />
                  </div>
                </div>
              )}

              {/* Playhead needle */}
              <div
                className="absolute bottom-0 top-0 z-20"
                style={{
                  left: `${(sourceTime / (sourceAsset.duration || 5)) * 100}%`,
                }}
              >
                <div
                  className="clip-triangle absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 bg-blue-400"
                  style={{ clipPath: "polygon(50% 100%, 0% 0%, 100% 0%)" }}
                />
                <div className="absolute bottom-0 left-1/2 top-2 w-px -translate-x-1/2 bg-blue-400" />
              </div>
            </div>

            {/* In/Out timecode labels below scrub bar */}
            {(sourceIn !== null || sourceOut !== null) && (
              <div className="mt-0.5 flex h-3.5 items-center justify-between">
                <span className="font-mono text-[9px] text-blue-400/80">
                  {sourceIn !== null ? `IN ${formatTime(sourceIn)}` : ""}
                </span>
                <span className="font-mono text-[9px] text-zinc-500">
                  {sourceIn !== null && sourceOut !== null
                    ? `Duration: ${formatTime(sourceOut - sourceIn)}`
                    : ""}
                </span>
                <span className="font-mono text-[9px] text-blue-400/80">
                  {sourceOut !== null ? `OUT ${formatTime(sourceOut)}` : ""}
                </span>
              </div>
            )}
          </div>
        )}
      {/* Status bar: timecode | transport controls | duration */}
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-950 px-3">
        {/* Left: current timecode */}
        <span className="min-w-[90px] select-none font-mono text-[12px] font-medium tabular-nums tracking-tight text-amber-400">
          {formatTime(sourceTime)}
        </span>

        {/* Center: transport controls */}
        <div className="flex flex-1 items-center justify-center gap-0.5">
          {/* Mark In */}
          <Tooltip
            content={
              sourceIn !== null ? `In: ${formatTime(sourceIn)}` : "Set In (I)"
            }
            side="top"
          >
            <button
              onClick={() =>
                setSourceIn((prev) =>
                  prev !== null && Math.abs(prev - sourceTime) < 0.01
                    ? null
                    : sourceTime,
                )
              }
              className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${sourceIn !== null ? "text-yellow-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-white"}`}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="7,4 4,4 4,20 7,20" />
                <line x1="10" y1="12" x2="20" y2="12" />
                <polyline points="16,8 20,12 16,16" />
              </svg>
            </button>
          </Tooltip>
          <div className="h-3 w-px bg-zinc-700" />
          <Tooltip content="Go to start" side="top">
            <button
              onClick={() => {
                const t = sourceIn ?? 0;
                setSourceTime(t);
                if (sourceVideoRef.current)
                  sourceVideoRef.current.currentTime = t;
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <SkipBack className="h-3 w-3" />
            </button>
          </Tooltip>
          <Tooltip content="Step back" side="top">
            <button
              onClick={() => {
                setSourceReversePlaying(false);
                const t = Math.max(0, sourceTime - 1 / 24);
                setSourceTime(t);
                if (sourceVideoRef.current)
                  sourceVideoRef.current.currentTime = t;
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Play reverse" side="top">
            <button
              onClick={() => {
                if (sourceReversePlaying) {
                  setSourceReversePlaying(false);
                } else {
                  sourceVideoRef.current?.pause();
                  setSourceIsPlaying(false);
                  setSourceReversePlaying(true);
                }
              }}
              className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${sourceReversePlaying ? "text-blue-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-white"}`}
            >
              <Play className="mr-0.5 h-3 w-3 rotate-180" />
            </button>
          </Tooltip>
          <Tooltip content="Stop" side="top">
            <button
              onClick={() => {
                setSourceReversePlaying(false);
                sourceVideoRef.current?.pause();
                setSourceIsPlaying(false);
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Square className="h-2.5 w-2.5" />
            </button>
          </Tooltip>
          <Tooltip content={sourceIsPlaying ? "Pause" : "Play"} side="top">
            <button
              onClick={() => {
                setSourceReversePlaying(false);
                if (sourceIsPlaying) {
                  sourceVideoRef.current?.pause();
                  setSourceIsPlaying(false);
                } else {
                  if (sourceVideoRef.current) {
                    if (sourceIn !== null && sourceTime < sourceIn)
                      sourceVideoRef.current.currentTime = sourceIn;
                    sourceVideoRef.current.play().catch(() => {});
                  }
                  setSourceIsPlaying(true);
                }
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              {sourceIsPlaying ? (
                <Pause className="h-3 w-3" />
              ) : (
                <Play className="ml-0.5 h-3 w-3" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Step forward" side="top">
            <button
              onClick={() => {
                const dur = sourceAsset?.duration || 5;
                const t = Math.min(dur, sourceTime + 1 / 24);
                setSourceTime(t);
                if (sourceVideoRef.current)
                  sourceVideoRef.current.currentTime = t;
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Go to end" side="top">
            <button
              onClick={() => {
                const t = sourceOut ?? (sourceAsset?.duration || 5);
                setSourceTime(t);
                if (sourceVideoRef.current)
                  sourceVideoRef.current.currentTime = t;
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <SkipForward className="h-3 w-3" />
            </button>
          </Tooltip>
          <div className="h-3 w-px bg-zinc-700" />
          {/* Mark Out */}
          <Tooltip
            content={
              sourceOut !== null
                ? `Out: ${formatTime(sourceOut)}`
                : "Set Out (O)"
            }
            side="top"
          >
            <button
              onClick={() =>
                setSourceOut((prev) =>
                  prev !== null && Math.abs(prev - sourceTime) < 0.01
                    ? null
                    : sourceTime,
                )
              }
              className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${sourceOut !== null ? "text-yellow-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-white"}`}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="17,4 20,4 20,20 17,20" />
                <line x1="14" y1="12" x2="4" y2="12" />
                <polyline points="8,8 4,12 8,16" />
              </svg>
            </button>
          </Tooltip>
          <div className="mx-0.5 h-3 w-px bg-zinc-700" />
          {/* Insert */}
          <Tooltip content="Insert Edit (,)" side="top">
            <button
              onClick={onInsertEdit}
              disabled={!sourceAsset}
              className="flex h-6 items-center rounded px-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </Tooltip>
          {/* Overwrite */}
          <Tooltip content="Overwrite Edit (.)" side="top">
            <button
              onClick={onOverwriteEdit}
              disabled={!sourceAsset}
              className="flex h-6 items-center rounded px-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 12h6" />
              </svg>
            </button>
          </Tooltip>
        </div>

        {/* Right: total duration */}
        <span className="min-w-[90px] select-none text-right font-mono text-[12px] font-medium tabular-nums tracking-tight text-zinc-400">
          {formatTime(sourceAsset?.duration || 0)}
        </span>
      </div>
    </div>
  );
}
