import React from "react";
import {
  Plus,
  Gauge,
  Download,
  Maximize2,
  FileUp,
  FileDown,
  ZoomOut,
  ZoomIn,
} from "lucide-react"; // IC-LORA HIDDEN: removed Sparkles
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import type { TimelineClip, Track, SubtitleClip } from "../../types/project";

interface TimelineToolbarProps {
  selectedClip: TimelineClip | null;
  updateClip: (id: string, updates: Partial<TimelineClip>) => void;
  getMaxClipDuration: (clip: TimelineClip) => number;
  setShowExportModal: (v: boolean) => void;
  handleResetLayout: () => void;
  setIcLoraSourceClipId: (id: string | null) => void;
  setShowICLoraPanel: (v: boolean) => void;
  tracks: Track[];
  subtitleFileInputRef: React.RefObject<HTMLInputElement>;
  handleImportSrt: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleExportSrt: () => void;
  subtitles: SubtitleClip[];
  zoom: number;
  setZoom: (z: number) => void;
  getMinZoom: () => number;
  centerOnPlayheadRef: React.MutableRefObject<boolean>;
  handleFitToView: () => void;
}

export function TimelineToolbar({
  selectedClip,
  updateClip,
  getMaxClipDuration,
  setShowExportModal,
  handleResetLayout,
  setIcLoraSourceClipId: _setIcLoraSourceClipId, // eslint-disable-line @typescript-eslint/no-unused-vars -- IC-LORA HIDDEN: kept for future re-enable
  setShowICLoraPanel: _setShowICLoraPanel, // eslint-disable-line @typescript-eslint/no-unused-vars -- IC-LORA HIDDEN: kept for future re-enable
  tracks,
  subtitleFileInputRef,
  handleImportSrt,
  handleExportSrt,
  subtitles,
  zoom,
  setZoom,
  getMinZoom,
  centerOnPlayheadRef,
  handleFitToView,
}: TimelineToolbarProps) {
  return (
    <div className="flex h-9 flex-shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3">
      <Button
        variant="outline"
        size="sm"
        className="h-6 border-zinc-700 px-2 text-[10px] text-zinc-400"
      >
        <Plus className="mr-1 h-3 w-3" />
        Add Clip
      </Button>

      {selectedClip && (
        <>
          <div className="h-4 w-px bg-zinc-700" />
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <Gauge className="h-3 w-3" />
            <select
              value={selectedClip.speed}
              onChange={(e) => {
                const newSpeed = parseFloat(e.target.value);
                const oldSpeed = selectedClip.speed;
                let newDuration = selectedClip.duration * (oldSpeed / newSpeed);
                const maxDur = getMaxClipDuration({
                  ...selectedClip,
                  speed: newSpeed,
                });
                newDuration = Math.min(newDuration, maxDur);
                newDuration = Math.max(0.5, newDuration);
                updateClip(selectedClip.id, {
                  speed: newSpeed,
                  duration: newDuration,
                });
              }}
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-white"
            >
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.5x</option>
              <option value={0.75}>0.75x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </div>
        </>
      )}

      <div className="h-4 w-px bg-zinc-700" />

      <Button
        variant="outline"
        size="sm"
        className="h-6 border-zinc-700 px-2 text-[10px] text-zinc-400"
        onClick={() => setShowExportModal(true)}
      >
        <Download className="mr-1 h-3 w-3" />
        Export
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-6 border-zinc-700 px-2 text-[10px] text-zinc-400"
        onClick={handleResetLayout}
        title="Reset panel sizes to default"
      >
        <Maximize2 className="mr-1 h-3 w-3" />
        Layout
      </Button>

      {/* IC-LORA HIDDEN - IC-LoRA toolbar button hidden because IC-LoRA is broken on server
      <div className="w-px h-4 bg-zinc-700" />

      <Button
        variant="outline"
        size="sm"
        className="h-6 border-amber-700/50 text-amber-400 text-[10px] px-2 hover:bg-amber-900/30"
        onClick={() => {
          setIcLoraSourceClipId(selectedClip?.type === 'video' ? selectedClip.id : null)
          setShowICLoraPanel(true)
        }}
        title="Open IC-LoRA style transfer panel"
      >
        <Sparkles className="h-3 w-3 mr-1" />
        IC-LoRA
      </Button>
      */}

      {/* Subtitle import/export */}
      {tracks.some((t) => t.type === "subtitle") && (
        <>
          <div className="h-4 w-px bg-zinc-700" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => subtitleFileInputRef.current?.click()}
              className="flex h-6 items-center gap-1 rounded border border-amber-700/30 bg-amber-900/30 px-2 text-[10px] text-amber-400 transition-colors hover:bg-amber-900/50"
              title="Import SRT subtitles"
            >
              <FileUp className="h-3 w-3" />
              Import SRT
            </button>
            <button
              onClick={handleExportSrt}
              disabled={subtitles.length === 0}
              className="flex h-6 items-center gap-1 rounded border border-amber-700/30 bg-amber-900/30 px-2 text-[10px] text-amber-400 transition-colors hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-40"
              title="Export SRT subtitles"
            >
              <FileDown className="h-3 w-3" />
              Export SRT
            </button>
          </div>
          <input
            ref={subtitleFileInputRef}
            type="file"
            accept=".srt"
            onChange={handleImportSrt}
            className="hidden"
          />
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Zoom slider bar */}
      <div className="flex items-center gap-2">
        <Tooltip content="Zoom out (-)">
          <button
            onClick={() => {
              centerOnPlayheadRef.current = true;
              setZoom(Math.max(getMinZoom(), +(zoom - 0.25).toFixed(2)));
            }}
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <input
          type="range"
          min={Math.max(1, Math.round(getMinZoom() * 100))}
          max={400}
          step={5}
          value={Math.round(zoom * 100)}
          onChange={(e) => {
            centerOnPlayheadRef.current = true;
            setZoom(
              Math.max(
                getMinZoom(),
                +(parseInt(e.target.value) / 100).toFixed(2),
              ),
            );
          }}
          className="h-1 w-28 cursor-pointer accent-blue-500"
          title={`Zoom: ${Math.round(zoom * 100)}%`}
        />
        <Tooltip content="Zoom in (+)">
          <button
            onClick={() => {
              centerOnPlayheadRef.current = true;
              setZoom(Math.min(4, +(zoom + 0.25).toFixed(2)));
            }}
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <span className="w-8 text-right text-[10px] tabular-nums text-zinc-500">
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip content="Fit to view (Ctrl+0)">
          <button
            onClick={handleFitToView}
            className="ml-0.5 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
