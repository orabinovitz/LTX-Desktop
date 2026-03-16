import { useState } from 'react'
import {
  X,
  FileText,
  ScrollText,
  BookOpen,
  RefreshCw,
  ChevronLeft,
  Trash2,
  Clock,
  Tag,
  Loader2,
} from 'lucide-react'
import { useProjectMemory, type DocumentMeta } from '@/contexts/ProjectMemoryContext'
import { Button } from '@/components/ui/button'

type MemoryTab = 'context' | 'log' | 'documents'

const DOC_TYPE_ICONS: Record<string, string> = {
  script: '📝',
  research: '🔍',
  storyboard: '🎬',
  notes: '📌',
  reference: '📎',
  character_sheet: '👤',
  location_ref: '📍',
  visual_identity: '🎨',
}

const DOC_TYPE_COLORS: Record<string, string> = {
  script: 'text-blue-400',
  research: 'text-green-400',
  storyboard: 'text-purple-400',
  notes: 'text-yellow-400',
  reference: 'text-zinc-400',
  character_sheet: 'text-orange-400',
  location_ref: 'text-teal-400',
  visual_identity: 'text-rose-400',
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso.slice(0, 16)
  }
}

function ContextTab() {
  const { masterContext, updateContext, isLoading } = useProjectMemory()
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')

  const startEdit = () => {
    setEditContent(masterContext)
    setIsEditing(true)
  }

  const saveEdit = async () => {
    await updateContext(editContent)
    setIsEditing(false)
  }

  if (!masterContext && !isEditing) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
        <BookOpen className="h-10 w-10 text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-400 mb-4">
          No project context yet. The AI agent will create one as it works, or you can write one manually.
        </p>
        <Button variant="outline" size="sm" onClick={startEdit}>
          Create Project Context
        </Button>
      </div>
    )
  }

  if (isEditing) {
    return (
      <div className="flex flex-col h-full">
        <textarea
          className="flex-1 w-full bg-zinc-900 text-zinc-200 text-sm p-3 resize-none border-none outline-none font-mono"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          placeholder="Describe the project's creative direction..."
        />
        <div className="flex gap-2 p-3 border-t border-zinc-800">
          <Button variant="outline" size="sm" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={saveEdit} disabled={isLoading}>
            Save
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-zinc-300">
          {masterContext}
        </div>
      </div>
      <div className="p-3 border-t border-zinc-800">
        <Button variant="outline" size="sm" onClick={startEdit} className="w-full">
          Edit Context
        </Button>
      </div>
    </div>
  )
}

function LogTab() {
  const { memoryLog, appendMemoryNote, isLoading } = useProjectMemory()
  const [newNote, setNewNote] = useState('')

  const handleAdd = async () => {
    if (!newNote.trim()) return
    await appendMemoryNote(newNote.trim())
    setNewNote('')
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        {memoryLog ? (
          <div className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
            {memoryLog}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <ScrollText className="h-10 w-10 text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400">
              No memory notes yet. Notes about user preferences and decisions will appear here.
            </p>
          </div>
        )}
      </div>
      <div className="p-3 border-t border-zinc-800">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-zinc-900 text-sm text-zinc-200 rounded-md px-3 py-1.5 border border-zinc-700 outline-none focus:border-zinc-500 placeholder:text-zinc-500"
            placeholder="Add a memory note..."
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleAdd() } }}
          />
          <Button size="sm" onClick={handleAdd} disabled={!newNote.trim() || isLoading}>
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}

function DocumentCard({ doc, onClick }: { doc: DocumentMeta; onClick: () => void }) {
  const colorClass = DOC_TYPE_COLORS[doc.type] || 'text-zinc-400'
  const icon = DOC_TYPE_ICONS[doc.type] || '📄'

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
    >
      <div className="flex items-start gap-2">
        <span className="text-base shrink-0 mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200 truncate">{doc.title}</span>
            <span className="text-xs text-zinc-500 shrink-0">v{doc.version}</span>
          </div>
          {doc.description && (
            <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{doc.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5">
            <span className={`text-xs ${colorClass}`}>{doc.type}</span>
            {doc.tags.length > 0 && (
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {doc.tags.slice(0, 3).join(', ')}
              </span>
            )}
            <span className="text-xs text-zinc-500 flex items-center gap-1 ml-auto">
              <Clock className="h-3 w-3" />
              {formatDate(doc.updated_at)}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}

function DocumentViewer() {
  const { selectedDocument, closeDocument, deleteDocument, isLoading } = useProjectMemory()

  if (!selectedDocument) return null

  const { meta, content } = selectedDocument

  const handleDelete = async () => {
    await deleteDocument(meta.id)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <button onClick={closeDocument} className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate">{meta.title}</div>
          <div className="text-xs text-zinc-500">
            {meta.type} &middot; v{meta.version} &middot; {meta.created_by}
          </div>
        </div>
        <button
          onClick={handleDelete}
          disabled={isLoading}
          className="p-1 rounded hover:bg-red-900/50 text-zinc-500 hover:text-red-400"
          title="Delete document"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-zinc-300">
          {content}
        </div>
      </div>
      {meta.tags.length > 0 && (
        <div className="px-4 py-2 border-t border-zinc-800 flex flex-wrap gap-1.5">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function DocumentsTab() {
  const { documents, openDocument, selectedDocument } = useProjectMemory()
  const [filter, setFilter] = useState('')

  if (selectedDocument) {
    return <DocumentViewer />
  }

  const filtered = filter
    ? documents.filter(
        (d) =>
          d.title.toLowerCase().includes(filter.toLowerCase()) ||
          d.description.toLowerCase().includes(filter.toLowerCase()) ||
          d.tags.some((t) => t.toLowerCase().includes(filter.toLowerCase())),
      )
    : documents

  const sorted = [...filtered].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  )

  return (
    <div className="flex flex-col h-full">
      {documents.length > 3 && (
        <div className="px-3 pt-3">
          <input
            className="w-full bg-zinc-900 text-sm text-zinc-200 rounded-md px-3 py-1.5 border border-zinc-700 outline-none focus:border-zinc-500 placeholder:text-zinc-500"
            placeholder="Search documents..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <FileText className="h-10 w-10 text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400">
              {documents.length === 0
                ? 'No documents yet. The AI agent will save scripts, research, and notes here as it works.'
                : 'No documents match your search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((doc) => (
              <DocumentCard key={doc.id} doc={doc} onClick={() => void openDocument(doc.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function MemoryPanel() {
  const { isPanelOpen, setPanelOpen, refreshMemory, isLoading, documents } = useProjectMemory()
  const [activeTab, setActiveTab] = useState<MemoryTab>('documents')

  if (!isPanelOpen) return null

  const tabs: { id: MemoryTab; label: string; icon: React.ReactNode }[] = [
    { id: 'context', label: 'Context', icon: <BookOpen className="h-3.5 w-3.5" /> },
    { id: 'log', label: 'Log', icon: <ScrollText className="h-3.5 w-3.5" /> },
    { id: 'documents', label: `Docs (${documents.length})`, icon: <FileText className="h-3.5 w-3.5" /> },
  ]

  return (
    <div className="w-80 border-l border-zinc-800 bg-zinc-950 flex flex-col h-full shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">Memory</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refreshMemory()}
            disabled={isLoading}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
            title="Refresh"
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => setPanelOpen(false)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex border-b border-zinc-800">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-white border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'context' && <ContextTab />}
        {activeTab === 'log' && <LogTab />}
        {activeTab === 'documents' && <DocumentsTab />}
      </div>
    </div>
  )
}
