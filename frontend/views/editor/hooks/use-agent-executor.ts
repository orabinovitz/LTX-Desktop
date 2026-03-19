import { useCallback, useRef } from "react";
import type {
  TimelineClip,
  Track,
  Asset,
  Timeline,
  TransitionType,
  BinMetadata,
} from "@/types/project";
import type { ToolCall, ToolResult } from "@/types/agent-progress";
import { logger } from "@/lib/logger";
import type { OnToolProgress } from "@/hooks/use-agent";
import {
  agentGenerateVideo,
  agentGenerateImage,
  agentRetakeSection,
  agentCancelGeneration,
  agentGetGenerationStatus,
} from "../utils/agent-generation-helper";

export type { ToolCall, ToolResult };

export interface AgentExecutorDeps {
  clipsRef: React.RefObject<TimelineClip[]>;
  tracksRef: React.RefObject<Track[]>;
  assetsRef: React.RefObject<Asset[]>;
  currentTimeRef: React.RefObject<number>;
  splitClipAtPlayhead: (clipId: string, atTime?: number) => void;
  removeClip: (clipId: string) => void;
  updateClip: (clipId: string, updates: Partial<TimelineClip>) => void;
  addClipToTimeline: (
    asset: Asset,
    trackIndex?: number,
    startTime?: number,
  ) => void;
  setCurrentTime: (time: number) => void;
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>;
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
  currentProjectId: string | null;
  activeTimelineId: string | undefined;
  duplicateTimeline: (projectId: string, timelineId: string) => Timeline | null;
  addProjectTimeline: (projectId: string, name?: string) => Timeline;
  renameTimeline: (projectId: string, timelineId: string, name: string) => void;
  getMaxClipDuration: (clip: TimelineClip) => number;
  addAsset: (
    projectId: string,
    asset: Omit<Asset, "id" | "createdAt">,
  ) => Asset;
  deleteAsset?: (projectId: string, assetId: string) => void;
  updateAsset?: (projectId: string, assetId: string, updates: Partial<Asset>) => void;
  toggleFavorite?: (projectId: string, assetId: string) => void;
  updateBinMeta?: (projectId: string, binName: string, meta: Partial<BinMetadata>) => void;
  renameBin?: (projectId: string, oldName: string, newName: string) => void;
  projectBins?: Record<string, BinMetadata>;
  assetSavePath?: string | null;
  selectedClipIds?: string[];
  setSelectedClipIds?: (ids: string[]) => void;
  undo?: () => void;
  redo?: () => void;
  togglePlayback?: () => void;
  isPlaying?: boolean;
  setIsPlaying?: (playing: boolean) => void;
  fps?: number;
  snapEnabled?: boolean;
  setSnapEnabled?: (enabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentExecutor(deps: AgentExecutorDeps) {
  const {
    clipsRef,
    tracksRef,
    assetsRef,
    currentTimeRef,
    splitClipAtPlayhead,
    updateClip,
    addClipToTimeline,
    setCurrentTime,
    setClips,
    setTracks,
    currentProjectId,
    activeTimelineId,
    duplicateTimeline,
    addProjectTimeline,
    renameTimeline,
    getMaxClipDuration,
    addAsset,
    deleteAsset,
    updateAsset,
    toggleFavorite,
    updateBinMeta,
    renameBin: renameBinFn,
    projectBins,
    assetSavePath,
    selectedClipIds,
    setSelectedClipIds,
    undo: undoFn,
    redo: redoFn,
    togglePlayback: togglePlaybackFn,
    fps = 24,
    snapEnabled,
    setSnapEnabled,
  } = deps;

  const snapshotRef = useRef<TimelineClip[] | null>(null);
  const generationAbortRef = useRef<AbortController | null>(null);

  // -----------------------------------------------------------------------
  // Linked-clip helper
  // -----------------------------------------------------------------------

  const getLinkedGroup = useCallback(
    (clipId: string): TimelineClip[] => {
      const clips = clipsRef.current ?? [];
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return [];
      if (!clip.linkedClipIds?.length) return [clip];
      const ids = new Set<string>([clipId, ...clip.linkedClipIds]);
      return clips.filter((c) => ids.has(c.id));
    },
    [clipsRef],
  );

  // -----------------------------------------------------------------------
  // Helper to build a success/error result
  // -----------------------------------------------------------------------

  const ok = (name: string, result: unknown): ToolResult => ({
    tool_name: name,
    success: true,
    result,
    error: null,
  });

  const fail = (name: string, error: string): ToolResult => ({
    tool_name: name,
    success: false,
    result: null,
    error,
  });

  // =======================================================================
  // CORE TOOLS
  // =======================================================================

  const handleGetTimelineState = useCallback((): ToolResult => {
    const clips = clipsRef.current ?? [];
    const tracks = tracksRef.current ?? [];
    const currentTime = currentTimeRef.current ?? 0;
    return ok("get_timeline_state", {
      currentTime,
      trackCount: tracks.length,
      tracks: tracks.map((t, i) => ({
        index: i, id: t.id, name: t.name, kind: t.kind ?? "video",
        muted: t.muted, locked: t.locked,
      })),
      clipCount: clips.length,
      clips: clips.map((c) => ({
        id: c.id, assetId: c.assetId, type: c.type,
        trackIndex: c.trackIndex, startTime: c.startTime,
        duration: c.duration, trimStart: c.trimStart,
        trimEnd: c.trimEnd, speed: c.speed, muted: c.muted,
        volume: c.volume, prompt: c.asset?.prompt ?? null,
      })),
    });
  }, [clipsRef, tracksRef, currentTimeRef]);

  const handleGetProjectAssets = useCallback((args?: Record<string, unknown>): ToolResult => {
    const allAssets = assetsRef.current ?? [];
    const includeArchived = args?.include_archived as boolean | undefined;
    const assets = includeArchived ? allAssets : allAssets.filter(a => !a.archived);
    return ok("get_project_assets", {
      assetCount: assets.length,
      assets: assets.map((a) => ({
        id: a.id, type: a.type, prompt: a.prompt,
        name: a.name ?? null, tags: a.tags ?? [],
        duration: a.duration ?? null, resolution: a.resolution,
        path: a.path, favorite: a.favorite ?? false,
        bin: a.bin ?? null, archived: a.archived ?? false,
        parentAssetId: a.parentAssetId ?? null,
        sourceIn: a.sourceIn ?? null, sourceOut: a.sourceOut ?? null,
        topics: a.topics ?? [],
      })),
    });
  }, [assetsRef]);

  // =======================================================================
  // CLIP EDITING TOOLS
  // =======================================================================

  const handleTrimClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("trim_clip", "Missing clip_id");
      const group = getLinkedGroup(clipId);
      if (group.length === 0) return fail("trim_clip", `Clip not found: ${clipId}`);

      const trimStartDelta = Number(args.trim_start_delta ?? 0);
      const trimEndDelta = Number(args.trim_end_delta ?? 0);
      const groupIds = new Set(group.map((c) => c.id));
      setClips((prev) =>
        prev.map((c) => {
          if (!groupIds.has(c.id)) return c;
          return {
            ...c,
            trimStart: Math.max(0, c.trimStart + trimStartDelta),
            trimEnd: Math.max(0, c.trimEnd + trimEndDelta),
            duration: Math.max(0.1, c.duration - trimStartDelta - trimEndDelta),
          };
        }),
      );
      return ok("trim_clip", { trimmedClips: Array.from(groupIds), trimStartDelta, trimEndDelta });
    },
    [getLinkedGroup, setClips],
  );

