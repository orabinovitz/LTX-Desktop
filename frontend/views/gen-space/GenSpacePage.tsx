import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { Sparkles, Scissors } from 'lucide-react'
import { useProjects } from '@/contexts/ProjectContext'
import type { GenSpaceRetakeSource } from '@/contexts/ProjectContext'
import { useAppSettings } from '@/contexts/AppSettingsContext'
import { useGeneration } from '@/hooks/use-generation'
import { useRetake } from '@/hooks/use-retake'
import { useIcLora } from '@/hooks/use-ic-lora'
import type { ICLoraConditioningType } from '@/components/ICLoraPanel'
import type { Asset } from '@/types/project'
import { GenerationErrorDialog } from '@/components/GenerationErrorDialog'
import { copyToAssetFolder } from '@/lib/asset-copy'
import { fileUrlToPath } from '@/lib/url-to-path'
import { sanitizeForcedApiVideoSettings } from '@/lib/api-video-options'
import { logger } from '@/lib/logger'
import { RetakePanel } from '@/components/RetakePanel'
import { ICLoraPanel } from '@/components/ICLoraPanel'
import { FreeApiKeyBubble } from '@/components/FreeApiKeyBubble'
import { autoNameAsset } from '@/lib/auto-name-asset'

import { useAgentDispatch } from '@/contexts/AgentContext'
import type { ToolResult } from '@/types/agent-progress'
import {
  agentGenerateImage,
  agentGenerateVideo,
  agentCancelGeneration,
  agentGetGenerationStatus,
} from '../editor/utils/agent-generation-helper'

import { AssetCard } from './AssetCard'
import { AssetPreviewModal } from './AssetPreviewModal'
import { AssetContextMenu, type ContextMenuPosition } from './AssetContextMenu'
import { BinSidebar, type ActiveBinFilter } from './BinSidebar'
import { FilterSortBar, type TypeFilter, type SortMode, type GallerySize, gallerySizeClasses } from './FilterSortBar'
import { PromptBar } from './PromptBar'

const DEFAULT_VIDEO_SETTINGS = {
  model: 'fast',
  duration: 5,
  videoResolution: '540p',
  fps: 24,
  aspectRatio: '16:9',
  imageModel: 'nano-banana-2' as 'nano-banana-2' | 'z-image-turbo',
  imageResolution: '1080p',
  nb2Resolution: '1K',
  variations: 1,
  audio: true,
}

