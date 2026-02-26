# Video Analysis Status Indicator — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a visual indicator on video asset cards in the project bin so users know when Gemini video analysis is in progress, complete, or failed.

**Architecture:** A new `useAnalysisStatus` hook polls `GET /api/agent/video-metadata/{asset_id}` for video assets that are being analyzed. The status map is passed to `LeftPanel`, which renders a small badge overlay on each video thumbnail. Polling starts when `triggerVideoAnalysis` is called and stops when status reaches `complete` or `failed`.

**Tech Stack:** React hooks, Tailwind CSS, existing FastAPI endpoint

---

## Task 1: Create `useAnalysisStatus` Hook

**Files:**
- Create: `src/hooks/use-analysis-status.ts`

**Step 1: Create the hook**

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'

export type AnalysisStatus = 'analyzing' | 'complete' | 'failed'

export function useAnalysisStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, AnalysisStatus>>(new Map())
  const pollingRef = useRef<Set<string>>(new Set())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const markAnalyzing = useCallback((assetId: string) => {
    pollingRef.current.add(assetId)
    setStatusMap(prev => {
      const next = new Map(prev)
      next.set(assetId, 'analyzing')
      return next
    })
  }, [])

  useEffect(() => {
    const poll = async () => {
      const ids = [...pollingRef.current]
      if (ids.length === 0) return

      for (const assetId of ids) {
        try {
          const backendUrl = await window.electronAPI.getBackendUrl()
          const res = await fetch(`${backendUrl}/api/agent/video-metadata/${assetId}`)
          if (!res.ok) continue
          const data = await res.json()
          const status = data.analysis_status as string | undefined

          if (status === 'complete' || status === 'failed') {
            pollingRef.current.delete(assetId)
            setStatusMap(prev => {
              const next = new Map(prev)
              next.set(assetId, status as AnalysisStatus)
              return next
            })
          }
        } catch {
          // Network error — keep polling
        }
      }
    }

    intervalRef.current = setInterval(poll, 3000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  return { statusMap, markAnalyzing }
}
```

**Step 2: Commit**

```bash
git add src/hooks/use-analysis-status.ts
git commit -m "feat: add useAnalysisStatus hook for polling video analysis status"
```

---

## Task 2: Wire Hook into VideoEditor and Pass to LeftPanel

**Files:**
- Modify: `src/views/VideoEditor.tsx:505-514` (analysis trigger effect)
- Modify: `src/views/editor/LeftPanel.tsx:12-73` (props interface)

**Step 1: Import and use the hook in VideoEditor**

In `src/views/VideoEditor.tsx`, add the import (near line 63 where `use-agent` is imported):

```typescript
import { useAnalysisStatus } from '../hooks/use-analysis-status'
```

Then right after the `useAgent()` call (around line 498), add:

```typescript
const { statusMap: analysisStatusMap, markAnalyzing } = useAnalysisStatus()
```

**Step 2: Update the analysis trigger effect to call `markAnalyzing`**

Replace the existing effect at lines 505-514:

```typescript
  // Trigger background video analysis for newly imported video assets
  const analyzedAssetIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const asset of assets) {
      if (asset.type === 'video' && asset.path && !analyzedAssetIds.current.has(asset.id)) {
        analyzedAssetIds.current.add(asset.id)
        triggerVideoAnalysis(asset.id, asset.path)
        markAnalyzing(asset.id)
      }
    }
  }, [assets, markAnalyzing])
```

**Step 3: Add `analysisStatusMap` to LeftPanel props**

In `src/views/editor/LeftPanel.tsx`, add to the `LeftPanelProps` interface (after `regeneratingAssetId` at line 52):

```typescript
  analysisStatusMap: Map<string, import('../hooks/use-analysis-status').AnalysisStatus>
```

**Step 4: Pass the prop where LeftPanel is rendered in VideoEditor**

Find where `<LeftPanel` is rendered in VideoEditor.tsx and add the prop:

```typescript
analysisStatusMap={analysisStatusMap}
```

**Step 5: Destructure the new prop inside LeftPanel**

In the destructuring block of `LeftPanel` (around line 76-92), add:

```typescript
analysisStatusMap,
```

**Step 6: Commit**

```bash
git add src/views/VideoEditor.tsx src/views/editor/LeftPanel.tsx
git commit -m "feat: wire analysis status hook into VideoEditor and LeftPanel"
```

---

## Task 3: Render Status Badge on Video Asset Cards

**Files:**
- Modify: `src/views/editor/LeftPanel.tsx:699-703` (video thumbnail section)

**Step 1: Add the badge overlay after VideoThumbnailCard**

Replace the video thumbnail block at lines 699-703:

```typescript
                  {asset.type === 'video' ? (
                    <div className="relative">
                      <VideoThumbnailCard
                        url={asset.url}
                        thumbnailUrl={thumbnailMap[asset.url]}
                      />
                      {/* Analysis status badge */}
                      {analysisStatusMap.get(asset.id) === 'analyzing' && (
                        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur-sm z-10">
                          <div className="h-2 w-2 rounded-full border-[1.5px] border-blue-400 border-t-transparent animate-spin" />
                          <span className="text-[9px] text-blue-300 font-medium">Analyzing</span>
                        </div>
                      )}
                      {analysisStatusMap.get(asset.id) === 'complete' && (
                        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur-sm z-10">
                          <div className="h-2 w-2 rounded-full bg-emerald-400" />
                          <span className="text-[9px] text-emerald-300 font-medium">Ready</span>
                        </div>
                      )}
                      {analysisStatusMap.get(asset.id) === 'failed' && (
                        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur-sm z-10">
                          <div className="h-2 w-2 rounded-full bg-red-400" />
                          <span className="text-[9px] text-red-300 font-medium">Failed</span>
                        </div>
                      )}
                    </div>
                  ) : asset.type === 'audio' ? (
```

Note: Only the opening `{asset.type === 'video' ? (` through to the `) : asset.type === 'audio' ? (` needs to change. The rest of the conditional stays as-is.

**Step 2: Commit**

```bash
git add src/views/editor/LeftPanel.tsx
git commit -m "feat: render analysis status badge on video asset thumbnails

Shows 'Analyzing' spinner, 'Ready' green dot, or 'Failed' red dot
on video assets in the project bin."
```

---

## Summary

| Task | What | Files | Risk |
|------|------|-------|------|
| 1 | `useAnalysisStatus` hook | New: `use-analysis-status.ts` | Low |
| 2 | Wire hook into VideoEditor + LeftPanel | 2 files modified | Low |
| 3 | Render badge on thumbnails | `LeftPanel.tsx` | Low |

3 tasks, 3 files touched (1 new, 2 modified), no backend changes.
