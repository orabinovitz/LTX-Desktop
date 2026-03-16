import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { backendFetch } from '@/lib/backend'
import { useProjects } from './ProjectContext'
import { logger } from '@/lib/logger'

export interface DocumentMeta {
  id: string
  title: string
  type: 'script' | 'research' | 'storyboard' | 'notes' | 'reference'
  filename: string
  description: string
  created_at: string
  updated_at: string
  version: number
  tags: string[]
  created_by: string
}

export interface MemoryDocument {
  meta: DocumentMeta
  content: string
}

interface ProjectMemoryState {
  documents: DocumentMeta[]
  masterContext: string
  memoryLog: string
  isLoading: boolean
  selectedDocumentId: string | null
  selectedDocument: MemoryDocument | null
  isPanelOpen: boolean
}

interface ProjectMemoryActions {
  refreshMemory: () => Promise<void>
  openDocument: (id: string) => Promise<void>
  closeDocument: () => void
  createDocument: (data: {
    title: string
    type: DocumentMeta['type']
    content: string
    description?: string
    tags?: string[]
  }) => Promise<DocumentMeta>
  updateDocument: (
    id: string,
    data: { content?: string; title?: string; description?: string; tags?: string[] },
  ) => Promise<void>
  deleteDocument: (id: string) => Promise<void>
  updateContext: (content: string) => Promise<void>
  appendMemoryNote: (entry: string) => Promise<void>
  clearMemoryLog: () => Promise<void>
  clearAllMemory: () => Promise<void>
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
}

type ProjectMemoryContextType = ProjectMemoryState & ProjectMemoryActions

const ProjectMemoryContext = createContext<ProjectMemoryContextType | null>(null)

