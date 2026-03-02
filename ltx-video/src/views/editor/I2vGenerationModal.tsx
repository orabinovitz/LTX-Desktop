import { Play, X, Film, Loader2 } from "lucide-react";
import { SettingsPanel } from "../../components/SettingsPanel";
import type { GenerationSettings } from "../../components/SettingsPanel";
import type { TimelineClip } from "../../types/project";

interface I2vGenerationModalProps {
  i2vClipId: string | null;
  setI2vClipId: (id: string | null) => void;
  clips: TimelineClip[];
  resolveClipSrc: (clip: TimelineClip) => string;
  i2vPrompt: string;
  setI2vPrompt: (prompt: string) => void;
  i2vSettings: GenerationSettings;
  setI2vSettings: (settings: GenerationSettings) => void;
  isRegenerating: boolean;
  regenStatusMessage: string;
  regenProgress: number;
  regenReset: () => void;
  handleI2vGenerate: () => void;
}

export function I2vGenerationModal({
  i2vClipId,
  setI2vClipId,
  clips,
  resolveClipSrc,
  i2vPrompt,
  setI2vPrompt,
  i2vSettings,
  setI2vSettings,
  isRegenerating,
  regenStatusMessage,
  regenProgress,
  regenReset,
  handleI2vGenerate,
}: I2vGenerationModalProps) {
  if (!i2vClipId) return null;

  const i2vClip = clips.find((c) => c.id === i2vClipId);
  if (!i2vClip) return null;
  const i2vImageUrl = resolveClipSrc(i2vClip);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="my-auto flex max-h-[calc(100vh-2rem)] w-[520px] shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600/20">
              <Film className="h-3.5 w-3.5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">
                Image to Video
              </h2>
              <p className="text-[10px] text-zinc-500">
                Generate video from image clip ({i2vClip.duration.toFixed(1)}s)
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setI2vClipId(null);
              regenReset();
            }}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-auto p-5">
          {/* Source image preview */}
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Source Image
            </label>
            <div className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
              <img
                src={i2vImageUrl}
                alt="Source"
                className="max-h-40 w-full object-contain"
              />
            </div>
          </div>

          {/* Prompt */}
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Prompt
            </label>
            <textarea
              value={i2vPrompt}
              onChange={(e) => setI2vPrompt(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Describe the motion and action for the video..."
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-white placeholder-zinc-600 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              rows={3}
            />
          </div>

          {/* Settings */}
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Settings
            </label>
            <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-3">
              <SettingsPanel
                settings={i2vSettings}
                onSettingsChange={setI2vSettings}
                disabled={isRegenerating}
                mode="image-to-video"
              />
            </div>
          </div>

          {/* Progress */}
          {isRegenerating && i2vClipId && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                <span className="text-xs text-zinc-300">
                  {regenStatusMessage || "Generating video..."}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-700">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${regenProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-3">
          <span className="text-[10px] text-zinc-600">
            Clip duration: {i2vClip.duration.toFixed(1)}s
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setI2vClipId(null);
                regenReset();
              }}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              onClick={handleI2vGenerate}
              disabled={isRegenerating || !i2vPrompt.trim()}
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
                  Generate Video
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
