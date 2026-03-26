import { ChevronDown, ChevronUp, Download,FolderOpen, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef,useState } from 'react'

import { logger } from '@/lib/logger'

import { parseLogLine } from '../../shared/logging'
import { Button } from './ui/button'

interface LogViewerProps {
  isOpen: boolean
  onClose: () => void
  embedded?: boolean
}

export function LogViewer({ isOpen, onClose, embedded = false }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [logPath, setLogPath] = useState('')
  const [totalLines, setTotalLines] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [levelFilter, setLevelFilter] = useState<'all' | 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'Backend' | 'Renderer' | 'Electron'>('all')
  const [traceFilter, setTraceFilter] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [taskFilter, setTaskFilter] = useState('')
  const [textFilter, setTextFilter] = useState('')
  const logContainerRef = useRef<HTMLDivElement>(null)

  const fetchLogs = async () => {
    if (!window.electronAPI?.getLogs) return
    
    setIsLoading(true)
    try {
      const result = await window.electronAPI.getLogs({ limit: 2000 })
      setLogs(result.lines || [])
      setLogPath(result.logPath || '')
      setTotalLines(result.totalLines ?? result.lines?.length ?? 0)
    } catch (error) {
      logger.error(`Failed to fetch logs: ${error}`)
    } finally {
      setIsLoading(false)
    }
  }

  const filteredLogs = useMemo(() => {
    const traceNeedle = traceFilter.trim().toLowerCase()
    const sessionNeedle = sessionFilter.trim().toLowerCase()
    const taskNeedle = taskFilter.trim().toLowerCase()
    const textNeedle = textFilter.trim().toLowerCase()

    const matchesStructuredFilters = (line: string): boolean => {
      const parsed = parseLogLine(line)
      if (levelFilter !== 'all' && parsed?.level !== levelFilter) {
        return false
      }
      if (sourceFilter !== 'all' && parsed?.source !== sourceFilter) {
        return false
      }
      if (traceNeedle && !parsed?.context.trace_id?.toLowerCase().includes(traceNeedle)) {
        return false
      }
      if (sessionNeedle && !parsed?.context.agent_session_id?.toLowerCase().includes(sessionNeedle)) {
        return false
      }
      if (taskNeedle && !parsed?.context.task_id?.toLowerCase().includes(taskNeedle)) {
        return false
      }
      if (textNeedle && !line.toLowerCase().includes(textNeedle)) {
        return false
      }
      return true
    }

    const results: string[] = []
    let includeContinuation = false

    for (const line of logs) {
      const parsed = parseLogLine(line)
      if (parsed) {
        includeContinuation = matchesStructuredFilters(line)
        if (includeContinuation) {
          results.push(line)
        }
        continue
      }

      if (includeContinuation) {
        results.push(line)
        continue
      }

      if (
        levelFilter === 'all'
        && sourceFilter === 'all'
        && !traceNeedle
        && !sessionNeedle
        && !taskNeedle
        && (!textNeedle || line.toLowerCase().includes(textNeedle))
      ) {
        results.push(line)
      }
    }

    return results
  }, [levelFilter, logs, sessionFilter, sourceFilter, taskFilter, textFilter, traceFilter])

  useEffect(() => {
    if (isOpen) {
      void fetchLogs()
      // Auto-refresh every 2 seconds when open
      const interval = setInterval(() => {
        void fetchLogs()
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [filteredLogs, autoScroll])

  const handleOpenFolder = async () => {
    if (window.electronAPI?.openLogFolder) {
      await window.electronAPI.openLogFolder()
    }
  }

  const handleDownload = () => {
    const content = filteredLogs.join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = logPath ? logPath.split(/[/\\]/).pop() || 'session.log' : 'session.log'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!isOpen) return null

  const panel = (
    <div className={`bg-zinc-900 rounded-lg border border-zinc-700 w-full ${embedded ? 'h-full' : 'max-w-4xl h-[80vh]'} flex flex-col`}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Logs</h2>
            <span className="text-xs text-zinc-500 font-mono truncate max-w-[300px]" title={logPath}>
              {logPath}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={logs.length === 0}
              className="text-zinc-400 hover:text-white"
              title="Download logs"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenFolder}
              className="text-zinc-400 hover:text-white"
              title="Open log folder"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchLogs}
              disabled={isLoading}
              className="text-zinc-400 hover:text-white"
              title="Refresh logs"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
              className={`${autoScroll ? 'text-blue-400' : 'text-zinc-400'} hover:text-white`}
              title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
            >
              {autoScroll ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
            {!embedded && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-zinc-700 p-3 md:grid-cols-6">
          <select
            value={levelFilter}
            onChange={(event) => setLevelFilter(event.target.value as typeof levelFilter)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
            aria-label="Level"
          >
            <option value="all">All Levels</option>
            <option value="ERROR">Error</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
            <option value="DEBUG">Debug</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
            aria-label="Source"
          >
            <option value="all">All Sources</option>
            <option value="Backend">Backend</option>
            <option value="Renderer">Renderer</option>
            <option value="Electron">Electron</option>
          </select>
          <input
            value={traceFilter}
            onChange={(event) => setTraceFilter(event.target.value)}
            placeholder="Trace ID"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-500"
          />
          <input
            value={sessionFilter}
            onChange={(event) => setSessionFilter(event.target.value)}
            placeholder="Session ID"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-500"
          />
          <input
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value)}
            placeholder="Task ID"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-500"
          />
          <input
            value={textFilter}
            onChange={(event) => setTextFilter(event.target.value)}
            placeholder="Search logs"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-500"
          />
        </div>

        {/* Log content */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-auto p-4 font-mono text-xs bg-black"
        >
          {filteredLogs.length === 0 ? (
            <div className="text-zinc-500 text-center py-8">
              {logs.length === 0 ? 'No logs yet...' : 'No matching logs.'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredLogs.map((line, index) => {
                // Color code log levels
                let lineClass = 'text-zinc-300'
                if (line.includes(' - ERROR - ') || line.includes(' - CRITICAL - ')) {
                  lineClass = 'text-red-400'
                } else if (line.includes(' - WARNING - ')) {
                  lineClass = 'text-yellow-400'
                } else if (line.includes(' - INFO - ')) {
                  lineClass = 'text-blue-300'
                } else if (line.includes(' - DEBUG - ')) {
                  lineClass = 'text-zinc-500'
                }
                
                return (
                  <div key={index} className={`${lineClass} whitespace-pre-wrap break-all`}>
                    {line}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-3 border-t border-zinc-700 text-xs text-zinc-500">
          <span>
            {filteredLogs.length} matching line(s)
            {logs.length > 0 ? ` from ${logs.length} loaded` : ''}
            {totalLines > logs.length ? ` of ${totalLines} total` : ''}
          </span>
          <span>Auto-refreshing every 2s</span>
        </div>
      </div>
  )

  if (embedded) {
    return panel
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      {panel}
    </div>
  )
}