export function ProjectMemoryProvider({ children }: { children: ReactNode }) {
  const { currentProject } = useProjects()
  const projectId = currentProject?.id ?? null

  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [masterContext, setMasterContext] = useState('')
  const [memoryLog, setMemoryLog] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<MemoryDocument | null>(null)
  const [isPanelOpen, setIsPanelOpen] = useState(false)

  const refreshMemory = useCallback(async () => {
    if (!projectId) return
    setIsLoading(true)
    try {
      const [manifestRes, contextRes, logRes] = await Promise.all([
        backendFetch(`/api/agent/memory/${projectId}`),
        backendFetch(`/api/agent/memory/${projectId}/context`),
        backendFetch(`/api/agent/memory/${projectId}/log`),
      ])

      if (manifestRes.ok) {
        const manifest = (await manifestRes.json()) as { documents: DocumentMeta[] }
        setDocuments(manifest.documents ?? [])
      }
      if (contextRes.ok) {
        const ctx = (await contextRes.json()) as { content: string }
        setMasterContext(ctx.content ?? '')
      }
      if (logRes.ok) {
        const log = (await logRes.json()) as { content: string }
        setMemoryLog(log.content ?? '')
      }
    } catch (e) {
      logger.error(`Failed to refresh project memory: ${e}`)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (projectId) {
      void refreshMemory()
    } else {
      setDocuments([])
      setMasterContext('')
      setMemoryLog('')
      setSelectedDocumentId(null)
      setSelectedDocument(null)
    }
  }, [projectId, refreshMemory])

  useEffect(() => {
    const handler = () => {
      if (projectId) void refreshMemory()
    }
    window.addEventListener('agent-action-complete', handler)
    window.addEventListener('memory-updated', handler)
    return () => {
      window.removeEventListener('agent-action-complete', handler)
      window.removeEventListener('memory-updated', handler)
    }
  }, [projectId, refreshMemory])

  const openDocument = useCallback(
    async (id: string) => {
      if (!projectId) return
      setSelectedDocumentId(id)
      try {
        const res = await backendFetch(`/api/agent/memory/${projectId}/document/${id}`)
        if (res.ok) {
          const doc = (await res.json()) as MemoryDocument
          setSelectedDocument(doc)
        }
      } catch (e) {
        logger.error(`Failed to open document: ${e}`)
      }
    },
    [projectId],
  )

  const closeDocument = useCallback(() => {
    setSelectedDocumentId(null)
    setSelectedDocument(null)
  }, [])

  const createDocument = useCallback(
    async (data: {
      title: string
      type: DocumentMeta['type']
      content: string
      description?: string
      tags?: string[]
    }) => {
      if (!projectId) throw new Error('No active project')
      const res = await backendFetch(`/api/agent/memory/${projectId}/document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...data }),
      })
      if (!res.ok) throw new Error(`Failed to create document: ${res.status}`)
      const meta = (await res.json()) as DocumentMeta
      await refreshMemory()
      return meta
    },
    [projectId, refreshMemory],
  )

  const updateDocument = useCallback(
    async (
      id: string,
      data: { content?: string; title?: string; description?: string; tags?: string[] },
    ) => {
      if (!projectId) return
      const res = await backendFetch(`/api/agent/memory/${projectId}/document/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, document_id: id, ...data }),
      })
      if (!res.ok) throw new Error(`Failed to update document: ${res.status}`)
      await refreshMemory()
      if (selectedDocumentId === id) {
        await openDocument(id)
      }
    },
    [projectId, refreshMemory, selectedDocumentId, openDocument],
  )

  const deleteDocument = useCallback(
    async (id: string) => {
      if (!projectId) return
      const res = await backendFetch(`/api/agent/memory/${projectId}/document/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`Failed to delete document: ${res.status}`)
      if (selectedDocumentId === id) {
        closeDocument()
      }
      await refreshMemory()
    },
    [projectId, refreshMemory, selectedDocumentId, closeDocument],
  )

  const updateContext = useCallback(
    async (content: string) => {
      if (!projectId) return
      await backendFetch(`/api/agent/memory/${projectId}/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, content }),
      })
      setMasterContext(content)
    },
    [projectId],
  )

  const appendMemoryNote = useCallback(
    async (entry: string) => {
      if (!projectId) return
      await backendFetch(`/api/agent/memory/${projectId}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, entry }),
      })
      await refreshMemory()
    },
    [projectId, refreshMemory],
  )

  const clearMemoryLog = useCallback(async () => {
    if (!projectId) return
    const res = await backendFetch(`/api/agent/memory/${projectId}/log`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`Failed to clear memory log: ${res.status}`)
    setMemoryLog('')
  }, [projectId])

  const clearAllMemory = useCallback(async () => {
    if (!projectId) return
    const res = await backendFetch(`/api/agent/memory/${projectId}/all`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`Failed to clear all memory: ${res.status}`)
    setDocuments([])
    setMasterContext('')
    setMemoryLog('')
    setSelectedDocumentId(null)
    setSelectedDocument(null)
  }, [projectId])

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => !prev)
  }, [])

  const value = useMemo<ProjectMemoryContextType>(
    () => ({
      documents,
      masterContext,
      memoryLog,
      isLoading,
      selectedDocumentId,
      selectedDocument,
      isPanelOpen,
      refreshMemory,
      openDocument,
      closeDocument,
      createDocument,
      updateDocument,
      deleteDocument,
      updateContext,
      appendMemoryNote,
      clearMemoryLog,
      clearAllMemory,
      setPanelOpen: setIsPanelOpen,
      togglePanel,
    }),
    [
      documents,
      masterContext,
      memoryLog,
      isLoading,
      selectedDocumentId,
      selectedDocument,
      isPanelOpen,
      refreshMemory,
      openDocument,
      closeDocument,
      createDocument,
      updateDocument,
      deleteDocument,
      updateContext,
      appendMemoryNote,
      clearMemoryLog,
      clearAllMemory,
      togglePanel,
    ],
  )

  return <ProjectMemoryContext.Provider value={value}>{children}</ProjectMemoryContext.Provider>
}

export function useProjectMemory() {
  const ctx = useContext(ProjectMemoryContext)
  if (!ctx) throw new Error('useProjectMemory must be used within ProjectMemoryProvider')
  return ctx
}