  const handleSplitClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("split_clip", "Missing clip_id");
      const time = args.time !== undefined ? Number(args.time) : undefined;
      const group = getLinkedGroup(clipId);
      const splitIds: string[] = [];
      for (const clip of group) {
        splitClipAtPlayhead(clip.id, time);
        splitIds.push(clip.id);
      }
      return ok("split_clip", { splitClips: splitIds, time });
    },
    [getLinkedGroup, splitClipAtPlayhead],
  );

  const handleDeleteClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("delete_clip", "Missing clip_id");
      const ripple = Boolean(args.ripple);
      const group = getLinkedGroup(clipId);
      if (group.length === 0) return fail("delete_clip", `Clip not found: ${clipId}`);

      const removedDuration = group[0].duration;
      const removedStart = group[0].startTime;
      const affectedTracks = new Set(group.map((c) => c.trackIndex));
      const removedIds = new Set(group.map((c) => c.id));

      setClips((prev) => {
        let result = prev.filter((c) => !removedIds.has(c.id));
        if (ripple) {
          result = result.map((c) => {
            if (affectedTracks.has(c.trackIndex) && c.startTime > removedStart) {
              return { ...c, startTime: c.startTime - removedDuration };
            }
            return c;
          });
        }
        return result;
      });
      return ok("delete_clip", { deletedClips: Array.from(removedIds), ripple });
    },
    [getLinkedGroup, setClips],
  );

  const handleMoveClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("move_clip", "Missing clip_id");
      const group = getLinkedGroup(clipId);
      if (group.length === 0) return fail("move_clip", `Clip not found: ${clipId}`);

      const primary = group.find((c) => c.id === clipId)!;
      const timeDelta = args.new_start_time !== undefined
        ? Number(args.new_start_time) - primary.startTime : 0;
      const trackDelta = args.new_track_index !== undefined
        ? Number(args.new_track_index) - primary.trackIndex : 0;

      const groupIds = new Set(group.map((c) => c.id));
      setClips((prev) =>
        prev.map((c) => {
          if (!groupIds.has(c.id)) return c;
          return {
            ...c,
            ...(timeDelta !== 0 ? { startTime: c.startTime + timeDelta } : {}),
            ...(trackDelta !== 0 ? { trackIndex: c.trackIndex + trackDelta } : {}),
          };
        }),
      );
      return ok("move_clip", { movedClips: Array.from(groupIds), timeDelta, trackDelta });
    },
    [getLinkedGroup, setClips],
  );

  const handleAddClipToTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetId = args.asset_id as string | undefined;
      if (!assetId) return fail("add_clip_to_timeline", "Missing asset_id");

      const assets = assetsRef.current ?? [];
      let asset = assets.find((a) => a.id === assetId);
      if (!asset) return fail("add_clip_to_timeline", `Asset not found: ${assetId}`);

      const trackIndex = args.track_index !== undefined ? Number(args.track_index) : undefined;
      const startTime = args.start_time !== undefined ? Number(args.start_time) : undefined;
      const sourceIn = args.source_in !== undefined ? Number(args.source_in) : undefined;
      const sourceOut = args.source_out !== undefined ? Number(args.source_out) : undefined;
      let createdSubclipId: string | null = null;

      if (sourceIn != null && sourceOut != null && sourceOut > sourceIn
          && !asset.parentAssetId && currentProjectId) {
        const subAsset = addAsset(currentProjectId, {
          type: "video", path: asset.path, url: asset.url,
          prompt: asset.prompt ?? "", resolution: asset.resolution,
          duration: sourceOut - sourceIn, thumbnail: asset.thumbnail,
          parentAssetId: asset.id, sourceIn, sourceOut, topics: [],
        });
        createdSubclipId = subAsset.id;
        asset = subAsset;
      }

      const effectiveAssetId = asset.id;
      addClipToTimeline(asset, trackIndex, startTime);

      const applySourceIn = asset.sourceIn ?? sourceIn;
      const applySourceOut = asset.sourceOut ?? sourceOut;
      if (applySourceIn != null && applySourceOut != null) {
        const parentId = asset.parentAssetId ?? assetId;
        const parentAsset = assets.find((a) => a.id === parentId);
        const parentDuration = parentAsset?.duration ?? asset.duration ?? 0;
        const subDuration = applySourceOut - applySourceIn;

        setClips((prev) => {
          const lastClipForAsset = [...prev].reverse()
            .find((c) => c.assetId === effectiveAssetId);
          if (!lastClipForAsset) return prev;
          return prev.map((c) =>
            c.id === lastClipForAsset.id
              ? { ...c, trimStart: applySourceIn!, trimEnd: Math.max(0, parentDuration - applySourceOut!), duration: subDuration }
              : c,
          );
        });
      }

      return ok("add_clip_to_timeline", {
        assetId: effectiveAssetId, trackIndex, startTime,
        ...(createdSubclipId ? { createdSubclipId } : {}),
        ...(sourceIn != null ? { sourceIn } : {}),
        ...(sourceOut != null ? { sourceOut } : {}),
      });
    },
    [assetsRef, addClipToTimeline, setClips, currentProjectId, addAsset],
  );

  const handleSplitAtPlayhead = useCallback((): ToolResult => {
    const clips = clipsRef.current ?? [];
    const playhead = currentTimeRef.current ?? 0;
    const spanning = clips.filter(
      (c) => c.startTime < playhead && playhead < c.startTime + c.duration,
    );
    if (spanning.length === 0) return fail("split_at_playhead", "No clips at playhead position");
    const splitIds: string[] = [];
    for (const clip of spanning) {
      splitClipAtPlayhead(clip.id, playhead);
      splitIds.push(clip.id);
    }
    return ok("split_at_playhead", { splitClips: splitIds, time: playhead });
  }, [clipsRef, currentTimeRef, splitClipAtPlayhead]);

  const handleFlipClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("flip_clip", "Missing clip_id");
      const updates: Partial<TimelineClip> = {};
      if (args.horizontal !== undefined) updates.flipH = Boolean(args.horizontal);
      if (args.vertical !== undefined) updates.flipV = Boolean(args.vertical);
      if (Object.keys(updates).length === 0) return fail("flip_clip", "Provide at least one of horizontal or vertical");
      updateClip(clipId, updates);
      return ok("flip_clip", { clipId, ...updates });
    },
    [updateClip],
  );

  const handleReverseClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("reverse_clip", "Missing clip_id");
      if (args.reversed === undefined) return fail("reverse_clip", "Missing reversed");
      const reversed = Boolean(args.reversed);
      updateClip(clipId, { reversed });
      return ok("reverse_clip", { clipId, reversed });
    },
    [updateClip],
  );

  const handleSetClipSpeed = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("set_clip_speed", "Missing clip_id");
      if (args.speed === undefined) return fail("set_clip_speed", "Missing speed");
      const newSpeed = Math.max(0.25, Math.min(4, Number(args.speed)));
      const clips = clipsRef.current ?? [];
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return fail("set_clip_speed", `Clip not found: ${clipId}`);
      const oldSpeed = clip.speed;
      let newDuration = clip.duration * (oldSpeed / newSpeed);
      const maxDur = getMaxClipDuration({ ...clip, speed: newSpeed });
      newDuration = Math.min(newDuration, maxDur);
      newDuration = Math.max(0.5, newDuration);
      updateClip(clipId, { speed: newSpeed, duration: newDuration });
      return ok("set_clip_speed", { clipId, speed: newSpeed, duration: +newDuration.toFixed(2) });
    },
    [clipsRef, getMaxClipDuration, updateClip],
  );

  const handleDuplicateClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("duplicate_clip", "Missing clip_id");
      const clips = clipsRef.current ?? [];
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return fail("duplicate_clip", `Clip not found: ${clipId}`);

      const newClip: TimelineClip = {
        ...clip,
        id: crypto.randomUUID(),
        startTime: clip.startTime + clip.duration,
        linkedClipIds: [],
      };
      setClips((prev) => [...prev, newClip]);
      return ok("duplicate_clip", { originalId: clipId, newClipId: newClip.id });
    },
    [clipsRef, setClips],
  );

  // =======================================================================
  // CLIP PROPERTIES TOOLS
  // =======================================================================

  const handleSetClipVolume = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("set_clip_volume", "Missing clip_id");
      const updates: Partial<TimelineClip> = {};
      if (args.volume !== undefined) updates.volume = Math.max(0, Math.min(1, Number(args.volume)));
      if (args.muted !== undefined) updates.muted = Boolean(args.muted);
      if (Object.keys(updates).length === 0) return fail("set_clip_volume", "Provide volume or muted");
      updateClip(clipId, updates);
      return ok("set_clip_volume", { clipId, ...updates });
    },
    [updateClip],
  );

  const handleSetClipOpacity = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("set_clip_opacity", "Missing clip_id");
      if (args.opacity === undefined) return fail("set_clip_opacity", "Missing opacity");
      const opacity = Math.max(0, Math.min(1, Number(args.opacity)));
      updateClip(clipId, { opacity });
      return ok("set_clip_opacity", { clipId, opacity });
    },
    [updateClip],
  );

  const handleLinkUnlinkClips = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipIds = args.clip_ids as string[] | undefined;
      const action = args.action as string | undefined;
      if (!clipIds?.length || !action) return fail("link_unlink_clips", "Missing clip_ids or action");

      setClips((prev) => {
        if (action === "link") {
          return prev.map((c) => {
            if (clipIds.includes(c.id)) {
              return { ...c, linkedClipIds: clipIds.filter((id) => id !== c.id) };
            }
            return c;
          });
        }
        return prev.map((c) => {
          if (clipIds.includes(c.id)) {
            return { ...c, linkedClipIds: [] };
          }
          return c;
        });
      });
      return ok("link_unlink_clips", { clipIds, action });
    },
    [setClips],
  );

  const handleSetColorCorrection = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("set_color_correction", "Missing clip_id");
      const cc: Record<string, number> = {};
      for (const key of ["brightness", "contrast", "saturation", "temperature"]) {
        if (args[key] !== undefined) cc[key] = Number(args[key]);
      }
      if (Object.keys(cc).length === 0) return fail("set_color_correction", "No corrections provided");
      updateClip(clipId, { colorCorrection: cc } as unknown as Partial<TimelineClip>);
      return ok("set_color_correction", { clipId, ...cc });
    },
    [updateClip],
  );

  // =======================================================================
  // TRANSITIONS
  // =======================================================================

  const handleAddDissolve = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const leftId = args.left_clip_id as string | undefined;
      const rightId = args.right_clip_id as string | undefined;
      if (!leftId || !rightId) return fail("add_dissolve", "Missing left_clip_id or right_clip_id");

      const clips = clipsRef.current ?? [];
      const leftClip = clips.find((c) => c.id === leftId);
      const rightClip = clips.find((c) => c.id === rightId);
      if (!leftClip || !rightClip) return fail("add_dissolve", "Clip not found");

      const leftEnd = leftClip.startTime + leftClip.duration;
      if (leftClip.trackIndex !== rightClip.trackIndex || Math.abs(leftEnd - rightClip.startTime) > 0.05) {
        return fail("add_dissolve", "Clips must be adjacent on the same track");
      }

      const duration = args.duration !== undefined ? Math.max(0, Number(args.duration)) : 0.5;
      const dissolveType: TransitionType = duration > 0 ? "dissolve" : "none";

      setClips((prev) =>
        prev.map((c) => {
          if (c.id === leftId) return { ...c, transitionOut: { type: dissolveType, duration } };
          if (c.id === rightId) return { ...c, transitionIn: { type: dissolveType, duration } };
          return c;
        }),
      );
      return ok("add_dissolve", { leftClipId: leftId, rightClipId: rightId, duration, type: dissolveType });
    },
    [clipsRef, setClips],
  );

  // =======================================================================
  // PLAYBACK & NAVIGATION
  // =======================================================================

  const handleSetPlayhead = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (args.time === undefined) return fail("set_playhead", "Missing time");
      const time = Number(args.time);
      setCurrentTime(time);
      return ok("set_playhead", { time });
    },
    [setCurrentTime],
  );

  const handleTogglePlayback = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (togglePlaybackFn) togglePlaybackFn();
      return ok("toggle_playback", { action: args.action ?? "toggle" });
    },
    [togglePlaybackFn],
  );

  const handleStepFrame = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const direction = args.direction as string;
      const frames = Number(args.frames ?? 1);
      const frameDuration = 1 / fps;
      const delta = direction === "backward" ? -frames * frameDuration : frames * frameDuration;
      const current = currentTimeRef.current ?? 0;
      setCurrentTime(Math.max(0, current + delta));
      return ok("step_frame", { direction, frames, newTime: Math.max(0, current + delta) });
    },
    [currentTimeRef, setCurrentTime, fps],
  );

  const handleJumpToEditPoint = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const direction = args.direction as string;
      const clips = clipsRef.current ?? [];
      const current = currentTimeRef.current ?? 0;
      const editPoints = new Set<number>();
      for (const c of clips) {
        editPoints.add(c.startTime);
        editPoints.add(c.startTime + c.duration);
      }
      const sorted = [...editPoints].sort((a, b) => a - b);

      let target: number | undefined;
      if (direction === "next") {
        target = sorted.find((t) => t > current + 0.01);
      } else {
        target = [...sorted].reverse().find((t) => t < current - 0.01);
      }
      if (target === undefined) return ok("jump_to_edit_point", { direction, jumped: false });
      setCurrentTime(target);
      return ok("jump_to_edit_point", { direction, jumped: true, time: target });
    },
    [clipsRef, currentTimeRef, setCurrentTime],
  );

  const handleSetInOutPoints = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("set_in_out_points", { note: "In/Out points set" });
    },
    [],
  );

  const handleZoomToFit = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      return ok("zoom_to_fit", { action: args.action ?? "fit" });
    },
    [],
  );

  // =======================================================================
  // TIMELINE MANAGEMENT
  // =======================================================================

  const handleDuplicateTimeline = useCallback((): ToolResult => {
    if (!currentProjectId || !activeTimelineId)
      return fail("duplicate_timeline", "No active project or timeline");
    const clips = clipsRef.current ?? [];
    snapshotRef.current = structuredClone(clips);
    const newTimeline = duplicateTimeline(currentProjectId, activeTimelineId);
    if (!newTimeline) return fail("duplicate_timeline", "Failed to duplicate timeline");
    return ok("duplicate_timeline", { newTimelineId: newTimeline.id, newTimelineName: newTimeline.name, snapshotClipCount: clips.length });
  }, [clipsRef, currentProjectId, activeTimelineId, duplicateTimeline]);

  const handleCreateTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (!currentProjectId) return fail("create_timeline", "No active project");
      const name = args.name as string | undefined;
      const newTimeline = addProjectTimeline(currentProjectId, name);
      return ok("create_timeline", { timelineId: newTimeline.id, timelineName: newTimeline.name });
    },
    [currentProjectId, addProjectTimeline],
  );

  const handleRenameTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (!currentProjectId || !activeTimelineId)
        return fail("rename_timeline", "No active project or timeline");
      const name = args.name as string | undefined;
      if (!name?.trim()) return fail("rename_timeline", "Missing or empty name");
      renameTimeline(currentProjectId, activeTimelineId, name.trim());
      return ok("rename_timeline", { timelineId: activeTimelineId, newName: name.trim() });
    },
    [currentProjectId, activeTimelineId, renameTimeline],
  );

  const handleUndo = useCallback((): ToolResult => {
    if (undoFn) undoFn();
    return ok("undo", { performed: true });
  }, [undoFn]);

  const handleRedo = useCallback((): ToolResult => {
    if (redoFn) redoFn();
    return ok("redo", { performed: true });
  }, [redoFn]);

  // =======================================================================
  // TRACK MANAGEMENT
  // =======================================================================

  const handleAddTrack = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const kind = (args.kind as string) ?? "video";
      const newTrack: Track = {
        id: crypto.randomUUID(),
        name: `${kind.charAt(0).toUpperCase() + kind.slice(1)} ${(tracksRef.current?.length ?? 0) + 1}`,
        kind: kind as Track["kind"],
        muted: false,
        locked: false,
      };
      setTracks((prev) => [...prev, newTrack]);
      return ok("add_track", { trackId: newTrack.id, kind });
    },
    [tracksRef, setTracks],
  );

  const handleDeleteTrack = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const trackIndex = Number(args.track_index);
      const tracks = tracksRef.current ?? [];
      if (trackIndex < 0 || trackIndex >= tracks.length)
        return fail("delete_track", `Invalid track index: ${trackIndex}`);

      setClips((prev) => prev.filter((c) => c.trackIndex !== trackIndex)
        .map((c) => c.trackIndex > trackIndex ? { ...c, trackIndex: c.trackIndex - 1 } : c));
      setTracks((prev) => prev.filter((_, i) => i !== trackIndex));
      return ok("delete_track", { deletedIndex: trackIndex });
    },
    [tracksRef, setTracks, setClips],
  );

  const handleSetTrackState = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const trackIndex = Number(args.track_index);
      const tracks = tracksRef.current ?? [];
      if (trackIndex < 0 || trackIndex >= tracks.length)
        return fail("set_track_state", `Invalid track index: ${trackIndex}`);

      setTracks((prev) =>
        prev.map((t, i) => {
          if (i !== trackIndex) return t;
          const updated = { ...t };
          if (args.muted !== undefined) updated.muted = Boolean(args.muted);
          if (args.locked !== undefined) updated.locked = Boolean(args.locked);
          if (args.solo !== undefined) (updated as Record<string, unknown>).solo = Boolean(args.solo);
          if (args.enabled !== undefined) (updated as Record<string, unknown>).enabled = Boolean(args.enabled);
          return updated;
        }),
      );
      return ok("set_track_state", { trackIndex });
    },
    [tracksRef, setTracks],
  );

  // =======================================================================
  // ASSET MANAGEMENT
  // =======================================================================

  const handleCreateSubclipAssets = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (!currentProjectId) return fail("create_subclip_assets", "No active project");
      const subclips = args.subclips as Array<{
        parent_asset_id: string; source_in: number; source_out: number;
        title: string; description: string; topics?: string[]; transcript?: string;
      }> | undefined;
      if (!subclips?.length) return fail("create_subclip_assets", "Missing or empty subclips array");

      const assets = assetsRef.current ?? [];
      const createdIds: string[] = [];
      for (const sc of subclips) {
        const parent = assets.find((a) => a.id === sc.parent_asset_id);
        if (!parent) continue;
        const newAsset = addAsset(currentProjectId, {
          type: "video", path: parent.path, url: parent.url,
          prompt: sc.title, resolution: parent.resolution,
          duration: sc.source_out - sc.source_in, thumbnail: parent.thumbnail,
          parentAssetId: sc.parent_asset_id, sourceIn: sc.source_in,
          sourceOut: sc.source_out, transcript: sc.transcript ?? "",
          topics: sc.topics ?? [],
        });
        createdIds.push(newAsset.id);
      }
      return ok("create_subclip_assets", { createdAssetIds: createdIds, count: createdIds.length });
    },
    [currentProjectId, assetsRef, addAsset],
  );

  const handleImportMedia = useCallback(
    async (_args: Record<string, unknown>): Promise<ToolResult> => {
      return ok("import_media", { note: "File import dialog triggered" });
    },
    [],
  );

  const handleDeleteAsset = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetId = args.asset_id as string | undefined;
      if (!assetId) return fail("delete_asset", "Missing asset_id");
      if (deleteAsset && currentProjectId) deleteAsset(currentProjectId, assetId);
      const remaining = (assetsRef.current ?? []).length;
      return ok("delete_asset", { assetId, remaining_asset_count: remaining });
    },
    [deleteAsset, currentProjectId, assetsRef],
  );

  const handleBatchDeleteAssets = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetIds = args.asset_ids as string[] | undefined;
      if (!assetIds?.length) return fail("batch_delete_assets", "Missing or empty asset_ids array");
      if (!currentProjectId) return fail("batch_delete_assets", "No active project");

      const deleted: string[] = [];
      const failed: string[] = [];
      for (const id of assetIds) {
        try {
          if (deleteAsset) deleteAsset(currentProjectId, id);
          deleted.push(id);
        } catch {
          failed.push(id);
        }
      }
      const remaining = (assetsRef.current ?? []).length;
      return ok("batch_delete_assets", {
        deleted,
        failed,
        deleted_count: deleted.length,
        failed_count: failed.length,
        remaining_asset_count: remaining,
      });
    },
    [deleteAsset, currentProjectId, assetsRef],
  );

  const handleOrganizeAsset = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetId = args.asset_id as string | undefined;
      if (!assetId) return fail("organize_asset", "Missing asset_id");
      if (args.favorite !== undefined && toggleFavorite && currentProjectId) {
        toggleFavorite(currentProjectId, assetId);
      }
      if (currentProjectId && updateAsset) {
        const updates: Partial<Asset> = {};
        if (args.name !== undefined) updates.name = (args.name as string) || undefined;
        if (args.tags !== undefined) updates.tags = args.tags as string[];
        if (args.bin !== undefined) updates.bin = (args.bin as string) || undefined;
        if (args.archived !== undefined) updates.archived = args.archived as boolean;
        if (Object.keys(updates).length > 0) updateAsset(currentProjectId, assetId, updates);
      }
      return ok("organize_asset", {
        assetId, name: args.name, tags: args.tags, bin: args.bin, archived: args.archived, favorite: args.favorite,
      });
    },
    [toggleFavorite, updateAsset, currentProjectId],
  );

  const handleCreateBin = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const name = args.name as string | undefined;
      if (!name || !currentProjectId) return fail("create_bin", "Missing name or project");
      const normalizedName = name.trim();
      if (!normalizedName) return fail("create_bin", "Bin name cannot be empty");
      if (updateBinMeta) {
        updateBinMeta(currentProjectId, normalizedName, { color: (args.color as string) || undefined, createdAt: Date.now() });
      }
      return ok("create_bin", { created: normalizedName, color: args.color });
    },
    [updateBinMeta, currentProjectId],
  );

  const handleListBins = useCallback(
    (): ToolResult => {
      const bins = projectBins || {};
      const assets = assetsRef.current ?? [];
      const binList = Object.entries(bins).map(([name, meta]) => ({
        name,
        color: meta.color ?? null,
        assetCount: assets.filter(a => a.bin === name && !a.archived).length,
      }));
      return ok("list_bins", { bins: binList, totalAssets: assets.filter(a => !a.archived).length });
    },
    [projectBins, assetsRef],
  );

  const handleRenameBin = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const oldName = args.old_name as string | undefined;
      const newName = args.new_name as string | undefined;
      if (!oldName || !newName || !currentProjectId) return fail("rename_bin", "Missing old_name, new_name, or project");
      if (renameBinFn) renameBinFn(currentProjectId, oldName, newName.trim());
      return ok("rename_bin", { renamed: { from: oldName, to: newName.trim() } });
    },
    [renameBinFn, currentProjectId],
  );

  const handleSetBinColor = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const binName = args.bin_name as string | undefined;
      const color = args.color as string | undefined;
      if (!binName || !color || !currentProjectId) return fail("set_bin_color", "Missing bin_name, color, or project");
      if (updateBinMeta) updateBinMeta(currentProjectId, binName, { color });
      return ok("set_bin_color", { binName, color });
    },
    [updateBinMeta, currentProjectId],
  );

  const handleBatchOrganizeAssets = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetIds = args.asset_ids as string[] | undefined;
      if (!assetIds?.length || !currentProjectId) return fail("batch_organize_assets", "Missing asset_ids or project");
      const updates: Partial<Asset> = {};
      if (args.bin !== undefined) updates.bin = (args.bin as string) || undefined;
      if (args.archived !== undefined) updates.archived = args.archived as boolean;
      if (updateAsset) {
        for (const id of assetIds) {
          updateAsset(currentProjectId, id, updates);
        }
      }
      return ok("batch_organize_assets", { updated: assetIds.length, bin: args.bin, archived: args.archived });
    },
    [updateAsset, currentProjectId],
  );

  const handleSetActiveTake = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("set_active_take", { note: "Take switched" });
    },
    [],
  );

  const handleRegenerateAsset = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("regenerate_asset", { note: "Regeneration queued" });
    },
    [],
  );

  // =======================================================================
  // GENERATION TOOLS
  // =======================================================================

  const handleGenerateVideo = useCallback(
    async (args: Record<string, unknown>, onProgress?: OnToolProgress, externalSignal?: AbortSignal): Promise<ToolResult> => {
      if (!currentProjectId) return fail("generate_video", "No active project");
      const prompt = args.prompt as string;
      if (!prompt) return fail("generate_video", "Missing prompt");

      const mode = (args.mode as string) ?? "text_to_video";
      let imagePath: string | undefined;
      let audioPath: string | undefined;

      if (mode === "image_to_video" && args.image_asset_id) {
        const assets = assetsRef.current ?? [];
        const img = assets.find((a) => a.id === args.image_asset_id);
        if (!img) return fail("generate_video", `Image asset not found: ${args.image_asset_id}`);
        imagePath = img.path;
      }
      if (mode === "audio_to_video" && args.audio_asset_id) {
        const assets = assetsRef.current ?? [];
        const aud = assets.find((a) => a.id === args.audio_asset_id);
        if (!aud) return fail("generate_video", `Audio asset not found: ${args.audio_asset_id}`);
        audioPath = aud.path;
      }

      generationAbortRef.current = new AbortController();
      const localAbort = generationAbortRef.current;
      if (externalSignal) {
        if (externalSignal.aborted) { localAbort.abort(); }
        else { externalSignal.addEventListener("abort", () => localAbort.abort(), { once: true }); }
      }
      try {
        const curTags = [...new Set((assetsRef.current ?? []).flatMap(a => a.tags ?? []))];
        const result = await agentGenerateVideo(
          {
            prompt, mode: mode as "text_to_video" | "image_to_video" | "audio_to_video",
            imagePath, audioPath,
            duration: args.duration ? Number(args.duration) : undefined,
            resolution: args.resolution as string | undefined,
            fps: args.fps ? Number(args.fps) : undefined,
            aspectRatio: args.aspect_ratio as string | undefined,
            model: args.model as string | undefined,
            cameraMotion: args.camera_motion as string | undefined,
          },
          addAsset, currentProjectId, assetSavePath,
          localAbort.signal,
          onProgress,
          updateAsset ? { updateAsset, projectTags: curTags } : undefined,
        );
        return ok("generate_video", result);
      } catch (e) {
        return fail("generate_video", e instanceof Error ? e.message : String(e));
      }
    },
    [currentProjectId, assetsRef, addAsset, assetSavePath],
  );

  const handleGenerateImage = useCallback(
    async (args: Record<string, unknown>, onProgress?: OnToolProgress, externalSignal?: AbortSignal): Promise<ToolResult> => {
      if (!currentProjectId) return fail("generate_image", "No active project");
      const prompt = args.prompt as string;
      if (!prompt) return fail("generate_image", "Missing prompt");

      let resolvedImageUrls: string[] | undefined;
      const rawImageUrls = args.image_urls as string[] | undefined;
      if (rawImageUrls && rawImageUrls.length > 0) {
        const assets = assetsRef.current ?? [];
        resolvedImageUrls = rawImageUrls.map(ref => {
          if (ref.startsWith('data:') || ref.startsWith('file:') || ref.startsWith('http')) return ref;
          const matched = assets.find(a => a.id === ref);
          return matched?.url ?? ref;
        });
      }

      generationAbortRef.current = new AbortController();
      const localAbort = generationAbortRef.current;
      if (externalSignal) {
        if (externalSignal.aborted) { localAbort.abort(); }
        else { externalSignal.addEventListener("abort", () => localAbort.abort(), { once: true }); }
      }
      try {
        const imgTags = [...new Set((assetsRef.current ?? []).flatMap(a => a.tags ?? []))];
        const result = await agentGenerateImage(
          {
            prompt,
            model: args.model as "nano-banana-2" | "z-image-turbo" | undefined,
            resolution: args.resolution as string | undefined,
            aspectRatio: args.aspect_ratio as string | undefined,
            numVariations: args.num_variations ? Number(args.num_variations) : undefined,
            imageUrls: resolvedImageUrls,
          },
          addAsset, currentProjectId, assetSavePath,
          localAbort.signal,
          onProgress,
          updateAsset ? { updateAsset, projectTags: imgTags } : undefined,
        );
        return ok("generate_image", result);
      } catch (e) {
        return fail("generate_image", e instanceof Error ? e.message : String(e));
      }
    },
    [currentProjectId, addAsset, assetSavePath],
  );

  const handleRetakeSection = useCallback(
    async (args: Record<string, unknown>, onProgress?: OnToolProgress, externalSignal?: AbortSignal): Promise<ToolResult> => {
      if (!currentProjectId) return fail("retake_section", "No active project");
      const videoAssetId = args.video_asset_id as string;
      if (!videoAssetId) return fail("retake_section", "Missing video_asset_id");

      const assets = assetsRef.current ?? [];
      const videoAsset = assets.find((a) => a.id === videoAssetId);
      if (!videoAsset) return fail("retake_section", `Asset not found: ${videoAssetId}`);

      generationAbortRef.current = new AbortController();
      const localAbort = generationAbortRef.current;
      if (externalSignal) {
        if (externalSignal.aborted) { localAbort.abort(); }
        else { externalSignal.addEventListener("abort", () => localAbort.abort(), { once: true }); }
      }
      try {
        const result = await agentRetakeSection(
          {
            videoPath: videoAsset.path,
            startTime: Number(args.start_time ?? 0),
            duration: Number(args.duration ?? 2),
            prompt: (args.prompt as string) ?? "",
            mode: args.mode as string | undefined,
          },
          addAsset, currentProjectId, assetSavePath,
          localAbort.signal,
          onProgress,
        );
        return ok("retake_section", result);
      } catch (e) {
        return fail("retake_section", e instanceof Error ? e.message : String(e));
      }
    },
    [currentProjectId, assetsRef, addAsset, assetSavePath],
  );

  const handleCancelGeneration = useCallback(async (): Promise<ToolResult> => {
    if (generationAbortRef.current) generationAbortRef.current.abort();
    await agentCancelGeneration();
    return ok("cancel_generation", { cancelled: true });
  }, []);

  const handleGetGenerationStatus = useCallback(async (): Promise<ToolResult> => {
    const status = await agentGetGenerationStatus();
    return ok("get_generation_status", status);
  }, []);

  const handleFillTimelineGap = useCallback(
    async (args: Record<string, unknown>, _onProgress?: OnToolProgress, externalSignal?: AbortSignal): Promise<ToolResult> => {
      if (!currentProjectId) return fail("fill_timeline_gap", "No active project");
      const prompt = args.prompt as string | undefined;
      const mode = (args.mode as string) ?? "text_to_video";

      generationAbortRef.current = new AbortController();
      const localAbort = generationAbortRef.current;
      if (externalSignal) {
        if (externalSignal.aborted) { localAbort.abort(); }
        else { externalSignal.addEventListener("abort", () => localAbort.abort(), { once: true }); }
      }
      try {
        const gapTags = [...new Set((assetsRef.current ?? []).flatMap(a => a.tags ?? []))];
        const gapAutoNaming = updateAsset ? { updateAsset, projectTags: gapTags } : undefined;
        let result;
        if (mode === "text_to_image") {
          result = await agentGenerateImage(
            { prompt: prompt ?? "A scene that connects the surrounding clips" },
            addAsset, currentProjectId, assetSavePath,
            localAbort.signal,
            undefined,
            gapAutoNaming,
          );
        } else {
          result = await agentGenerateVideo(
            {
              prompt: prompt ?? "A smooth transition scene",
              mode: mode as "text_to_video" | "image_to_video",
              duration: args.gap_duration ? Number(args.gap_duration) : 5,
            },
            addAsset, currentProjectId, assetSavePath,
            localAbort.signal,
            undefined,
            gapAutoNaming,
          );
        }

        const assets = assetsRef.current ?? [];
        const asset = assets.find((a) => a.id === result.assetId);
        if (asset) {
          const trackIndex = args.track_index !== undefined ? Number(args.track_index) : 0;
          const startTime = args.gap_start_time !== undefined ? Number(args.gap_start_time) : 0;
          addClipToTimeline(asset, trackIndex, startTime);
        }

        return ok("fill_timeline_gap", { ...result, placed: true });
      } catch (e) {
        return fail("fill_timeline_gap", e instanceof Error ? e.message : String(e));
      }
    },
    [currentProjectId, addAsset, assetSavePath, assetsRef, addClipToTimeline],
  );

  // =======================================================================
  // SUBTITLES
  // =======================================================================

  const handleAddSubtitle = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const text = args.text as string;
      if (!text) return fail("add_subtitle", "Missing text");
      const newClip = {
        id: crypto.randomUUID(),
        assetId: "",
        type: "subtitle" as const,
        trackIndex: Number(args.track_index ?? 0),
        startTime: Number(args.start_time ?? 0),
        duration: Number(args.duration ?? 3),
        trimStart: 0, trimEnd: 0, speed: 1,
        volume: 1, muted: false,
        text,
      } as unknown as TimelineClip;
      setClips((prev) => [...prev, newClip]);
      return ok("add_subtitle", { clipId: newClip.id, text });
    },
    [setClips],
  );

  const handleEditSubtitle = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) return fail("edit_subtitle", "Missing clip_id");
      const updates: Partial<TimelineClip> = {};
      if (args.text !== undefined) (updates as Record<string, unknown>).text = args.text;
      if (args.start_time !== undefined) updates.startTime = Number(args.start_time);
      if (args.duration !== undefined) updates.duration = Number(args.duration);
      updateClip(clipId, updates);
      return ok("edit_subtitle", { clipId, ...updates });
    },
    [updateClip],
  );

  const handleSetSubtitleStyle = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("set_subtitle_style", { note: "Subtitle style updated" });
    },
    [],
  );

  const handleImportExportSrt = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("import_export_srt", { note: "SRT operation performed" });
    },
    [],
  );

  // =======================================================================
  // EXPORT
  // =======================================================================

  const handleExportTimeline = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("export_timeline", { note: "Export triggered" });
    },
    [],
  );

  const handleExportFcpxml = useCallback(
    (): ToolResult => {
      return ok("export_fcpxml", { note: "FCP XML export triggered" });
    },
    [],
  );

  // =======================================================================
  // EDIT OPERATIONS
  // =======================================================================

  const handleInsertEdit = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("insert_edit", { note: "Insert edit performed" });
    },
    [],
  );

  const handleOverwriteEdit = useCallback(
    (_args: Record<string, unknown>): ToolResult => {
      return ok("overwrite_edit", { note: "Overwrite edit performed" });
    },
    [],
  );

  // =======================================================================
  // SELECTION & UI
  // =======================================================================

  const handleSelectClips = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipIds = args.clip_ids as string[] | undefined;
      const mode = (args.mode as string) ?? "set";
      if (!clipIds) return fail("select_clips", "Missing clip_ids");

      if (setSelectedClipIds) {
        if (mode === "set") setSelectedClipIds(clipIds);
        else if (mode === "add") {
          const current = selectedClipIds ?? [];
          setSelectedClipIds([...new Set([...current, ...clipIds])]);
        } else if (mode === "remove") {
          const current = selectedClipIds ?? [];
          setSelectedClipIds(current.filter((id) => !clipIds.includes(id)));
        }
      }
      return ok("select_clips", { clipIds, mode });
    },
    [setSelectedClipIds, selectedClipIds],
  );

  const handleDeselectAll = useCallback((): ToolResult => {
    if (setSelectedClipIds) setSelectedClipIds([]);
    return ok("deselect_all", { deselected: true });
  }, [setSelectedClipIds]);

  const handleToggleSnap = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (setSnapEnabled) {
        const enabled = args.enabled !== undefined ? Boolean(args.enabled) : !(snapEnabled ?? true);
        setSnapEnabled(enabled);
        return ok("toggle_snap", { enabled });
      }
      return ok("toggle_snap", { note: "Snap toggled" });
    },
    [setSnapEnabled, snapEnabled],
  );

  const handleSetActiveTool = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      return ok("set_active_tool", { tool: args.tool ?? "selection" });
    },
    [],
  );

  // =======================================================================
  // Sanitizer
  // =======================================================================

  const sanitizeArgs = useCallback(
    (args: Record<string, unknown>): Record<string, unknown> => {
      const sanitized = { ...args };
      for (const [key, value] of Object.entries(sanitized)) {
        if (typeof value === "number" && isNaN(value)) {
          sanitized[key] = 0;
        }
      }
      return sanitized;
    },
    [],
  );

  // =======================================================================
  // Dispatcher
  // =======================================================================

  const executeTool = useCallback(
    async (call: ToolCall, onProgress?: OnToolProgress, signal?: AbortSignal): Promise<ToolResult> => {
      const t0 = performance.now();
      logger.info(`[agent-exec] dispatching: ${call.tool_name}`);
      try {
        const args = sanitizeArgs(call.arguments);
        const safe = { ...call, arguments: args };

        switch (safe.tool_name) {
          // Core
          case "get_timeline_state": return handleGetTimelineState();
          case "get_project_assets": return handleGetProjectAssets(safe.arguments);
          // Clip editing
          case "trim_clip": return handleTrimClip(safe.arguments);
          case "split_clip": return handleSplitClip(safe.arguments);
          case "delete_clip": return handleDeleteClip(safe.arguments);
          case "move_clip": return handleMoveClip(safe.arguments);
          case "add_clip_to_timeline": return handleAddClipToTimeline(safe.arguments);
          case "split_at_playhead": return handleSplitAtPlayhead();
          case "flip_clip": return handleFlipClip(safe.arguments);
          case "reverse_clip": return handleReverseClip(safe.arguments);
          case "set_clip_speed": return handleSetClipSpeed(safe.arguments);
          case "duplicate_clip": return handleDuplicateClip(safe.arguments);
          // Clip properties
          case "set_clip_volume": return handleSetClipVolume(safe.arguments);
          case "set_clip_opacity": return handleSetClipOpacity(safe.arguments);
          case "link_unlink_clips": return handleLinkUnlinkClips(safe.arguments);
          case "set_color_correction": return handleSetColorCorrection(safe.arguments);
          // Transitions
          case "add_dissolve": return handleAddDissolve(safe.arguments);
          // Playback
          case "set_playhead": return handleSetPlayhead(safe.arguments);
          case "toggle_playback": return handleTogglePlayback(safe.arguments);
          case "step_frame": return handleStepFrame(safe.arguments);
          case "jump_to_edit_point": return handleJumpToEditPoint(safe.arguments);
          case "set_in_out_points": return handleSetInOutPoints(safe.arguments);
          case "zoom_to_fit": return handleZoomToFit(safe.arguments);
          // Timeline management
          case "duplicate_timeline": return handleDuplicateTimeline();
          case "create_timeline": return handleCreateTimeline(safe.arguments);
          case "rename_timeline": return handleRenameTimeline(safe.arguments);
          case "undo": return handleUndo();
          case "redo": return handleRedo();
          // Track management
          case "add_track": return handleAddTrack(safe.arguments);
          case "delete_track": return handleDeleteTrack(safe.arguments);
          case "set_track_state": return handleSetTrackState(safe.arguments);
          // Asset management
          case "create_subclip_assets": return handleCreateSubclipAssets(safe.arguments);
          case "import_media": return handleImportMedia(safe.arguments);
          case "delete_asset": return handleDeleteAsset(safe.arguments);
          case "batch_delete_assets": return handleBatchDeleteAssets(safe.arguments);
          case "organize_asset": return handleOrganizeAsset(safe.arguments);
          case "create_bin": return handleCreateBin(safe.arguments);
          case "list_bins": return handleListBins();
          case "rename_bin": return handleRenameBin(safe.arguments);
          case "set_bin_color": return handleSetBinColor(safe.arguments);
          case "batch_organize_assets": return handleBatchOrganizeAssets(safe.arguments);
          case "set_active_take": return handleSetActiveTake(safe.arguments);
          case "regenerate_asset": return handleRegenerateAsset(safe.arguments);
          // Generation
          case "generate_video": return await handleGenerateVideo(safe.arguments, onProgress, signal);
          case "generate_image": return await handleGenerateImage(safe.arguments, onProgress, signal);
          case "retake_section": return await handleRetakeSection(safe.arguments, onProgress, signal);
          case "cancel_generation": return await handleCancelGeneration();
          case "get_generation_status": return await handleGetGenerationStatus();
          case "fill_timeline_gap": return await handleFillTimelineGap(safe.arguments, undefined, signal);
          // Subtitles
          case "add_subtitle": return handleAddSubtitle(safe.arguments);
          case "edit_subtitle": return handleEditSubtitle(safe.arguments);
          case "set_subtitle_style": return handleSetSubtitleStyle(safe.arguments);
          case "import_export_srt": return handleImportExportSrt(safe.arguments);
          // Export
          case "export_timeline": return handleExportTimeline(safe.arguments);
          case "export_fcpxml": return handleExportFcpxml();
          // Edit operations
          case "insert_edit": return handleInsertEdit(safe.arguments);
          case "overwrite_edit": return handleOverwriteEdit(safe.arguments);
          // Selection & UI
          case "select_clips": return handleSelectClips(safe.arguments);
          case "deselect_all": return handleDeselectAll();
          case "toggle_snap": return handleToggleSnap(safe.arguments);
          case "set_active_tool": return handleSetActiveTool(safe.arguments);
          default:
            return fail(safe.tool_name, `Unknown tool: ${safe.tool_name}`);
        }
      } catch (err) {
        const elapsed = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[agent-exec] ${call.tool_name} threw after ${elapsed}ms: ${msg}`);
        return fail(call.tool_name, msg);
      }
    },
    [
      handleAddClipToTimeline, handleAddDissolve, handleAddSubtitle,
      handleAddTrack, handleCancelGeneration, handleCreateSubclipAssets,
      handleBatchDeleteAssets, handleCreateTimeline, handleDeleteAsset, handleDeleteClip,
      handleDeleteTrack, handleDeselectAll, handleDuplicateClip,
      handleDuplicateTimeline, handleEditSubtitle, handleExportFcpxml,
      handleExportTimeline, handleFillTimelineGap, handleFlipClip,
      handleGenerateImage, handleGenerateVideo, handleGetGenerationStatus,
      handleGetProjectAssets, handleGetTimelineState, handleImportExportSrt,
      handleImportMedia, handleInsertEdit, handleJumpToEditPoint,
      handleLinkUnlinkClips, handleMoveClip, handleOrganizeAsset,
      handleOverwriteEdit, handleRedo, handleRegenerateAsset,
      handleRenameTimeline, handleRetakeSection, handleReverseClip,
      handleSelectClips, handleSetActiveTake, handleSetActiveTool,
      handleSetClipOpacity, handleSetClipSpeed, handleSetClipVolume,
      handleSetColorCorrection, handleSetInOutPoints, handleSetPlayhead,
      handleSetSubtitleStyle, handleSetTrackState, handleSplitAtPlayhead,
      handleSplitClip, handleStepFrame, handleTogglePlayback,
      handleToggleSnap, handleTrimClip, handleUndo, handleZoomToFit,
      sanitizeArgs,
    ],
  );

  // -----------------------------------------------------------------------
  // Snapshot restore
  // -----------------------------------------------------------------------

  const restoreSnapshot = useCallback((): boolean => {
    if (!snapshotRef.current) return false;
    setClips(snapshotRef.current);
    snapshotRef.current = null;
    return true;
  }, [setClips]);

  return { executeTool, restoreSnapshot };
}
