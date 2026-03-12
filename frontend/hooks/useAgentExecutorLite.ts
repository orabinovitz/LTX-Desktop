import { useCallback, useRef } from "react";
import type { Asset } from "../types/project";
import type { ToolResult } from "../views/editor/useAgentExecutor";
import type { OnToolProgress } from "./use-agent";
import {
  agentGenerateVideo,
  agentGenerateImage,
  agentRetakeSection,
  agentCancelGeneration,
  agentGetGenerationStatus,
} from "../views/editor/agentGenerationHelper";

export interface AgentExecutorLiteDeps {
  assetsRef: React.RefObject<Asset[]>;
  currentProjectId: string | null;
  addAsset: (
    projectId: string,
    asset: Omit<Asset, "id" | "createdAt">,
  ) => Asset;
  deleteAsset?: (projectId: string, assetId: string) => void;
  toggleFavorite?: (projectId: string, assetId: string) => void;
  assetSavePath?: string | null;
}

/**
 * Lightweight agent tool executor for non-editor views (GenSpace, Playground).
 * Handles asset management and generation tools only.
 * Timeline-specific tools return an error result.
 */
export function useAgentExecutorLite(deps: AgentExecutorLiteDeps) {
  const {
    assetsRef,
    currentProjectId,
    addAsset,
    deleteAsset,
    toggleFavorite,
    assetSavePath,
  } = deps;

  const generationAbortRef = useRef<AbortController | null>(null);

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

  const executeTool = useCallback(
    async (toolCall: {
      tool_name: string;
      arguments: Record<string, unknown>;
    }, onProgress?: OnToolProgress): Promise<ToolResult> => {
      const { tool_name, arguments: args } = toolCall;

      switch (tool_name) {
        case "get_project_assets": {
          const assets = assetsRef.current ?? [];
          return ok("get_project_assets", {
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
              parentAssetId: a.parentAssetId ?? null,
              sourceIn: a.sourceIn ?? null,
              sourceOut: a.sourceOut ?? null,
              topics: a.topics ?? [],
            })),
          });
        }

        case "delete_asset": {
          const assetId = args.asset_id as string | undefined;
          if (!assetId) return fail("delete_asset", "Missing asset_id");
          if (deleteAsset && currentProjectId)
            deleteAsset(currentProjectId, assetId);
          const remaining = (assetsRef.current ?? []).length;
          return ok("delete_asset", { assetId, remaining_asset_count: remaining });
        }

        case "batch_delete_assets": {
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
          const remainingCount = (assetsRef.current ?? []).length;
          return ok("batch_delete_assets", {
            deleted,
            failed,
            deleted_count: deleted.length,
            failed_count: failed.length,
            remaining_asset_count: remainingCount,
          });
        }

        case "organize_asset": {
          const assetId = args.asset_id as string | undefined;
          if (!assetId) return fail("organize_asset", "Missing asset_id");
          if (
            args.favorite !== undefined &&
            toggleFavorite &&
            currentProjectId
          ) {
            toggleFavorite(currentProjectId, assetId);
          }
          return ok("organize_asset", {
            assetId,
            bin: args.bin,
            favorite: args.favorite,
          });
        }

        case "create_subclip_assets": {
          if (!currentProjectId)
            return fail("create_subclip_assets", "No active project");
          const subclips = args.subclips as
            | Array<{
                parent_asset_id: string;
                source_in: number;
                source_out: number;
                title: string;
                description: string;
                topics?: string[];
                transcript?: string;
              }>
            | undefined;
          if (!subclips?.length)
            return fail(
              "create_subclip_assets",
              "Missing or empty subclips array",
            );

          const assets = assetsRef.current ?? [];
          const createdIds: string[] = [];
          for (const sc of subclips) {
            const parent = assets.find((a) => a.id === sc.parent_asset_id);
            if (!parent) continue;
            const newAsset = addAsset(currentProjectId, {
              type: "video",
              path: parent.path,
              url: parent.url,
              prompt: sc.title,
              resolution: parent.resolution,
              duration: sc.source_out - sc.source_in,
              thumbnail: parent.thumbnail,
              parentAssetId: sc.parent_asset_id,
              sourceIn: sc.source_in,
              sourceOut: sc.source_out,
              transcript: sc.transcript ?? "",
              topics: sc.topics ?? [],
            });
            createdIds.push(newAsset.id);
          }
          return ok("create_subclip_assets", {
            createdAssetIds: createdIds,
            count: createdIds.length,
          });
        }

        case "import_media":
          return ok("import_media", { note: "File import dialog triggered" });

        case "set_active_take":
          return ok("set_active_take", { note: "Take switched" });

        case "regenerate_asset":
          return ok("regenerate_asset", { note: "Regeneration queued" });

        case "generate_video": {
          if (!currentProjectId)
            return fail("generate_video", "No active project");
          const prompt = args.prompt as string;
          if (!prompt) return fail("generate_video", "Missing prompt");

          const mode = (args.mode as string) ?? "text_to_video";
          let imagePath: string | undefined;
          let audioPath: string | undefined;

          if (mode === "image_to_video" && args.image_asset_id) {
            const assets = assetsRef.current ?? [];
            const img = assets.find((a) => a.id === args.image_asset_id);
            if (!img)
              return fail(
                "generate_video",
                `Image asset not found: ${args.image_asset_id}`,
              );
            imagePath = img.path;
          }
          if (mode === "audio_to_video" && args.audio_asset_id) {
            const assets = assetsRef.current ?? [];
            const aud = assets.find((a) => a.id === args.audio_asset_id);
            if (!aud)
              return fail(
                "generate_video",
                `Audio asset not found: ${args.audio_asset_id}`,
              );
            audioPath = aud.path;
          }

          generationAbortRef.current = new AbortController();
          try {
            const result = await agentGenerateVideo(
              {
                prompt,
                mode: mode as
                  | "text_to_video"
                  | "image_to_video"
                  | "audio_to_video",
                imagePath,
                audioPath,
                duration: args.duration ? Number(args.duration) : undefined,
                resolution: args.resolution as string | undefined,
                fps: args.fps ? Number(args.fps) : undefined,
                aspectRatio: args.aspect_ratio as string | undefined,
                model: args.model as string | undefined,
                cameraMotion: args.camera_motion as string | undefined,
              },
              addAsset,
              currentProjectId,
              assetSavePath,
              generationAbortRef.current.signal,
              onProgress,
            );
            return ok("generate_video", result);
          } catch (e) {
            return fail(
              "generate_video",
              e instanceof Error ? e.message : String(e),
            );
          }
        }

        case "generate_image": {
          if (!currentProjectId)
            return fail("generate_image", "No active project");
          const prompt = args.prompt as string;
          if (!prompt) return fail("generate_image", "Missing prompt");

          generationAbortRef.current = new AbortController();
          try {
            const result = await agentGenerateImage(
              {
                prompt,
                resolution: args.resolution as string | undefined,
                aspectRatio: args.aspect_ratio as string | undefined,
                numVariations: args.num_variations
                  ? Number(args.num_variations)
                  : undefined,
              },
              addAsset,
              currentProjectId,
              assetSavePath,
              generationAbortRef.current.signal,
              onProgress,
            );
            return ok("generate_image", result);
          } catch (e) {
            return fail(
              "generate_image",
              e instanceof Error ? e.message : String(e),
            );
          }
        }

        case "retake_section": {
          if (!currentProjectId)
            return fail("retake_section", "No active project");
          const videoAssetId = args.video_asset_id as string;
          if (!videoAssetId)
            return fail("retake_section", "Missing video_asset_id");

          const assets = assetsRef.current ?? [];
          const videoAsset = assets.find((a) => a.id === videoAssetId);
          if (!videoAsset)
            return fail(
              "retake_section",
              `Asset not found: ${videoAssetId}`,
            );

          generationAbortRef.current = new AbortController();
          try {
            const result = await agentRetakeSection(
              {
                videoPath: videoAsset.path,
                startTime: Number(args.start_time ?? 0),
                duration: Number(args.duration ?? 2),
                prompt: (args.prompt as string) ?? "",
                mode: args.mode as string | undefined,
              },
              addAsset,
              currentProjectId,
              assetSavePath,
              generationAbortRef.current.signal,
              onProgress,
            );
            return ok("retake_section", result);
          } catch (e) {
            return fail(
              "retake_section",
              e instanceof Error ? e.message : String(e),
            );
          }
        }

        case "cancel_generation": {
          if (generationAbortRef.current)
            generationAbortRef.current.abort();
          await agentCancelGeneration();
          return ok("cancel_generation", { cancelled: true });
        }

        case "get_generation_status": {
          const status = await agentGetGenerationStatus();
          return ok("get_generation_status", status);
        }

        default:
          return fail(
            tool_name,
            `Tool "${tool_name}" is not available in this view`,
          );
      }
    },
    [
      assetsRef,
      currentProjectId,
      addAsset,
      deleteAsset,
      toggleFavorite,
      assetSavePath,
    ],
  );

  return { executeTool };
}
