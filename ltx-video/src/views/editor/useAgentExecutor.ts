import { useCallback, useRef } from "react";
import type {
  TimelineClip,
  Track,
  Asset,
  Timeline,
  TransitionType,
} from "../../types/project";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCall {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_name: string;
  success: boolean;
  result: unknown;
  error: string | null;
}

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
  currentProjectId: string | null;
  activeTimelineId: string | undefined;
  duplicateTimeline: (projectId: string, timelineId: string) => Timeline | null;
  addProjectTimeline: (projectId: string, name?: string) => Timeline;
  renameTimeline: (projectId: string, timelineId: string, name: string) => void;
  getMaxClipDuration: (clip: TimelineClip) => number;
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
    currentProjectId,
    activeTimelineId,
    duplicateTimeline,
    addProjectTimeline,
    renameTimeline,
    getMaxClipDuration,
  } = deps;

  const snapshotRef = useRef<TimelineClip[] | null>(null);

  // -----------------------------------------------------------------------
  // Linked-clip helper: collect the target clip + all linked siblings
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
  // Tool handlers
  // -----------------------------------------------------------------------

  const handleGetTimelineState = useCallback((): ToolResult => {
    const clips = clipsRef.current ?? [];
    const tracks = tracksRef.current ?? [];
    const currentTime = currentTimeRef.current ?? 0;

    return {
      tool_name: "get_timeline_state",
      success: true,
      result: {
        currentTime,
        trackCount: tracks.length,
        tracks: tracks.map((t, i) => ({
          index: i,
          id: t.id,
          name: t.name,
          kind: t.kind ?? "video",
          muted: t.muted,
          locked: t.locked,
        })),
        clipCount: clips.length,
        clips: clips.map((c) => ({
          id: c.id,
          assetId: c.assetId,
          type: c.type,
          trackIndex: c.trackIndex,
          startTime: c.startTime,
          duration: c.duration,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
          speed: c.speed,
          muted: c.muted,
          volume: c.volume,
          prompt: c.asset?.prompt ?? null,
        })),
      },
      error: null,
    };
  }, [clipsRef, tracksRef, currentTimeRef]);

  const handleTrimClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "trim_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }

      const group = getLinkedGroup(clipId);
      if (group.length === 0) {
        return {
          tool_name: "trim_clip",
          success: false,
          result: null,
          error: `Clip not found: ${clipId}`,
        };
      }

      // Apply relative deltas (matching tool_registry.py definition)
      const trimStartDelta = Number(args.trim_start_delta ?? 0);
      const trimEndDelta = Number(args.trim_end_delta ?? 0);

      // Batch-update all linked clips in a single setClips call to avoid
      // stale-closure overwrites (updateClip uses closure state, not prev).
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

      return {
        tool_name: "trim_clip",
        success: true,
        result: {
          trimmedClips: Array.from(groupIds),
          trimStartDelta,
          trimEndDelta,
        },
        error: null,
      };
    },
    [getLinkedGroup, setClips],
  );

  const handleSplitClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "split_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }

      const time = args.time !== undefined ? Number(args.time) : undefined;
      const group = getLinkedGroup(clipId);

      // Split all linked clips at the same time
      const splitIds: string[] = [];
      for (const clip of group) {
        splitClipAtPlayhead(clip.id, time);
        splitIds.push(clip.id);
      }

      return {
        tool_name: "split_clip",
        success: true,
        result: { splitClips: splitIds, time },
        error: null,
      };
    },
    [getLinkedGroup, splitClipAtPlayhead],
  );

  const handleDeleteClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "delete_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }

      const ripple = Boolean(args.ripple);
      const group = getLinkedGroup(clipId);

      if (group.length === 0) {
        return {
          tool_name: "delete_clip",
          success: false,
          result: null,
          error: `Clip not found: ${clipId}`,
        };
      }

      const removedDuration = group[0].duration;
      const removedStart = group[0].startTime;
      const affectedTracks = new Set(group.map((c) => c.trackIndex));
      const removedIds = new Set(group.map((c) => c.id));

      setClips((prev) => {
        let result = prev.filter((c) => !removedIds.has(c.id));
        if (ripple) {
          result = result.map((c) => {
            if (
              affectedTracks.has(c.trackIndex) &&
              c.startTime > removedStart
            ) {
              return { ...c, startTime: c.startTime - removedDuration };
            }
            return c;
          });
        }
        return result;
      });

      return {
        tool_name: "delete_clip",
        success: true,
        result: { deletedClips: Array.from(removedIds), ripple },
        error: null,
      };
    },
    [getLinkedGroup, setClips],
  );

  const handleMoveClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "move_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }

      const group = getLinkedGroup(clipId);
      if (group.length === 0) {
        return {
          tool_name: "move_clip",
          success: false,
          result: null,
          error: `Clip not found: ${clipId}`,
        };
      }

      const primary = group.find((c) => c.id === clipId)!;
      const timeDelta =
        args.new_start_time !== undefined
          ? Number(args.new_start_time) - primary.startTime
          : 0;
      const trackDelta =
        args.new_track_index !== undefined
          ? Number(args.new_track_index) - primary.trackIndex
          : 0;

      // Batch-update all linked clips in a single setClips call to avoid
      // stale-closure overwrites (updateClip uses closure state, not prev).
      const groupIds = new Set(group.map((c) => c.id));
      setClips((prev) =>
        prev.map((c) => {
          if (!groupIds.has(c.id)) return c;
          return {
            ...c,
            ...(timeDelta !== 0 ? { startTime: c.startTime + timeDelta } : {}),
            ...(trackDelta !== 0
              ? { trackIndex: c.trackIndex + trackDelta }
              : {}),
          };
        }),
      );

      return {
        tool_name: "move_clip",
        success: true,
        result: { movedClips: Array.from(groupIds), timeDelta, trackDelta },
        error: null,
      };
    },
    [getLinkedGroup, setClips],
  );

  const handleAddClipToTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const assetId = args.asset_id as string | undefined;
      if (!assetId) {
        return {
          tool_name: "add_clip_to_timeline",
          success: false,
          result: null,
          error: "Missing asset_id",
        };
      }

      const assets = assetsRef.current ?? [];
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) {
        return {
          tool_name: "add_clip_to_timeline",
          success: false,
          result: null,
          error: `Asset not found: ${assetId}`,
        };
      }

      const trackIndex =
        args.track_index !== undefined ? Number(args.track_index) : undefined;
      const startTime =
        args.start_time !== undefined ? Number(args.start_time) : undefined;

      addClipToTimeline(asset, trackIndex, startTime);

      return {
        tool_name: "add_clip_to_timeline",
        success: true,
        result: { assetId, trackIndex, startTime },
        error: null,
      };
    },
    [assetsRef, addClipToTimeline],
  );

  const handleSetPlayhead = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (args.time === undefined) {
        return {
          tool_name: "set_playhead",
          success: false,
          result: null,
          error: "Missing time",
        };
      }

      const time = Number(args.time);
      setCurrentTime(time);

      return {
        tool_name: "set_playhead",
        success: true,
        result: { time },
        error: null,
      };
    },
    [setCurrentTime],
  );

  const handleDuplicateTimeline = useCallback((): ToolResult => {
    if (!currentProjectId || !activeTimelineId) {
      return {
        tool_name: "duplicate_timeline",
        success: false,
        result: null,
        error: "No active project or timeline",
      };
    }

    const clips = clipsRef.current ?? [];
    snapshotRef.current = JSON.parse(JSON.stringify(clips));

    const newTimeline = duplicateTimeline(currentProjectId, activeTimelineId);
    if (!newTimeline) {
      return {
        tool_name: "duplicate_timeline",
        success: false,
        result: null,
        error: "Failed to duplicate timeline",
      };
    }

    return {
      tool_name: "duplicate_timeline",
      success: true,
      result: {
        newTimelineId: newTimeline.id,
        newTimelineName: newTimeline.name,
        snapshotClipCount: clips.length,
      },
      error: null,
    };
  }, [clipsRef, currentProjectId, activeTimelineId, duplicateTimeline]);

  const handleCreateTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (!currentProjectId) {
        return {
          tool_name: "create_timeline",
          success: false,
          result: null,
          error: "No active project",
        };
      }

      const name = args.name as string | undefined;
      const newTimeline = addProjectTimeline(currentProjectId, name);

      return {
        tool_name: "create_timeline",
        success: true,
        result: { timelineId: newTimeline.id, timelineName: newTimeline.name },
        error: null,
      };
    },
    [currentProjectId, addProjectTimeline],
  );

  const handleRenameTimeline = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      if (!currentProjectId || !activeTimelineId) {
        return {
          tool_name: "rename_timeline",
          success: false,
          result: null,
          error: "No active project or timeline",
        };
      }

      const name = args.name as string | undefined;
      if (!name?.trim()) {
        return {
          tool_name: "rename_timeline",
          success: false,
          result: null,
          error: "Missing or empty name",
        };
      }

      renameTimeline(currentProjectId, activeTimelineId, name.trim());

      return {
        tool_name: "rename_timeline",
        success: true,
        result: { timelineId: activeTimelineId, newName: name.trim() },
        error: null,
      };
    },
    [currentProjectId, activeTimelineId, renameTimeline],
  );

  const handleSplitAtPlayhead = useCallback((): ToolResult => {
    const clips = clipsRef.current ?? [];
    const playhead = currentTimeRef.current ?? 0;
    const spanning = clips.filter(
      (c) => c.startTime < playhead && playhead < c.startTime + c.duration,
    );

    if (spanning.length === 0) {
      return {
        tool_name: "split_at_playhead",
        success: false,
        result: null,
        error: "No clips at playhead position",
      };
    }

    const splitIds: string[] = [];
    for (const clip of spanning) {
      splitClipAtPlayhead(clip.id, playhead);
      splitIds.push(clip.id);
    }

    return {
      tool_name: "split_at_playhead",
      success: true,
      result: { splitClips: splitIds, time: playhead },
      error: null,
    };
  }, [clipsRef, currentTimeRef, splitClipAtPlayhead]);

  const handleFlipClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "flip_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }

      const updates: Partial<TimelineClip> = {};
      if (args.horizontal !== undefined)
        updates.flipH = Boolean(args.horizontal);
      if (args.vertical !== undefined) updates.flipV = Boolean(args.vertical);

      if (Object.keys(updates).length === 0) {
        return {
          tool_name: "flip_clip",
          success: false,
          result: null,
          error: "Provide at least one of horizontal or vertical",
        };
      }

      updateClip(clipId, updates);

      return {
        tool_name: "flip_clip",
        success: true,
        result: { clipId, ...updates },
        error: null,
      };
    },
    [updateClip],
  );

  const handleReverseClip = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "reverse_clip",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }
      if (args.reversed === undefined) {
        return {
          tool_name: "reverse_clip",
          success: false,
          result: null,
          error: "Missing reversed",
        };
      }

      const reversed = Boolean(args.reversed);
      updateClip(clipId, { reversed });

      return {
        tool_name: "reverse_clip",
        success: true,
        result: { clipId, reversed },
        error: null,
      };
    },
    [updateClip],
  );

  const handleSetClipSpeed = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const clipId = args.clip_id as string | undefined;
      if (!clipId) {
        return {
          tool_name: "set_clip_speed",
          success: false,
          result: null,
          error: "Missing clip_id",
        };
      }
      if (args.speed === undefined) {
        return {
          tool_name: "set_clip_speed",
          success: false,
          result: null,
          error: "Missing speed",
        };
      }

      const newSpeed = Math.max(0.25, Math.min(4, Number(args.speed)));
      const clips = clipsRef.current ?? [];
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) {
        return {
          tool_name: "set_clip_speed",
          success: false,
          result: null,
          error: `Clip not found: ${clipId}`,
        };
      }

      const oldSpeed = clip.speed;
      let newDuration = clip.duration * (oldSpeed / newSpeed);
      const maxDur = getMaxClipDuration({ ...clip, speed: newSpeed });
      newDuration = Math.min(newDuration, maxDur);
      newDuration = Math.max(0.5, newDuration);

      updateClip(clipId, { speed: newSpeed, duration: newDuration });

      return {
        tool_name: "set_clip_speed",
        success: true,
        result: { clipId, speed: newSpeed, duration: +newDuration.toFixed(2) },
        error: null,
      };
    },
    [clipsRef, getMaxClipDuration, updateClip],
  );

  const handleAddDissolve = useCallback(
    (args: Record<string, unknown>): ToolResult => {
      const leftId = args.left_clip_id as string | undefined;
      const rightId = args.right_clip_id as string | undefined;
      if (!leftId || !rightId) {
        return {
          tool_name: "add_dissolve",
          success: false,
          result: null,
          error: "Missing left_clip_id or right_clip_id",
        };
      }

      const clips = clipsRef.current ?? [];
      const leftClip = clips.find((c) => c.id === leftId);
      const rightClip = clips.find((c) => c.id === rightId);
      if (!leftClip || !rightClip) {
        return {
          tool_name: "add_dissolve",
          success: false,
          result: null,
          error: "Clip not found",
        };
      }

      const leftEnd = leftClip.startTime + leftClip.duration;
      if (
        leftClip.trackIndex !== rightClip.trackIndex ||
        Math.abs(leftEnd - rightClip.startTime) > 0.05
      ) {
        return {
          tool_name: "add_dissolve",
          success: false,
          result: null,
          error: "Clips must be adjacent on the same track",
        };
      }

      const duration =
        args.duration !== undefined ? Math.max(0, Number(args.duration)) : 0.5;
      const dissolveType: TransitionType = duration > 0 ? "dissolve" : "none";

      setClips((prev) =>
        prev.map((c) => {
          if (c.id === leftId)
            return { ...c, transitionOut: { type: dissolveType, duration } };
          if (c.id === rightId)
            return { ...c, transitionIn: { type: dissolveType, duration } };
          return c;
        }),
      );

      return {
        tool_name: "add_dissolve",
        success: true,
        result: {
          leftClipId: leftId,
          rightClipId: rightId,
          duration,
          type: dissolveType,
        },
        error: null,
      };
    },
    [clipsRef, setClips],
  );

  const handleGetProjectAssets = useCallback((): ToolResult => {
    const assets = assetsRef.current ?? [];

    return {
      tool_name: "get_project_assets",
      success: true,
      result: {
        assetCount: assets.length,
        assets: assets.map((a) => ({
          id: a.id,
          type: a.type,
          prompt: a.prompt,
          duration: a.duration ?? null,
          resolution: a.resolution,
          path: a.path,
          favorite: a.favorite ?? false,
          bin: a.bin ?? null,
        })),
      },
      error: null,
    };
  }, [assetsRef]);

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

  // -----------------------------------------------------------------------
  // Dispatcher
  // -----------------------------------------------------------------------

  const executeTool = useCallback(
    async (call: ToolCall): Promise<ToolResult> => {
      const t0 = performance.now();
      try {
        const args = sanitizeArgs(call.arguments);
        const safe = { ...call, arguments: args };

        switch (safe.tool_name) {
          case "get_timeline_state":
            return handleGetTimelineState();
          case "trim_clip":
            return handleTrimClip(safe.arguments);
          case "split_clip":
            return handleSplitClip(safe.arguments);
          case "delete_clip":
            return handleDeleteClip(safe.arguments);
          case "move_clip":
            return handleMoveClip(safe.arguments);
          case "add_clip_to_timeline":
            return handleAddClipToTimeline(safe.arguments);
          case "set_playhead":
            return handleSetPlayhead(safe.arguments);
          case "duplicate_timeline":
            return handleDuplicateTimeline();
          case "create_timeline":
            return handleCreateTimeline(safe.arguments);
          case "rename_timeline":
            return handleRenameTimeline(safe.arguments);
          case "split_at_playhead":
            return handleSplitAtPlayhead();
          case "flip_clip":
            return handleFlipClip(safe.arguments);
          case "reverse_clip":
            return handleReverseClip(safe.arguments);
          case "set_clip_speed":
            return handleSetClipSpeed(safe.arguments);
          case "add_dissolve":
            return handleAddDissolve(safe.arguments);
          case "get_project_assets":
            return handleGetProjectAssets();
          default:
            return {
              tool_name: safe.tool_name,
              success: false,
              result: null,
              error: `Unknown tool: ${safe.tool_name}`,
            };
        }
      } catch (err) {
        console.error(
          "[agent-exec] %s threw after %.0fms:",
          call.tool_name,
          performance.now() - t0,
          err,
        );
        return {
          tool_name: call.tool_name,
          success: false,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [
      handleAddClipToTimeline,
      handleAddDissolve,
      handleCreateTimeline,
      handleDeleteClip,
      handleDuplicateTimeline,
      handleFlipClip,
      handleGetProjectAssets,
      handleGetTimelineState,
      handleMoveClip,
      handleRenameTimeline,
      handleReverseClip,
      handleSetClipSpeed,
      handleSetPlayhead,
      handleSplitAtPlayhead,
      handleSplitClip,
      handleTrimClip,
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
