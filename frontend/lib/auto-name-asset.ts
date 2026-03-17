import type { Asset } from '@/types/project'
import { backendFetch } from '@/lib/backend'
import { logger } from '@/lib/logger'

/**
 * Fire-and-forget: ask the backend LLM for a short name + tags,
 * then update the asset. Swallows all errors silently.
 */
export function autoNameAsset(
  projectId: string,
  assetId: string,
  prompt: string,
  assetType: string,
  existingProjectTags: string[],
  updateAsset: (projectId: string, assetId: string, updates: Partial<Asset>) => void,
): void {
  backendFetch('/api/agent/suggest-asset-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      asset_type: assetType,
      existing_tags: existingProjectTags,
    }),
  })
    .then(async (res) => {
      if (!res.ok) return
      const data = await res.json() as { name?: string | null; tags?: string[] }
      if (data.name || (data.tags && data.tags.length > 0)) {
        updateAsset(projectId, assetId, {
          name: data.name || undefined,
          tags: data.tags && data.tags.length > 0 ? data.tags : undefined,
        })
      }
    })
    .catch(() => {
      logger.debug('[auto-name] failed to suggest asset meta — asset stays unnamed')
    })
}
