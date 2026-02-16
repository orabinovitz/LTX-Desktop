import React from 'react'
import { Copy, RefreshCw, Loader2 } from 'lucide-react'

interface UpscaleTimelineDialogProps {
  showUpscaleDialog: { timelineId: string } | null
  setShowUpscaleDialog: (v: { timelineId: string } | null) => void
  handleUpscaleTimeline: (timelineId: string, mode: 'duplicate' | 'replace') => void
  upscaleTimelineProgress: { active: boolean; current: number; total: number } | null
}

export function UpscaleTimelineDialog({
  showUpscaleDialog, setShowUpscaleDialog,
  handleUpscaleTimeline, upscaleTimelineProgress,
}: UpscaleTimelineDialogProps) {
  return (
    <>
      {showUpscaleDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl p-6 w-[400px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Upscale Timeline</h3>
            <p className="text-sm text-zinc-400 mb-1">
              This will upscale all video clips in the timeline (2x resolution) using the LTX API.
            </p>
            <p className="text-xs text-zinc-500 mb-5">
              Each clip will be sent to the upscale API one at a time. This may take a while depending on the number of clips.
            </p>
            
            <div className="flex flex-col gap-2 mb-4">
              <button
                onClick={() => handleUpscaleTimeline(showUpscaleDialog.timelineId, 'duplicate')}
                className="w-full text-left px-4 py-3 rounded-xl bg-blue-600/20 border border-blue-500/40 hover:bg-blue-600/30 hover:border-blue-500/60 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Copy className="h-4 w-4 text-blue-400" />
                  <div>
                    <div className="text-sm font-medium text-white">Duplicate & Upscale</div>
                    <div className="text-[11px] text-zinc-400">Creates a copy of the timeline with upscaled clips. Original is preserved.</div>
                  </div>
                </div>
                <span className="text-[10px] text-blue-400 font-medium ml-7">Recommended</span>
              </button>
              
              <button
                onClick={() => handleUpscaleTimeline(showUpscaleDialog.timelineId, 'replace')}
                className="w-full text-left px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <RefreshCw className="h-4 w-4 text-zinc-400" />
                  <div>
                    <div className="text-sm font-medium text-zinc-300">Replace in Place</div>
                    <div className="text-[11px] text-zinc-500">Upscales clips in the current timeline. Cannot be undone.</div>
                  </div>
                </div>
              </button>
            </div>
            
            <button
              onClick={() => setShowUpscaleDialog(null)}
              className="w-full text-center py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {upscaleTimelineProgress?.active && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-zinc-900 border border-blue-500/40 rounded-xl shadow-2xl px-5 py-3 flex items-center gap-3">
          <Loader2 className="h-4 w-4 text-blue-400 animate-spin flex-shrink-0" />
          <div className="flex flex-col gap-1 min-w-[180px]">
            <span className="text-xs text-white font-medium">
              Upscaling clip {upscaleTimelineProgress.current} of {upscaleTimelineProgress.total}
            </span>
            <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${(upscaleTimelineProgress.current / upscaleTimelineProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
