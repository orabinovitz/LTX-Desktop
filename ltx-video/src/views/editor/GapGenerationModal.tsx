import React, { useMemo, useEffect } from "react";
import {
  Play,
  X,
  Upload,
  Trash2,
  Video,
  Image,
  Loader2,
  Sparkles,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { SettingsPanel } from "../../components/SettingsPanel";
import type { GenerationSettings } from "../../components/SettingsPanel";
import type { GenerationMode } from "../../components/ModeTabs";

import type { TimelineGap } from "../../types/project";

const SHOT_TYPES = [
  { value: "none", label: "Default" },
  { value: "Extreme close-up", label: "Extreme Close-up" },
  { value: "Close-up", label: "Close-up" },
  { value: "Medium close-up", label: "Medium Close-up" },
  { value: "Medium shot", label: "Medium Shot" },
  { value: "Medium wide shot", label: "Medium Wide" },
  { value: "Wide shot", label: "Wide Shot" },
  { value: "Full shot", label: "Full Shot" },
  { value: "Over the shoulder", label: "Over the Shoulder" },
  { value: "POV shot", label: "POV" },
];

const CAMERA_ANGLES = [
  { value: "none", label: "Default" },
  { value: "eye level", label: "Eye Level" },
  { value: "low angle", label: "Low Angle" },
  { value: "high angle", label: "High Angle" },
  { value: "from the side", label: "From the Side" },
  { value: "from behind", label: "From Behind" },
  { value: "three-quarter view", label: "3/4 View" },
  { value: "dutch angle", label: "Dutch Angle" },
  { value: "bird's eye view", label: "Bird's Eye" },
  { value: "worm's eye view", label: "Worm's Eye" },
];

type GapGenerateMode = "text-to-video" | "image-to-video" | "text-to-image";

function dataUriToFile(dataUri: string, filename: string): File {
  const [header, b64] = dataUri.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

interface GapGenerationModalProps {
  selectedGap: TimelineGap | null;
  anchorPosition?: { x: number; gapTop: number; gapBottom: number } | null;
  gapGenerateMode: GapGenerateMode | null;
  setGapGenerateMode: (mode: GapGenerateMode | null) => void;
  gapPrompt: string;
  setGapPrompt: (prompt: string) => void;
  gapSuggesting: boolean;
  gapSuggestion: string | null;
  gapBeforeFrame: string | null;
  gapAfterFrame: string | null;
  gapSettings: GenerationSettings;
  setGapSettings: (settings: GenerationSettings) => void;
  gapImageFile: File | null;
  setGapImageFile: (file: File | null) => void;
  gapImageInputRef: React.RefObject<HTMLInputElement>;
  isRegenerating: boolean;
  regenStatusMessage: string;
  regenProgress: number;
  regenReset: () => void;
  handleGapGenerate: () => void;
  deleteGap: (gap: TimelineGap) => void;
  setSelectedGap: (gap: TimelineGap | null) => void;
  gapShotType: string;
  setGapShotType: (v: string) => void;
  gapCameraAngle: string;
  setGapCameraAngle: (v: string) => void;
  gapApplyAudioToTrack: boolean;
  setGapApplyAudioToTrack: (v: boolean) => void;
  regenerateSuggestion: () => void;
  gapSuggestionError?: boolean;
}

function Dropdown({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex-1">
      <label className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full cursor-pointer appearance-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 pr-7 text-xs text-zinc-200 focus:border-blue-500/50 focus:outline-none"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
      </div>
    </div>
  );
}

export function GapGenerationModal({
  selectedGap,
  gapGenerateMode,
  setGapGenerateMode,
  gapPrompt,
  setGapPrompt,
  gapSuggesting,
  gapSuggestion,
  gapBeforeFrame,
  gapAfterFrame,
  gapSettings,
  setGapSettings,
  gapImageFile,
  setGapImageFile,
  gapImageInputRef,
  isRegenerating,
  regenStatusMessage,
  regenProgress,
  regenReset,
  handleGapGenerate,
  deleteGap,
  setSelectedGap,
  gapShotType,
  setGapShotType,
  gapCameraAngle,
  setGapCameraAngle,
  gapApplyAudioToTrack,
  setGapApplyAudioToTrack,
  regenerateSuggestion,
  gapSuggestionError,
  anchorPosition,
}: GapGenerationModalProps) {
  const isVideoMode =
    gapGenerateMode === "text-to-video" || gapGenerateMode === "image-to-video";
  const isImageMode = gapGenerateMode === "text-to-image";

  const gapImageUrl = useMemo(() => {
    if (!gapImageFile) return null;
    return URL.createObjectURL(gapImageFile);
  }, [gapImageFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (gapGenerateMode) {
          setGapGenerateMode(null);
          regenReset();
        } else {
          setSelectedGap(null);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gapGenerateMode, setGapGenerateMode, regenReset, setSelectedGap]);

  if (!selectedGap) return null;

  const modalTitle = isVideoMode
    ? gapImageFile
      ? "Image to Video"
      : "Generate Video"
    : gapImageFile
      ? "Edit Image"
      : "Generate Image";

  const settingsMode: GenerationMode = isVideoMode
    ? gapImageFile
      ? "image-to-video"
      : "text-to-video"
    : "text-to-image";

  return (
    <>
      {gapGenerateMode && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
          <div className="my-auto flex max-h-[calc(100vh-2rem)] w-[520px] shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                    isVideoMode ? "bg-blue-600/20" : "bg-emerald-600/20"
                  }`}
                >
                  {isVideoMode ? (
                    <Video className="h-3.5 w-3.5 text-blue-400" />
                  ) : (
                    <Image className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    {modalTitle}
                  </h2>
                  <p className="text-[10px] text-zinc-500">
                    Fill{" "}
                    {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s
                    gap on Track {selectedGap.trackIndex + 1}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setGapGenerateMode(null);
                  regenReset();
                }}
                className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Timeline visualization */}
            <div className="px-5 pb-2 pt-4">
              <div className="relative flex h-[72px] overflow-hidden rounded-lg border border-zinc-700/40 bg-zinc-800/50">
                {/* Before frame */}
                {gapBeforeFrame ? (
                  <div
                    className="group/before relative h-full w-[30%] flex-shrink-0 cursor-pointer overflow-hidden"
                    onClick={() => {
                      if (gapImageFile) return;
                      try {
                        setGapImageFile(
                          dataUriToFile(gapBeforeFrame, "frame-before.jpg"),
                        );
                      } catch {
                        /* data URI conversion may fail for malformed frames */
                      }
                    }}
                    title={gapImageFile ? undefined : "Click to use as input"}
                  >
                    <img
                      src={gapBeforeFrame}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-zinc-900/80 to-transparent" />
                    {!gapImageFile && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/before:bg-black/40">
                        <span className="rounded bg-black/50 px-2 py-0.5 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover/before:opacity-100">
                          Use this
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full w-[30%] flex-shrink-0 items-center justify-center bg-zinc-800/80">
                    <span className="text-[8px] text-zinc-600">No clip</span>
                  </div>
                )}

                {/* Center gap area */}
                <div className="relative flex-1 overflow-hidden">
                  {gapImageFile && gapImageUrl ? (
                    <div className="group/center relative h-full w-full">
                      <img
                        src={gapImageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 rounded-sm ring-2 ring-inset ring-blue-500/50" />
                      <button
                        onClick={() => setGapImageFile(null)}
                        className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white/70 opacity-0 transition-opacity hover:text-red-400 group-hover/center:opacity-100"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
                        <span className="text-[8px] font-medium text-blue-200/90">
                          {isVideoMode ? "Source frame" : "Edit reference"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="group/center relative h-full w-full cursor-pointer"
                      onClick={() => gapImageInputRef.current?.click()}
                    >
                      <div className="absolute inset-0 bg-zinc-900/90" />
                      <div className="absolute inset-0 border border-dashed border-zinc-600 transition-colors group-hover/center:border-blue-500/50" />
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <Sparkles className="h-3.5 w-3.5 text-blue-400/30" />
                        <span className="text-[8px] font-medium text-zinc-500">
                          AI fills this gap
                        </span>
                        <span className="flex items-center gap-0.5 text-[7px] text-zinc-600 transition-colors group-hover/center:text-blue-400/70">
                          <Upload className="h-2 w-2" /> Add image
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* After frame */}
                {gapAfterFrame ? (
                  <div
                    className="group/after relative h-full w-[30%] flex-shrink-0 cursor-pointer overflow-hidden"
                    onClick={() => {
                      if (gapImageFile) return;
                      try {
                        setGapImageFile(
                          dataUriToFile(gapAfterFrame, "frame-after.jpg"),
                        );
                      } catch {
                        /* data URI conversion may fail for malformed frames */
                      }
                    }}
                    title={gapImageFile ? undefined : "Click to use as input"}
                  >
                    <img
                      src={gapAfterFrame}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-zinc-900/80 to-transparent" />
                    {!gapImageFile && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/after:bg-black/40">
                        <span className="rounded bg-black/50 px-2 py-0.5 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover/after:opacity-100">
                          Use this
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full w-[30%] flex-shrink-0 items-center justify-center bg-zinc-800/80">
                    <span className="text-[8px] text-zinc-600">No clip</span>
                  </div>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-auto p-5">
              {/* Prompt */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Prompt
                  </label>
                  <div className="flex items-center gap-2">
                    {gapSuggesting && (
                      <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Analyzing timeline context...</span>
                      </div>
                    )}
                    {!gapSuggesting &&
                      gapSuggestion &&
                      gapPrompt === gapSuggestion && (
                        <div className="flex items-center gap-1 text-[10px] text-emerald-400/70">
                          <Sparkles className="h-3 w-3" />
                          <span>AI-suggested</span>
                        </div>
                      )}
                    {!gapSuggesting && (
                      <button
                        onClick={regenerateSuggestion}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-blue-400/80 transition-colors hover:bg-blue-900/30 hover:text-blue-300"
                        title="Re-analyze surrounding clips and generate a new prompt suggestion"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>Re-analyze</span>
                      </button>
                    )}
                  </div>
                </div>
                <div className="relative">
                  <textarea
                    value={gapPrompt}
                    onChange={(e) => setGapPrompt(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={
                      gapSuggesting
                        ? "Analyzing surrounding shots for context..."
                        : isImageMode
                          ? gapImageFile
                            ? "Describe the edits to apply..."
                            : "Describe the image to generate..."
                          : gapImageFile
                            ? "Describe the video to generate from the image..."
                            : "Describe the video shot to generate..."
                    }
                    className={`w-full resize-none rounded-lg border bg-zinc-800 p-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 ${
                      gapSuggesting
                        ? "animate-pulse border-amber-600/40 focus:border-amber-500/50 focus:ring-amber-500/30"
                        : "border-zinc-700 focus:border-blue-500/50 focus:ring-blue-500/30"
                    }`}
                    rows={3}
                  />
                  {gapSuggestion &&
                    gapPrompt !== gapSuggestion &&
                    !gapSuggesting && (
                      <button
                        onClick={() => setGapPrompt(gapSuggestion)}
                        className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md border border-amber-700/30 bg-amber-900/40 px-2 py-1 text-[10px] text-amber-300 transition-colors hover:bg-amber-900/60"
                        title="Use AI-suggested prompt"
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Use suggestion
                      </button>
                    )}
                </div>
                {gapSuggestionError && !gapSuggesting && !gapSuggestion && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Could not suggest a prompt. Type your own or try again.
                  </p>
                )}
              </div>

              {/* Shot type & camera angle — only for image editing (T2I with input image) */}
              {isImageMode && gapImageFile && (
                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Shot Framing
                  </label>
                  <div className="flex gap-3">
                    <Dropdown
                      label="SHOT TYPE"
                      value={gapShotType}
                      onChange={setGapShotType}
                      options={SHOT_TYPES}
                    />
                    <Dropdown
                      label="CAMERA ANGLE"
                      value={gapCameraAngle}
                      onChange={setGapCameraAngle}
                      options={CAMERA_ANGLES}
                    />
                  </div>
                </div>
              )}

              {/* Settings */}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Settings
                </label>
                <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-3">
                  <SettingsPanel
                    settings={gapSettings}
                    onSettingsChange={setGapSettings}
                    disabled={isRegenerating}
                    mode={settingsMode}
                  />
                </div>
              </div>

              {/* Apply audio to audio track toggle — only in video mode when audio is on */}
              {isVideoMode && gapSettings.audio && (
                <div
                  className={`flex items-center justify-between rounded-lg border border-zinc-700/50 bg-zinc-800/50 px-3 py-2.5 ${
                    isRegenerating
                      ? "pointer-events-none opacity-40"
                      : "cursor-pointer"
                  }`}
                  onClick={() =>
                    !isRegenerating &&
                    setGapApplyAudioToTrack(!gapApplyAudioToTrack)
                  }
                >
                  <div>
                    <span className="text-xs text-zinc-300">
                      Apply audio to audio track
                    </span>
                    <p className="mt-0.5 text-[10px] text-zinc-500">
                      Place the generated audio as a linked clip on the audio
                      track
                    </p>
                  </div>
                  <div
                    className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                      gapApplyAudioToTrack ? "bg-blue-600" : "bg-zinc-700"
                    }`}
                  >
                    <div
                      className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        gapApplyAudioToTrack ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </div>
                </div>
              )}

              {/* Progress */}
              {isRegenerating && (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    <span className="text-xs text-zinc-300">
                      {regenStatusMessage || "Generating..."}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-700">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all duration-300"
                      style={{ width: `${regenProgress * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Hidden file input */}
            <input
              ref={gapImageInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setGapImageFile(file);
                if (gapImageInputRef.current)
                  gapImageInputRef.current.value = "";
              }}
              className="hidden"
            />

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-3">
              <span className="text-[10px] text-zinc-600">
                Duration:{" "}
                {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setGapGenerateMode(null);
                    regenReset();
                  }}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleGapGenerate}
                  disabled={isRegenerating || !gapPrompt.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isRegenerating ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" />
                      Generate
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gap action bar - shown when gap is selected but no generate mode yet */}
      {!gapGenerateMode &&
        (() => {
          // Smart positioning: anchor to the clicked gap, with edge-case clamping
          const POPOVER_W = 420;
          const POPOVER_H = 96;
          const GAP_PX = 4;
          const MARGIN = 8;
          const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
          const vh = typeof window !== "undefined" ? window.innerHeight : 800;

          const cx = anchorPosition?.x ?? vw / 2;
          const gapTop = anchorPosition?.gapTop ?? vh - 220 - 52;
          const gapBottom = anchorPosition?.gapBottom ?? vh - 220;

          // Horizontal: center on gap, clamped so popover stays in viewport
          const left = Math.max(
            MARGIN,
            Math.min(cx - POPOVER_W / 2, vw - POPOVER_W - MARGIN),
          );

          // Vertical: prefer below gap, flip above if not enough space below
          const spaceBelow = vh - gapBottom - GAP_PX;
          const openAbove = spaceBelow < POPOVER_H + MARGIN;
          const rawTop = openAbove
            ? gapTop - GAP_PX - POPOVER_H
            : gapBottom + GAP_PX;
          const top = Math.max(
            MARGIN,
            Math.min(rawTop, vh - POPOVER_H - MARGIN),
          );

          return (
            <>
              <div
                className="fixed inset-0 z-[90]"
                onClick={() => setSelectedGap(null)}
              />
              <div
                className="fixed z-[100] rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 shadow-2xl"
                style={{ left, top, width: POPOVER_W }}
              >
                {/* Row 1: gap info + keyboard hint */}
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-white">
                    {(selectedGap.endTime - selectedGap.startTime).toFixed(1)}s
                    gap selected
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                    Press
                    <kbd className="rounded border border-zinc-600 bg-zinc-700 px-1.5 py-0.5 font-mono text-[10px] leading-none text-zinc-300">
                      Del
                    </kbd>
                    to close gap
                  </span>
                </div>
                {/* Row 2: action buttons */}
                <div className="flex gap-2">
                  <button
                    onClick={() => deleteGap(selectedGap)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-800/30 bg-red-900/30 px-3 py-2 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-900/50"
                  >
                    <Trash2 className="h-3 w-3" />
                    Close gap
                  </button>
                  <button
                    onClick={() => setGapGenerateMode("text-to-video")}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-700/30 bg-blue-900/30 px-3 py-2 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-900/50"
                  >
                    <Video className="h-3 w-3" />
                    Fill with Video
                  </button>
                  <button
                    onClick={() => setGapGenerateMode("text-to-image")}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald-700/30 bg-emerald-900/30 px-3 py-2 text-[11px] font-medium text-emerald-400 transition-colors hover:bg-emerald-900/50"
                  >
                    <Image className="h-3 w-3" />
                    Fill with image
                  </button>
                </div>
              </div>
            </>
          );
        })()}
    </>
  );
}
