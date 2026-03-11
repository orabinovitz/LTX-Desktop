/**
 * Standalone generation functions for agent tool execution.
 *
 * These bypass the React hooks (useGeneration) and call the backend APIs
 * directly, returning Promises that resolve when generation completes.
 * This avoids React state management complexity inside the agent executor.
 */

import type { Asset } from "../../types/project";
import { copyToAssetFolder } from "../../lib/asset-copy";

interface GenerationProgress {
  status: string;
  phase: string;
  progress: number;
  currentStep: number;
  totalSteps: number;
}

interface VideoGenerationParams {
  prompt: string;
  mode: "text_to_video" | "image_to_video" | "audio_to_video";
  imagePath?: string;
  audioPath?: string;
  duration?: number;
  resolution?: string;
  fps?: number;
  aspectRatio?: string;
  model?: string;
  cameraMotion?: string;
}

interface ImageGenerationParams {
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  numVariations?: number;
}

interface RetakeParams {
  videoPath: string;
  startTime: number;
  duration: number;
  prompt: string;
  mode?: string;
}

interface GenerationResult {
  assetId: string;
  type: "video" | "image";
  path: string;
  url: string;
}

const IMAGE_SHORT_SIDE: Record<string, number> = {
  "1080p": 1080,
  "1440p": 1440,
  "2048p": 2048,
};

const ASPECT_RATIO_VALUE: Record<string, number> = {
  "1:1": 1,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "21:9": 21 / 9,
};

function getImageDimensions(
  resolution: string,
  aspectRatio: string,
): { width: number; height: number } {
  const shortSide = IMAGE_SHORT_SIDE[resolution] ?? 1080;
  const ratio = ASPECT_RATIO_VALUE[aspectRatio] ?? 16 / 9;
  if (ratio >= 1) {
    return { width: Math.round(shortSide * ratio), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide / ratio) };
}

async function getBackendUrl(): Promise<string> {
  return window.electronAPI.getBackendUrl();
}

export async function agentGenerateVideo(
  params: VideoGenerationParams,
  addAsset: (
    projectId: string,
    asset: Omit<Asset, "id" | "createdAt">,
  ) => Asset,
  projectId: string,
  _assetSavePath?: string | undefined | null,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const backendUrl = await getBackendUrl();

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    model: params.model ?? "fast",
    duration: String(params.duration ?? 5),
    resolution: params.resolution ?? "1080p",
    fps: String(params.fps ?? 24),
    audio: "true",
    cameraMotion: params.cameraMotion ?? "none",
    aspectRatio: params.aspectRatio ?? "16:9",
  };
  if (params.imagePath) body.imagePath = params.imagePath;
  if (params.audioPath) body.audioPath = params.audioPath;

  const response = await fetch(`${backendUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Generation request failed (${response.status})`);
  }

  const result = await response.json();

  if (result.status === "cancelled") throw new Error("Generation was cancelled");
  if (result.error) throw new Error(result.error);

  const videoPath: string = result.video_path || "";
  if (!videoPath) throw new Error("Generation completed but no video path returned");

  const videoUrl = videoPath.startsWith("/")
    ? `file://${videoPath}`
    : `file:///${videoPath.replace(/\\/g, "/")}`;

  const copied = await copyToAssetFolder(videoPath, projectId);
  const finalPath = copied?.path ?? videoPath;
  const finalUrl = copied?.url ?? videoUrl;

  const newAsset = addAsset(projectId, {
    type: "video",
    path: finalPath,
    url: finalUrl,
    prompt: params.prompt,
    resolution: params.resolution ?? "1080p",
    duration: params.duration ?? 5,
    generationParams: {
      mode: params.imagePath ? 'image-to-video' : 'text-to-video',
      prompt: params.prompt,
      model: params.model ?? 'fast',
      duration: params.duration ?? 5,
      resolution: params.resolution ?? '1080p',
      fps: params.fps ?? 24,
      audio: true,
      cameraMotion: params.cameraMotion ?? 'none',
    },
  });

  return {
    assetId: newAsset.id,
    type: "video",
    path: finalPath,
    url: finalUrl,
  };
}

