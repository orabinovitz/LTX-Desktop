import React from "react";
import { X, Palette } from "lucide-react";
import type { Track, SubtitleClip, SubtitleStyle } from "../../types/project";
import { DEFAULT_SUBTITLE_STYLE } from "../../types/project";

interface SubtitleTrackStyleEditorProps {
  subtitleTrackStyleIdx: number;
  setSubtitleTrackStyleIdx: (idx: number | null) => void;
  tracks: Track[];
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleClip[]>>;
}

export function SubtitleTrackStyleEditor({
  subtitleTrackStyleIdx,
  setSubtitleTrackStyleIdx,
  tracks,
  setTracks,
  setSubtitles,
}: SubtitleTrackStyleEditorProps) {
  const stTrack = tracks[subtitleTrackStyleIdx];
  if (!stTrack || stTrack.type !== "subtitle") return null;
  const ts = { ...DEFAULT_SUBTITLE_STYLE, ...stTrack.subtitleStyle };
  const updateTrackStyle = (patch: Partial<SubtitleStyle>) => {
    setTracks((prev) =>
      prev.map((t, i) =>
        i === subtitleTrackStyleIdx
          ? { ...t, subtitleStyle: { ...t.subtitleStyle, ...patch } }
          : t,
      ),
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setSubtitleTrackStyleIdx(null)}
    >
      <div
        className="flex max-h-[80vh] w-[380px] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-600/20">
              <Palette className="h-3.5 w-3.5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Track Style</h2>
              <p className="text-[10px] text-zinc-500">
                {stTrack.name} - applies to all subtitles on this track
              </p>
            </div>
          </div>
          <button
            onClick={() => setSubtitleTrackStyleIdx(null)}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-auto p-5">
          {/* Preview */}
          <div className="flex min-h-[60px] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <span
              className="inline-block rounded px-3 py-1.5 text-center leading-snug"
              style={{
                fontSize: `${Math.min(ts.fontSize, 28)}px`,
                fontFamily: ts.fontFamily,
                fontWeight: ts.fontWeight,
                fontStyle: ts.italic ? "italic" : "normal",
                color: ts.color,
                backgroundColor: ts.backgroundColor,
                textShadow: "1px 1px 3px rgba(0,0,0,0.8)",
              }}
            >
              Preview subtitle
            </span>
          </div>

          {/* Font size */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Font Size</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={16}
                max={72}
                value={ts.fontSize}
                onChange={(e) =>
                  updateTrackStyle({ fontSize: parseInt(e.target.value) })
                }
                className="w-24 accent-amber-500"
              />
              <span className="w-8 text-right text-[10px] tabular-nums text-zinc-300">
                {ts.fontSize}px
              </span>
            </div>
          </div>

          {/* Font family */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Font</span>
            <select
              value={ts.fontFamily}
              onChange={(e) => updateTrackStyle({ fontFamily: e.target.value })}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-white focus:border-amber-500/50 focus:outline-none"
            >
              <option value="sans-serif">Sans-Serif</option>
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
              <option value="'Arial', sans-serif">Arial</option>
              <option value="'Helvetica Neue', sans-serif">Helvetica</option>
              <option value="'Georgia', serif">Georgia</option>
              <option value="'Courier New', monospace">Courier New</option>
              <option value="'Times New Roman', serif">Times New Roman</option>
            </select>
          </div>

          {/* Bold / Italic */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Style</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  updateTrackStyle({
                    fontWeight: ts.fontWeight === "bold" ? "normal" : "bold",
                  })
                }
                className={`rounded px-2.5 py-1 text-[10px] font-bold ${ts.fontWeight === "bold" ? "border border-amber-500/40 bg-amber-600/30 text-amber-300" : "border border-zinc-700 bg-zinc-800 text-zinc-400"}`}
              >
                B
              </button>
              <button
                onClick={() => updateTrackStyle({ italic: !ts.italic })}
                className={`rounded px-2.5 py-1 text-[10px] italic ${ts.italic ? "border border-amber-500/40 bg-amber-600/30 text-amber-300" : "border border-zinc-700 bg-zinc-800 text-zinc-400"}`}
              >
                I
              </button>
            </div>
          </div>

          {/* Text color */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Text Color</span>
            <input
              type="color"
              value={ts.color}
              onChange={(e) => updateTrackStyle({ color: e.target.value })}
              className="h-6 w-7 cursor-pointer rounded border border-zinc-700"
            />
          </div>

          {/* Background toggle + color */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Background</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  updateTrackStyle({
                    backgroundColor:
                      ts.backgroundColor === "transparent"
                        ? "#000000AA"
                        : "transparent",
                  })
                }
                className={`rounded border px-2 py-0.5 text-[9px] ${ts.backgroundColor !== "transparent" ? "border-amber-500/40 bg-amber-600/20 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-500"}`}
              >
                {ts.backgroundColor !== "transparent" ? "On" : "Off"}
              </button>
              {ts.backgroundColor !== "transparent" && (
                <input
                  type="color"
                  value={ts.backgroundColor.slice(0, 7)}
                  onChange={(e) =>
                    updateTrackStyle({ backgroundColor: e.target.value + "CC" })
                  }
                  className="h-6 w-7 cursor-pointer rounded border border-zinc-700"
                />
              )}
            </div>
          </div>

          {/* Position */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-400">Position</span>
            <select
              value={ts.position}
              onChange={(e) =>
                updateTrackStyle({
                  position: e.target.value as SubtitleStyle["position"],
                })
              }
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-white focus:border-amber-500/50 focus:outline-none"
            >
              <option value="bottom">Bottom</option>
              <option value="center">Center</option>
              <option value="top">Top</option>
            </select>
          </div>

          <div className="mt-3 border-t border-zinc-800 pt-3">
            <button
              onClick={() => {
                setSubtitles((prev) =>
                  prev.map((s) =>
                    s.trackIndex === subtitleTrackStyleIdx
                      ? { ...s, style: undefined }
                      : s,
                  ),
                );
                setSubtitleTrackStyleIdx(null);
              }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-center text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Apply to all &amp; reset overrides
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