export function GenSpacePage() {
  const {
    currentProject,
    currentProjectId,
    currentTab,
    addAsset,
    addTakeToAsset,
    deleteAsset,
    updateAsset,
    toggleFavorite,
    updateBinMeta,
    renameBin: renameBinCtx,
    deleteBin: deleteBinCtx,
    genSpaceEditImageUrl,
    setGenSpaceEditImageUrl,
    setGenSpaceEditMode,
    genSpaceAudioUrl,
    setGenSpaceAudioUrl,
    genSpaceRetakeSource,
    setGenSpaceRetakeSource,
    setPendingRetakeUpdate,
    genSpaceIcLoraSource,
    setGenSpaceIcLoraSource,
    setPendingIcLoraUpdate,
  } = useProjects()
  const { shouldVideoGenerateWithLtxApi, forceApiGenerations, settings: appSettings } = useAppSettings()
  const [mode, setMode] = useState<'image' | 'video' | 'retake' | 'ic-lora'>('video')
  const [prompt, setPrompt] = useState('')
  const [inputImage, setInputImage] = useState<string | null>(null)
  const [inputAudio, setInputAudio] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_VIDEO_SETTINGS }))
  const [editImages, setEditImages] = useState<Array<{ dataUri: string; name: string }>>([])

  // Organization state
  const [activeBin, setActiveBin] = useState<ActiveBinFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('newest')
  const [showFavorites, setShowFavorites] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [gallerySize, setGallerySize] = useState<GallerySize>('medium')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ asset: Asset; position: ContextMenuPosition } | null>(null)

  const persistedVideoKeyRef = useRef<string | null>(null)
  const retakeSubmissionRef = useRef<{
    prompt: string
    input: { videoPath: string | null; startTime: number; duration: number; videoDuration: number }
  } | null>(null)
  const icLoraSubmissionRef = useRef<{
    prompt: string
    input: { videoPath: string; conditioningType: ICLoraConditioningType; conditioningStrength: number }
  } | null>(null)

  const applyForcedVideoSettings = useCallback(
    <T extends { model: string; duration: number; videoResolution: string; fps: number; audio: boolean; aspectRatio: string }>(next: T): T => {
      if (!shouldVideoGenerateWithLtxApi || mode !== 'video') return next
      return { ...next, ...sanitizeForcedApiVideoSettings(next, { hasAudio: !!inputAudio }) }
    },
    [inputAudio, mode, shouldVideoGenerateWithLtxApi],
  )

  const { generate, generateImage, isGenerating, progress, statusMessage, videoUrl, videoPath, imageUrls, imagePaths, error, reset } = useGeneration()
  const { submitRetake, resetRetake, isRetaking, retakeStatus, retakeError, retakeResult } = useRetake()
  const { submitIcLora, resetIcLora, isIcLoraGenerating, icLoraStatus, icLoraError, icLoraResult } = useIcLora()

  // ---------------------------------------------------------------------------
  // Agent executor
  // ---------------------------------------------------------------------------
  const { registerExecutor, unregisterExecutor } = useAgentDispatch()
  const currentProjectRef = useRef(currentProject)
  currentProjectRef.current = currentProject
  const modeRef = useRef(mode)
  modeRef.current = mode
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const selectedAssetRef = useRef(selectedAsset)
  selectedAssetRef.current = selectedAsset
  const activeBinRef = useRef(activeBin)
  activeBinRef.current = activeBin

  const genspaceExecuteTool = useCallback(
    async (toolCall: { tool_name: string; arguments: Record<string, unknown> }): Promise<ToolResult> => {
      const { tool_name, arguments: args } = toolCall
      const ok = (result: unknown): ToolResult => ({ tool_name, success: true, result, error: null })
      const fail = (error: string): ToolResult => ({ tool_name, success: false, result: null, error })

      switch (tool_name) {
        case 'get_project_assets': {
          const projectAssets = currentProjectRef.current?.assets ?? []
          const includeArchived = args.include_archived as boolean | undefined
          const filtered = includeArchived ? projectAssets : projectAssets.filter(a => !a.archived)
          return ok({
            assetCount: filtered.length,
            assets: filtered.map((a) => ({
              id: a.id, type: a.type, prompt: a.prompt,
              name: a.name ?? null, tags: a.tags ?? [],
              duration: a.duration ?? null, resolution: a.resolution,
              path: a.path, favorite: a.favorite ?? false,
              bin: a.bin ?? null, archived: a.archived ?? false,
              parentAssetId: a.parentAssetId ?? null,
              sourceIn: a.sourceIn ?? null, sourceOut: a.sourceOut ?? null,
              topics: a.topics ?? [],
            })),
          })
        }
        case 'generate_video': {
          const p = args.prompt as string
          if (!p) return fail('Missing prompt')
          if (!currentProjectId) return fail('No active project')
          let imagePath: string | undefined
          if (args.image_asset_id) {
            const projectAssets = currentProjectRef.current?.assets ?? []
            const img = projectAssets.find(a => a.id === args.image_asset_id)
            if (!img) return fail(`Image asset not found: ${args.image_asset_id}`)
            imagePath = img.path
          }
          try {
            const result = await agentGenerateVideo(
              {
                prompt: p,
                mode: imagePath ? 'image_to_video' : 'text_to_video',
                imagePath,
                duration: args.duration ? Number(args.duration) : 5,
                resolution: shouldVideoGenerateWithLtxApi ? '1080p' : ((args.resolution as string) ?? '1080p'),
                fps: args.fps ? Number(args.fps) : 24,
                aspectRatio: (args.aspect_ratio as string) ?? '16:9',
                model: (args.model as string) ?? 'fast',
                cameraMotion: (args.camera_motion as string) ?? 'none',
              },
              addAsset, currentProjectId,
              undefined, undefined, undefined,
              { updateAsset, projectTags },
            )
            return ok(result)
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e))
          }
        }
        case 'generate_image': {
          const p = args.prompt as string
          if (!p) return fail('Missing prompt')
          if (!currentProjectId) return fail('No active project')
          try {
            let resolvedImageUrls: string[] | undefined
            const rawImageUrls = args.image_urls as string[] | undefined
            if (rawImageUrls && rawImageUrls.length > 0) {
              const projectAssets = currentProjectRef.current?.assets ?? []
              resolvedImageUrls = rawImageUrls.map(ref => {
                if (ref.startsWith('data:') || ref.startsWith('file:') || ref.startsWith('http')) return ref
                const matched = projectAssets.find(a => a.id === ref)
                return matched?.url ?? ref
              })
            }
            const result = await agentGenerateImage(
              {
                prompt: p,
                model: (args.model as 'nano-banana-2' | 'z-image-turbo') || undefined,
                resolution: (args.resolution as string) || undefined,
                aspectRatio: (args.aspect_ratio as string) ?? '16:9',
                numVariations: args.num_variations ? Number(args.num_variations) : undefined,
                imageUrls: resolvedImageUrls,
              },
              addAsset, currentProjectId,
              undefined, undefined, undefined,
              { updateAsset, projectTags },
            )
            return ok(result)
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e))
          }
        }
        case 'cancel_generation': {
          await agentCancelGeneration()
          return ok({ cancelled: true })
        }
        case 'get_generation_status': {
          const s = await agentGetGenerationStatus()
          return ok(s)
        }
        case 'delete_asset': {
          const assetId = args.asset_id as string
          if (!assetId || !currentProjectId) return fail('Missing asset_id or project')
          deleteAsset(currentProjectId, assetId)
          const remaining = (currentProjectRef.current?.assets ?? []).length
          return ok({ deleted: assetId, remaining_asset_count: remaining })
        }
        case 'batch_delete_assets': {
          const assetIds = args.asset_ids as string[] | undefined
          if (!assetIds?.length || !currentProjectId) return fail('Missing asset_ids or project')
          const deleted: string[] = []
          const failed: string[] = []
          for (const id of assetIds) {
            try { deleteAsset(currentProjectId, id); deleted.push(id) }
            catch { failed.push(id) }
          }
          const remainingCount = (currentProjectRef.current?.assets ?? []).length
          return ok({ deleted, failed, deleted_count: deleted.length, failed_count: failed.length, remaining_asset_count: remainingCount })
        }
        case 'toggle_favorite': {
          const assetId = args.asset_id as string
          if (!assetId || !currentProjectId) return fail('Missing asset_id or project')
          toggleFavorite(currentProjectId, assetId)
          return ok({ toggled: assetId })
        }
        case 'organize_asset': {
          const assetId = args.asset_id as string
          if (!assetId || !currentProjectId) return fail('Missing asset_id or project')
          if (args.favorite !== undefined) {
            toggleFavorite(currentProjectId, assetId)
          }
          const updates: Partial<Asset> = {}
          if (args.name !== undefined) updates.name = (args.name as string) || undefined
          if (args.tags !== undefined) updates.tags = args.tags as string[]
          if (args.bin !== undefined) updates.bin = (args.bin as string) || undefined
          if (args.archived !== undefined) updates.archived = args.archived as boolean
          if (Object.keys(updates).length > 0) updateAsset(currentProjectId, assetId, updates)
          return ok({ assetId, name: args.name, tags: args.tags, bin: args.bin, archived: args.archived, favorite: args.favorite })
        }
        case 'create_bin': {
          const name = args.name as string
          if (!name || !currentProjectId) return fail('Missing name or project')
          const normalizedName = name.trim()
          if (!normalizedName) return fail('Bin name cannot be empty')
          updateBinMeta(currentProjectId, normalizedName, { color: (args.color as string) || undefined, createdAt: Date.now() })
          return ok({ created: normalizedName, color: args.color })
        }
        case 'list_bins': {
          const project = currentProjectRef.current
          const bins = project?.bins || {}
          const assets = project?.assets ?? []
          const binList = Object.entries(bins).map(([name, meta]) => ({
            name,
            color: meta.color ?? null,
            assetCount: assets.filter(a => a.bin === name && !a.archived).length,
          }))
          return ok({ bins: binList, totalAssets: assets.filter(a => !a.archived).length })
        }
        case 'rename_bin': {
          const oldName = args.old_name as string
          const newName = args.new_name as string
          if (!oldName || !newName || !currentProjectId) return fail('Missing old_name, new_name, or project')
          renameBinCtx(currentProjectId, oldName, newName.trim())
          return ok({ renamed: { from: oldName, to: newName.trim() } })
        }
        case 'set_bin_color': {
          const binName = args.bin_name as string
          const color = args.color as string
          if (!binName || !color || !currentProjectId) return fail('Missing bin_name, color, or project')
          updateBinMeta(currentProjectId, binName, { color })
          return ok({ binName, color })
        }
        case 'batch_organize_assets': {
          const assetIds = args.asset_ids as string[] | undefined
          if (!assetIds?.length || !currentProjectId) return fail('Missing asset_ids or project')
          const updates: Partial<Asset> = {}
          if (args.bin !== undefined) updates.bin = (args.bin as string) || undefined
          if (args.archived !== undefined) updates.archived = args.archived as boolean
          for (const id of assetIds) {
            updateAsset(currentProjectId, id, updates)
          }
          return ok({ updated: assetIds.length, bin: args.bin, archived: args.archived })
        }
        default:
          return fail(`Tool "${tool_name}" is not available in Gen Space`)
      }
    },
    [currentProjectId, addAsset, deleteAsset, updateAsset, toggleFavorite, updateBinMeta, renameBinCtx, shouldVideoGenerateWithLtxApi],
  )

  useLayoutEffect(() => {
    if (currentTab !== 'gen-space') {
      unregisterExecutor('genspace')
      return
    }
    registerExecutor({
      viewContext: 'genspace',
      executeTool: genspaceExecuteTool,
      getTimelineState: () => null,
      getViewContext: () => {
        const allAssets = currentProjectRef.current?.assets ?? []
        const generatedAssets = allAssets.filter(a => a.generationParams && !a.archived)
        return {
          generationMode: modeRef.current,
          promptBarText: promptRef.current,
          selectedAssetId: selectedAssetRef.current?.id ?? null,
          activeBin: activeBinRef.current,
          visibleAssets: generatedAssets
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 20)
            .map(a => ({
              id: a.id, type: a.type, name: a.name ?? null,
              tags: a.tags ?? [], prompt: a.prompt, createdAt: a.createdAt,
              bin: a.bin ?? null,
            })),
        }
      },
      projectId: currentProjectId ?? null,
      canUndo: false,
      onUndo: () => {},
    })
    return () => unregisterExecutor('genspace')
  }, [genspaceExecuteTool, currentTab, currentProjectId, registerExecutor, unregisterExecutor])

  // ---------------------------------------------------------------------------
  // Retake / IC-LoRA state
  // ---------------------------------------------------------------------------
  const [retakeInput, setRetakeInput] = useState({
    videoUrl: null as string | null, videoPath: null as string | null,
    startTime: 0, duration: 0, videoDuration: 0, ready: false,
  })
  const [retakePanelKey, setRetakePanelKey] = useState(0)
  const [retakeInitial, setRetakeInitial] = useState<{ videoUrl: string | null; videoPath: string | null; duration?: number }>({ videoUrl: null, videoPath: null, duration: undefined })
  const [activeRetakeSource, setActiveRetakeSource] = useState<GenSpaceRetakeSource | null>(null)
  const [activeIcLoraSource, setActiveIcLoraSource] = useState<{ assetId?: string; linkedClipIds?: string[] } | null>(null)
  const [icLoraInput, setIcLoraInput] = useState({
    videoUrl: null as string | null, videoPath: null as string | null,
    conditioningType: 'canny' as ICLoraConditioningType, conditioningStrength: 1.0, ready: false,
  })
  const [icLoraPanelKey, setIcLoraPanelKey] = useState(0)
  const [icLoraCondType, setIcLoraCondType] = useState<ICLoraConditioningType>('canny')
  const [icLoraStrength, setIcLoraStrength] = useState(1.0)
  const [icLoraInitial, setIcLoraInitial] = useState<{ videoUrl: string | null; videoPath: string | null }>({ videoUrl: null, videoPath: null })

  // ---------------------------------------------------------------------------
  // Cross-view effects (editor → gen space)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (genSpaceEditImageUrl) {
      setMode('video'); setInputImage(genSpaceEditImageUrl); setPrompt('')
      setGenSpaceEditImageUrl(null); setGenSpaceEditMode(null)
    }
  }, [genSpaceEditImageUrl, setGenSpaceEditImageUrl, setGenSpaceEditMode])

  useEffect(() => {
    if (genSpaceAudioUrl) {
      setMode('video'); setInputAudio(genSpaceAudioUrl); setPrompt(''); setGenSpaceAudioUrl(null)
    }
  }, [genSpaceAudioUrl, setGenSpaceAudioUrl])

  useEffect(() => {
    if (!genSpaceRetakeSource) return
    setMode('retake'); setPrompt(''); setActiveRetakeSource(genSpaceRetakeSource)
    setRetakeInitial({ videoUrl: genSpaceRetakeSource.videoUrl, videoPath: genSpaceRetakeSource.videoPath, duration: genSpaceRetakeSource.duration })
    setRetakePanelKey(p => p + 1); setGenSpaceRetakeSource(null)
  }, [genSpaceRetakeSource, setGenSpaceRetakeSource])

  useEffect(() => {
    if (!genSpaceIcLoraSource) return
    if (forceApiGenerations) { setGenSpaceIcLoraSource(null); return }
    setMode('ic-lora'); setPrompt('')
    setActiveIcLoraSource({ assetId: genSpaceIcLoraSource.assetId, linkedClipIds: genSpaceIcLoraSource.linkedClipIds })
    setIcLoraInitial({ videoUrl: genSpaceIcLoraSource.videoUrl, videoPath: genSpaceIcLoraSource.videoPath })
    setIcLoraPanelKey(p => p + 1); setGenSpaceIcLoraSource(null)
  }, [genSpaceIcLoraSource, forceApiGenerations, setGenSpaceIcLoraSource])

  useEffect(() => { if (forceApiGenerations && mode === 'ic-lora') setMode('video') }, [forceApiGenerations, mode])
  useEffect(() => {
    if (!shouldVideoGenerateWithLtxApi || mode !== 'video') return
    setSettings(prev => applyForcedVideoSettings({ ...prev, model: 'fast' }))
  }, [applyForcedVideoSettings, mode, shouldVideoGenerateWithLtxApi])
  useEffect(() => { if (retakeError) setLocalError(retakeError) }, [retakeError])
  useEffect(() => { if (icLoraError) setLocalError(icLoraError) }, [icLoraError])
  useEffect(() => {
    if (inputAudio) setSettings(prev => applyForcedVideoSettings({ ...prev, model: 'pro', aspectRatio: '16:9' }))
  }, [inputAudio]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Asset filtering / sorting
  // ---------------------------------------------------------------------------
  const allGeneratedAssets = useMemo(
    () => (currentProject?.assets || []).filter(a => a.generationParams),
    [currentProject?.assets],
  )

  const projectTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const a of currentProject?.assets || []) {
      for (const t of a.tags || []) tagSet.add(t)
    }
    return Array.from(tagSet).sort()
  }, [currentProject?.assets])

  const bins = currentProject?.bins || {}

  const filteredAssets = useMemo(() => {
    let result = allGeneratedAssets

    // Bin filter
    if (activeBin === 'archived') {
      result = result.filter(a => a.archived)
    } else {
      if (!showArchived) result = result.filter(a => !a.archived)
      if (activeBin !== 'all') result = result.filter(a => a.bin === activeBin)
    }

    // Type filter
    if (typeFilter === 'image') result = result.filter(a => a.type === 'image')
    else if (typeFilter === 'video') result = result.filter(a => a.type === 'video')

    // Favorites
    if (showFavorites) result = result.filter(a => a.favorite)

    // Sort
    switch (sortMode) {
      case 'newest': result = [...result].sort((a, b) => b.createdAt - a.createdAt); break
      case 'oldest': result = [...result].sort((a, b) => a.createdAt - b.createdAt); break
      case 'name-asc': result = [...result].sort((a, b) => (a.name || a.prompt || '').localeCompare(b.name || b.prompt || '')); break
      case 'name-desc': result = [...result].sort((a, b) => (b.name || b.prompt || '').localeCompare(a.name || a.prompt || '')); break
    }

    return result
  }, [allGeneratedAssets, activeBin, typeFilter, showFavorites, showArchived, sortMode])

  const imageCount = useMemo(() => allGeneratedAssets.filter(a => !a.archived && a.type === 'image').length, [allGeneratedAssets])
  const videoCount = useMemo(() => allGeneratedAssets.filter(a => !a.archived && a.type === 'video').length, [allGeneratedAssets])
  const favoriteCount = useMemo(() => allGeneratedAssets.filter(a => !a.archived && a.favorite).length, [allGeneratedAssets])

  // ---------------------------------------------------------------------------
  // Generation completion effects
  // ---------------------------------------------------------------------------
  const [lastPrompt, setLastPrompt] = useState('')
  const agentPromptRef = useRef<string | null>(null)

  useEffect(() => {
    if (!videoUrl || !videoPath || !currentProjectId || isGenerating) return
    const generationKey = `${videoUrl}|${videoPath}`
    if (persistedVideoKeyRef.current === generationKey) return
    persistedVideoKeyRef.current = generationKey
    const effectivePrompt = lastPrompt || agentPromptRef.current || ''
    agentPromptRef.current = null
    const genMode = inputAudio ? 'audio-to-video' : inputImage ? 'image-to-video' : 'text-to-video'
    const savedVideoSettings = applyForcedVideoSettings(settings)
    ;(async () => {
      try {
        const copied = await copyToAssetFolder(videoPath, currentProjectId)
        const finalPath = copied?.path ?? videoPath
        const finalUrl = copied?.url ?? videoUrl
        const binToAssign = activeBin !== 'all' && activeBin !== 'archived' ? activeBin : undefined
        const newVideoAsset = addAsset(currentProjectId, {
          type: 'video', path: finalPath, url: finalUrl, prompt: effectivePrompt,
          resolution: savedVideoSettings.videoResolution, duration: savedVideoSettings.duration,
          bin: binToAssign,
          generationParams: {
            mode: genMode as 'text-to-video' | 'image-to-video' | 'audio-to-video',
            prompt: effectivePrompt, model: savedVideoSettings.model,
            duration: savedVideoSettings.duration, resolution: savedVideoSettings.videoResolution,
            fps: savedVideoSettings.fps, audio: savedVideoSettings.audio || false,
            cameraMotion: 'none', imageAspectRatio: savedVideoSettings.aspectRatio, imageSteps: 4,
            inputImageUrl: inputImage || undefined, inputAudioUrl: inputAudio || undefined,
          },
          takes: [{ url: finalUrl, path: finalPath, createdAt: Date.now() }],
          activeTakeIndex: 0,
        })
        autoNameAsset(currentProjectId, newVideoAsset.id, effectivePrompt, 'video', projectTags, updateAsset)
        reset()
      } catch (err) {
        persistedVideoKeyRef.current = null
        logger.error(`Failed to persist generated video asset: ${err}`)
      }
    })()
  }, [videoUrl, videoPath, currentProjectId, isGenerating, applyForcedVideoSettings, settings, inputImage, inputAudio, lastPrompt, addAsset, reset, activeBin, projectTags, updateAsset])

  useEffect(() => {
    if (!retakeResult || !currentProjectId || isRetaking) return
    const submission = retakeSubmissionRef.current
    if (!submission) return
    retakeSubmissionRef.current = null
    ;(async () => {
      const usedPrompt = submission.prompt
      const usedInput = submission.input
      const copied = await copyToAssetFolder(retakeResult.videoPath, currentProjectId)
      const finalPath = copied?.path ?? retakeResult.videoPath
      const finalUrl = copied?.url ?? retakeResult.videoUrl
      if (activeRetakeSource?.assetId) {
        const sourceAsset = currentProject?.assets?.find(a => a.id === activeRetakeSource.assetId)
        if (sourceAsset) {
          const newTakeIndex = sourceAsset.takes ? sourceAsset.takes.length : 1
          addTakeToAsset(currentProjectId, sourceAsset.id, { url: finalUrl, path: finalPath, createdAt: Date.now() })
          if (activeRetakeSource.linkedClipIds?.length) {
            setPendingRetakeUpdate({ assetId: sourceAsset.id, clipIds: activeRetakeSource.linkedClipIds, newTakeIndex })
          }
        }
      } else {
        const binToAssign = activeBin !== 'all' && activeBin !== 'archived' ? activeBin : undefined
        const newRetakeAsset = addAsset(currentProjectId, {
          type: 'video', path: finalPath, url: finalUrl, prompt: usedPrompt, resolution: '', duration: usedInput.duration,
          bin: binToAssign,
          generationParams: {
            mode: 'retake', prompt: usedPrompt, model: 'pro', duration: usedInput.duration, resolution: '',
            fps: 24, audio: true, cameraMotion: 'none',
            retakeVideoPath: finalPath, retakeStartTime: usedInput.startTime,
            retakeDuration: usedInput.duration, retakeMode: 'replace_audio_and_video',
          },
          takes: [{ url: finalUrl, path: finalPath, createdAt: Date.now() }],
          activeTakeIndex: 0,
        })
        autoNameAsset(currentProjectId, newRetakeAsset.id, usedPrompt, 'video', projectTags, updateAsset)
        setMode('video')
      }
      setActiveRetakeSource(null)
      resetRetake()
    })()
  }, [retakeResult, isRetaking, currentProjectId, currentProject?.assets, activeRetakeSource, addAsset, addTakeToAsset, setPendingRetakeUpdate, resetRetake, activeBin, projectTags, updateAsset])

  useEffect(() => {
    if (!icLoraResult || !currentProjectId || isIcLoraGenerating) return
    const submission = icLoraSubmissionRef.current
    if (!submission) return
    icLoraSubmissionRef.current = null
    ;(async () => {
      const copied = await copyToAssetFolder(icLoraResult.videoPath, currentProjectId)
      const finalPath = copied?.path ?? icLoraResult.videoPath
      const finalUrl = copied?.url ?? icLoraResult.videoUrl
      if (activeIcLoraSource?.assetId) {
        const sourceAsset = currentProject?.assets?.find(a => a.id === activeIcLoraSource.assetId)
        if (sourceAsset) {
          const newTakeIndex = sourceAsset.takes ? sourceAsset.takes.length : 1
          addTakeToAsset(currentProjectId, sourceAsset.id, { url: finalUrl, path: finalPath, createdAt: Date.now() })
          if (activeIcLoraSource.linkedClipIds?.length) {
            setPendingIcLoraUpdate({ assetId: sourceAsset.id, clipIds: activeIcLoraSource.linkedClipIds, newTakeIndex })
          }
        }
      } else {
        const binToAssign = activeBin !== 'all' && activeBin !== 'archived' ? activeBin : undefined
        const newIcLoraAsset = addAsset(currentProjectId, {
          type: 'video', path: finalPath, url: finalUrl, prompt: submission.prompt, resolution: '',
          bin: binToAssign,
          generationParams: {
            mode: 'ic-lora', prompt: submission.prompt, model: 'fast', duration: 0, resolution: '',
            fps: 24, audio: false, cameraMotion: 'none',
            icLoraVideoPath: submission.input.videoPath,
            icLoraConditioningType: submission.input.conditioningType,
            icLoraConditioningStrength: submission.input.conditioningStrength,
          },
          takes: [{ url: finalUrl, path: finalPath, createdAt: Date.now() }], activeTakeIndex: 0,
        })
        autoNameAsset(currentProjectId, newIcLoraAsset.id, submission.prompt, 'video', projectTags, updateAsset)
      }
      setActiveIcLoraSource(null)
    })()
  }, [icLoraResult, isIcLoraGenerating, currentProjectId, currentProject?.assets, activeIcLoraSource, addAsset, addTakeToAsset, setPendingIcLoraUpdate, activeBin, projectTags, updateAsset])

  useEffect(() => {
    if (imageUrls.length > 0 && currentProjectId && !isGenerating) {
      const effectiveImgPrompt = lastPrompt || agentPromptRef.current || ''
      agentPromptRef.current = null
      ;(async () => {
        for (let i = 0; i < imageUrls.length; i++) {
          const imageUrl = imageUrls[i]
          const imgPath = imagePaths[i] || null
          const exists = allGeneratedAssets.some(a => a.url === imageUrl)
          if (!exists) {
            const copied = imgPath ? await copyToAssetFolder(imgPath, currentProjectId) : null
            const finalPath = copied?.path ?? imgPath ?? imageUrl
            const finalUrl = copied?.url ?? imageUrl
            const binToAssign = activeBin !== 'all' && activeBin !== 'archived' ? activeBin : undefined
            const newImgAsset = addAsset(currentProjectId, {
              type: 'image', path: finalPath, url: finalUrl, prompt: effectiveImgPrompt,
              resolution: settings.imageResolution,
              bin: binToAssign,
              generationParams: {
                mode: 'text-to-image', prompt: effectiveImgPrompt, model: 'fast', duration: 5,
                resolution: settings.imageResolution, fps: 24, audio: false, cameraMotion: 'none',
                imageAspectRatio: settings.aspectRatio, imageSteps: 4,
              },
              takes: [{ url: finalUrl, path: finalPath, createdAt: Date.now() }], activeTakeIndex: 0,
            })
            autoNameAsset(currentProjectId, newImgAsset.id, effectiveImgPrompt, 'image', projectTags, updateAsset)
          }
        }
      })()
    }
  }, [imageUrls, imagePaths, currentProjectId, isGenerating]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const handleGenerate = async () => {
    if (mode === 'ic-lora') {
      if (!prompt.trim() || !icLoraInput.videoPath || !icLoraInput.ready) return
      icLoraSubmissionRef.current = {
        prompt, input: { videoPath: icLoraInput.videoPath, conditioningType: icLoraCondType, conditioningStrength: icLoraStrength },
      }
      await submitIcLora({ videoPath: icLoraInput.videoPath, conditioningType: icLoraCondType, conditioningStrength: icLoraStrength, prompt })
      return
    }
    if (mode === 'retake') {
      if (!retakeInput.videoPath || retakeInput.duration < 2) return
      retakeSubmissionRef.current = {
        prompt, input: { videoPath: retakeInput.videoPath, startTime: retakeInput.startTime, duration: retakeInput.duration, videoDuration: retakeInput.videoDuration },
      }
      await submitRetake({ videoPath: retakeInput.videoPath, startTime: retakeInput.startTime, duration: retakeInput.duration, prompt, mode: 'replace_audio_and_video' })
      return
    }
    if (!prompt.trim()) return
    setLastPrompt(prompt)
    if (mode === 'image') {
      generateImage(prompt, {
        model: 'fast' as 'fast' | 'pro', duration: 5, videoResolution: settings.videoResolution, fps: 24, audio: false, cameraMotion: 'none',
        imageModel: (settings.imageModel || 'nano-banana-2') as 'nano-banana-2' | 'z-image-turbo',
        imageResolution: settings.imageResolution, imageAspectRatio: settings.aspectRatio, imageSteps: 4,
        nb2Resolution: settings.nb2Resolution || '1K', variations: settings.variations,
      }, editImages.length > 0 ? editImages.map(img => img.dataUri) : undefined)
    } else {
      const imagePath = inputImage ? fileUrlToPath(inputImage) : null
      const audioPath = inputAudio ? fileUrlToPath(inputAudio) : null
      const videoSettings = applyForcedVideoSettings(settings)
      if (audioPath) videoSettings.model = 'pro'
      generate(prompt, imagePath, {
        model: videoSettings.model as 'fast' | 'pro', duration: videoSettings.duration,
        videoResolution: videoSettings.videoResolution, fps: videoSettings.fps,
        audio: videoSettings.audio || false, cameraMotion: 'none',
        aspectRatio: videoSettings.aspectRatio, imageResolution: videoSettings.imageResolution,
        imageAspectRatio: videoSettings.aspectRatio, imageSteps: 4,
      }, audioPath)
    }
  }

  const handleDelete = (assetId: string) => { if (currentProjectId) deleteAsset(currentProjectId, assetId) }

  const handleDragStart = (e: React.DragEvent, asset: Asset) => {
    e.dataTransfer.setData('asset', JSON.stringify(asset))
    e.dataTransfer.setData('assetId', asset.id)
    e.dataTransfer.effectAllowed = 'copy'
    const img = e.currentTarget.querySelector('img')
    if (img) {
      const dragEl = document.createElement('div')
      dragEl.style.cssText = 'position:fixed;top:-1000px;left:-1000px;width:40px;height:40px;border-radius:6px;overflow:hidden;pointer-events:none;'
      const imgClone = document.createElement('img')
      imgClone.src = img.src
      imgClone.style.cssText = 'width:100%;height:100%;object-fit:cover;'
      dragEl.appendChild(imgClone)
      document.body.appendChild(dragEl)
      e.dataTransfer.setDragImage(dragEl, 20, 20)
      setTimeout(() => document.body.removeChild(dragEl), 0)
    }
  }

  const handleCreateVideo = (imageAsset: Asset) => {
    setMode('video'); setInputImage(imageAsset.url); setPrompt(`${imageAsset.prompt || 'The scene comes to life...'}`)
  }
  const handleRetake = (videoAsset: Asset) => {
    setMode('retake'); setPrompt(''); setActiveRetakeSource(null)
    setRetakeInitial({ videoUrl: videoAsset.url, videoPath: videoAsset.path, duration: videoAsset.duration })
    setRetakePanelKey(p => p + 1)
  }
  const handleIcLora = (videoAsset: Asset) => {
    if (forceApiGenerations) return
    setMode('ic-lora'); setPrompt(''); setActiveIcLoraSource(null)
    setIcLoraInitial({ videoUrl: videoAsset.url, videoPath: videoAsset.path })
    setIcLoraPanelKey(p => p + 1)
  }

  const handleContextMenu = (e: React.MouseEvent, asset: Asset) => {
    e.preventDefault()
    setContextMenu({ asset, position: { x: e.clientX, y: e.clientY } })
  }

  const handleCreateBin = () => {
    if (!currentProjectId) return
    const name = window.prompt('New bin name:')
    if (!name?.trim()) return
    updateBinMeta(currentProjectId, name.trim(), { createdAt: Date.now() })
  }

  const handleRenameBin = (oldName: string) => {
    if (!currentProjectId) return
    const newName = window.prompt('Rename bin:', oldName)
    if (!newName?.trim() || newName.trim() === oldName) return
    renameBinCtx(currentProjectId, oldName, newName.trim())
    if (activeBin === oldName) setActiveBin(newName.trim())
  }

  const handleDeleteBin = (name: string) => {
    if (!currentProjectId) return
    if (!window.confirm(`Delete bin "${name}"? Assets will be moved to "All".`)) return
    deleteBinCtx(currentProjectId, name)
    if (activeBin === name) setActiveBin('all')
  }

  const isRetakeMode = mode === 'retake'
  const isIcLoraMode = mode === 'ic-lora'
  const canSubmit = isRetakeMode
    ? retakeInput.ready && !!retakeInput.videoPath && !isRetaking
    : isIcLoraMode
      ? !!prompt.trim() && icLoraInput.ready && !!icLoraInput.videoPath && !isIcLoraGenerating
      : !!prompt.trim()
  const promptButtonLabel = isRetakeMode ? 'Retake' : 'Generate'
  const promptButtonIcon = isRetakeMode
    ? <Scissors className="h-3.5 w-3.5" />
    : <Sparkles className={`h-3.5 w-3.5 ${isGenerating ? 'animate-pulse' : ''}`} />
  const promptGenerating = isRetakeMode ? isRetaking : isIcLoraMode ? isIcLoraGenerating : isGenerating
  const isLibraryMode = mode === 'video' || mode === 'image'

  return (
    <div className="h-full relative bg-zinc-950 flex">
      {/* Bin Sidebar */}
      {isLibraryMode && (
        <BinSidebar
          bins={bins}
          assets={currentProject?.assets || []}
          activeBin={activeBin}
          onActiveBinChange={setActiveBin}
          onCreateBin={handleCreateBin}
          onRenameBin={handleRenameBin}
          onDeleteBin={handleDeleteBin}
          onSetBinColor={(name, color) => currentProjectId && updateBinMeta(currentProjectId, name, { color })}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      )}

      <div className="flex-1 relative">
        {/* Empty state */}
        {isLibraryMode && allGeneratedAssets.length === 0 && !isGenerating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
            <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-zinc-700 flex items-center justify-center mb-4">
              <Sparkles className="h-10 w-10 text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Start Creating</h3>
            <p className="text-zinc-500 max-w-md">
              Use the prompt bar below to generate images and videos.
              Drag assets into the input box to use them as references.
            </p>
          </div>
        )}

        {/* Assets area */}
        {isLibraryMode && (allGeneratedAssets.length > 0 || isGenerating) && (
          <div className="absolute inset-x-0 top-0 bottom-[160px] flex flex-col px-4 pt-4">
            <FilterSortBar
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              sortMode={sortMode}
              onSortModeChange={setSortMode}
              showFavorites={showFavorites}
              onShowFavoritesChange={setShowFavorites}
              favoriteCount={favoriteCount}
              showArchived={showArchived}
              onShowArchivedChange={setShowArchived}
              gallerySize={gallerySize}
              onGallerySizeChange={setGallerySize}
              imageCount={imageCount}
              videoCount={videoCount}
            />

            <div className="overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] flex-1">
              <div className={`grid ${gallerySizeClasses[gallerySize]} gap-4`}>
                {isGenerating && (
                  <div className="relative rounded-xl overflow-hidden bg-zinc-800 aspect-video">
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="relative w-16 h-16 mb-3">
                        <div className="absolute inset-0 rounded-full border-2 border-violet-500/30" />
                        <div className="absolute inset-0 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
                        <div className="absolute inset-2 rounded-full bg-zinc-800 flex items-center justify-center">
                          <Sparkles className="h-6 w-6 text-violet-400" />
                        </div>
                      </div>
                      <p className="text-sm text-zinc-400">{statusMessage || 'Generating...'}</p>
                      {progress > 0 && (
                        <div className="w-32 h-1 bg-zinc-800 rounded-full mt-2 overflow-hidden">
                          <div className="h-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {filteredAssets.map(asset => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    onDelete={() => handleDelete(asset.id)}
                    onPlay={() => setSelectedAsset(asset)}
                    onDragStart={handleDragStart}
                    onCreateVideo={handleCreateVideo}
                    onRetake={handleRetake}
                    onIcLora={!forceApiGenerations ? handleIcLora : undefined}
                    onToggleFavorite={() => currentProjectId && toggleFavorite(currentProjectId, asset.id)}
                    onUpdateName={(name) => currentProjectId && updateAsset(currentProjectId, asset.id, { name: name || undefined })}
                    onUpdateTags={(tags) => currentProjectId && updateAsset(currentProjectId, asset.id, { tags })}
                    onContextMenu={(e) => handleContextMenu(e, asset)}
                    onArchive={() => currentProjectId && updateAsset(currentProjectId, asset.id, { archived: !asset.archived })}
                    projectTags={projectTags}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {mode === 'retake' && (
          <div className="absolute inset-x-0 top-0 bottom-[160px] px-4 pt-4 pb-4 flex flex-col overflow-hidden">
            <RetakePanel
              initialVideoUrl={retakeInitial.videoUrl}
              initialVideoPath={retakeInitial.videoPath}
              initialDuration={retakeInitial.duration}
              resetKey={retakePanelKey}
              fillHeight
              isProcessing={isRetaking}
              processingStatus={retakeStatus}
              onChange={(data) => setRetakeInput(data)}
            />
          </div>
        )}

        {mode === 'ic-lora' && !forceApiGenerations && (
          <div className="absolute inset-x-0 top-0 bottom-[160px] px-4 pt-4 pb-4 flex flex-col overflow-hidden">
            <ICLoraPanel
              initialVideoUrl={icLoraInitial.videoUrl}
              initialVideoPath={icLoraInitial.videoPath}
              resetKey={icLoraPanelKey}
              fillHeight
              isProcessing={isIcLoraGenerating}
              processingStatus={icLoraStatus}
              conditioningType={icLoraCondType}
              onConditioningTypeChange={setIcLoraCondType}
              conditioningStrength={icLoraStrength}
              onConditioningStrengthChange={setIcLoraStrength}
              outputVideoUrl={icLoraResult?.videoUrl || null}
              outputVideoPath={icLoraResult?.videoPath || null}
              onChange={setIcLoraInput}
            />
          </div>
        )}

        {/* Prompt bar */}
        <div className="absolute bottom-5 left-1/2 w-[min(700px,calc(100%-2rem))] -translate-x-1/2">
          <FreeApiKeyBubble
            forceApiGenerations={forceApiGenerations}
            hasLtxApiKey={appSettings.hasLtxApiKey}
            isGenerating={isGenerating}
          />
          <PromptBar
            mode={mode}
            onModeChange={setMode}
            canUseIcLora={!forceApiGenerations}
            prompt={prompt}
            onPromptChange={setPrompt}
            onGenerate={handleGenerate}
            isGenerating={promptGenerating}
            canGenerate={canSubmit}
            buttonLabel={promptButtonLabel}
            buttonIcon={promptButtonIcon}
            inputImage={inputImage}
            onInputImageChange={setInputImage}
            inputAudio={inputAudio}
            onInputAudioChange={setInputAudio}
            settings={settings}
            onSettingsChange={(nextSettings) => setSettings(applyForcedVideoSettings(nextSettings))}
            shouldVideoGenerateWithLtxApi={shouldVideoGenerateWithLtxApi}
            icLoraCondType={icLoraCondType}
            onIcLoraCondTypeChange={setIcLoraCondType}
            icLoraStrength={icLoraStrength}
            onIcLoraStrengthChange={setIcLoraStrength}
            editImages={editImages}
            onEditImagesChange={setEditImages}
          />
        </div>
      </div>

      {/* Asset preview modal */}
      {selectedAsset && (
        <AssetPreviewModal
          asset={selectedAsset}
          assets={filteredAssets}
          projectTags={projectTags}
          onClose={() => setSelectedAsset(null)}
          onUpdateAsset={(assetId, updates) => {
            if (currentProjectId) updateAsset(currentProjectId, assetId, updates)
          }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <AssetContextMenu
          position={contextMenu.position}
          isFavorite={contextMenu.asset.favorite || false}
          isArchived={contextMenu.asset.archived || false}
          bins={bins}
          currentBin={contextMenu.asset.bin}
          onClose={() => setContextMenu(null)}
          onToggleFavorite={() => {
            if (currentProjectId) toggleFavorite(currentProjectId, contextMenu.asset.id)
          }}
          onArchive={() => {
            if (currentProjectId) updateAsset(currentProjectId, contextMenu.asset.id, { archived: !contextMenu.asset.archived })
          }}
          onMoveToBin={(bin) => {
            if (currentProjectId) updateAsset(currentProjectId, contextMenu.asset.id, { bin })
          }}
          onCreateBin={handleCreateBin}
          onCopyPrompt={() => {
            if (contextMenu.asset.prompt) navigator.clipboard.writeText(contextMenu.asset.prompt)
          }}
          onDownload={() => {
            const a = document.createElement('a')
            a.href = contextMenu.asset.url
            a.download = contextMenu.asset.path.split('/').pop() || `${contextMenu.asset.type}-${contextMenu.asset.id}`
            a.click()
          }}
          onDelete={() => handleDelete(contextMenu.asset.id)}
        />
      )}

      {(error || localError) && (
        <GenerationErrorDialog
          error={(error || localError)!}
          onDismiss={() => {
            if (error) reset()
            if (localError) { setLocalError(null); resetRetake(); resetIcLora() }
          }}
        />
      )}
    </div>
  )
}