export async function agentGenerateImage(
  params: ImageGenerationParams,
  addAsset: (
    projectId: string,
    asset: Omit<Asset, "id" | "createdAt">,
  ) => Asset,
  projectId: string,
  _assetSavePath?: string | undefined | null,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const backendUrl = await getBackendUrl();
  const { width, height } = getImageDimensions(
    params.resolution ?? "1080p",
    params.aspectRatio ?? "16:9",
  );

  const response = await fetch(`${backendUrl}/api/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: params.prompt,
      width,
      height,
      numSteps: 8,
      numImages: params.numVariations ?? 1,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Image generation failed (${response.status})`);
  }

  const data = await response.json();
  const imagePaths: string[] = data.image_paths || [];
  if (imagePaths.length === 0) throw new Error("No images generated");

  const imagePath = imagePaths[0];
  const imageUrl = imagePath.startsWith("/")
    ? `file://${imagePath}`
    : `file:///${imagePath.replace(/\\/g, "/")}`;

  const copied = await copyToAssetFolder(imagePath, projectId);
  const finalPath = copied?.path ?? imagePath;
  const finalUrl = copied?.url ?? imageUrl;

  const newAsset = addAsset(projectId, {
    type: "image",
    path: finalPath,
    url: finalUrl,
    prompt: params.prompt,
    resolution: `${width}x${height}`,
    generationParams: {
      mode: 'text-to-image',
      prompt: params.prompt,
      model: 'fast',
      duration: 0,
      resolution: `${width}x${height}`,
      fps: 0,
      audio: false,
      cameraMotion: 'none',
      imageAspectRatio: params.aspectRatio ?? '16:9',
      imageSteps: 8,
    },
  });

  return {
    assetId: newAsset.id,
    type: "image",
    path: finalPath,
    url: finalUrl,
  };
}

export async function agentRetakeSection(
  params: RetakeParams,
  addAsset: (
    projectId: string,
    asset: Omit<Asset, "id" | "createdAt">,
  ) => Asset,
  projectId: string,
  _assetSavePath?: string | undefined | null,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const backendUrl = await getBackendUrl();

  const response = await fetch(`${backendUrl}/api/retake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_path: params.videoPath,
      start_time: params.startTime,
      duration: params.duration,
      prompt: params.prompt,
      mode: params.mode ?? "replace_audio_and_video",
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Retake failed (${response.status})`);
  }

  const result = await response.json();

  if (result.status === "cancelled") throw new Error("Retake was cancelled");
  if (result.error) throw new Error(result.error);

  const videoPath: string = result.video_path || "";
  if (!videoPath) throw new Error("Retake completed but no video path returned");

  const videoUrl = videoPath.startsWith("/")
    ? `file://${videoPath}`
    : `file:///${videoPath.replace(/\\/g, "/")}`;

  const copied = await copyToAssetFolder(videoPath, projectId);
  const finalPath = copied?.path ?? videoPath;
  const finalUrl = copied?.url ?? videoUrl;

  const newAsset = addAsset(projectId, {
    type: "video",
    path: finalPath,
    url: finalUrl,
    prompt: params.prompt,
    resolution: "1080p",
    duration: params.duration,
    generationParams: {
      mode: 'retake' as const,
      prompt: params.prompt,
      model: 'fast',
      duration: params.duration,
      resolution: '1080p',
      fps: 24,
      audio: true,
      cameraMotion: 'none',
      retakeVideoPath: params.videoPath,
      retakeStartTime: params.startTime,
      retakeDuration: params.duration,
      retakeMode: params.mode ?? 'replace_audio_and_video',
    },
  });

  return {
    assetId: newAsset.id,
    type: "video",
    path: finalPath,
    url: finalUrl,
  };
}

export async function agentCancelGeneration(): Promise<void> {
  const backendUrl = await getBackendUrl();
  await fetch(`${backendUrl}/api/generate/cancel`, { method: "POST" });
}

export async function agentGetGenerationStatus(): Promise<{
  isGenerating: boolean;
  progress: number;
  phase: string;
}> {
  const backendUrl = await getBackendUrl();
  try {
    const res = await fetch(`${backendUrl}/api/generation/progress`);
    if (!res.ok) return { isGenerating: false, progress: 0, phase: "idle" };
    const data: GenerationProgress = await res.json();
    return {
      isGenerating: data.status === "generating" || data.phase !== "complete",
      progress: data.progress,
      phase: data.phase,
    };
  } catch {
    return { isGenerating: false, progress: 0, phase: "idle" };
  }
}
