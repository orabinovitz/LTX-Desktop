import { backendFetch } from '@/lib/backend'

export interface VideoGenerationJobResponse {
  status: string
  generationId: string
  batchId?: string | null
}

export interface VideoGenerationJobStatus {
  generationId: string
  status: string
  phase: string
  progress: number
  currentStep: number | null
  totalSteps: number | null
  videoPath?: string | null
  error?: string | null
  batchId?: string | null
}

export interface LegacyGenerationProgress {
  status: string
  phase: string
  progress: number
  currentStep: number | null
  totalSteps: number | null
}

function buildCancelPath(options?: { generationId?: string; batchId?: string }): string {
  const params = new URLSearchParams()
  if (options?.generationId) params.set('generation_id', options.generationId)
  if (options?.batchId) params.set('batch_id', options.batchId)
  const query = params.toString()
  return query ? `/api/generate/cancel?${query}` : '/api/generate/cancel'
}

export async function submitVideoGenerationJob(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<VideoGenerationJobResponse> {
  const response = await backendFetch('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Generation request failed (${response.status})`)
  }

  return response.json() as Promise<VideoGenerationJobResponse>
}

export async function getVideoGenerationJobStatus(
  generationId: string,
): Promise<VideoGenerationJobStatus> {
  const response = await backendFetch(`/api/generations/${generationId}`)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Generation status failed (${response.status})`)
  }
  return response.json() as Promise<VideoGenerationJobStatus>
}

export async function getLegacyGenerationProgress(
  generationId?: string,
): Promise<LegacyGenerationProgress> {
  const path = generationId
    ? `/api/generation/progress?generation_id=${encodeURIComponent(generationId)}`
    : '/api/generation/progress'
  const response = await backendFetch(path)
  if (!response.ok) {
    throw new Error(`Generation progress failed (${response.status})`)
  }
  return response.json() as Promise<LegacyGenerationProgress>
}

export async function cancelVideoGeneration(options?: {
  generationId?: string
  batchId?: string
}): Promise<void> {
  const response = await backendFetch(buildCancelPath(options), { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Cancel request failed: ${response.status}`)
  }
}
