import { useState, useEffect, useRef } from "react";
import {
  X,
  FolderOpen,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Download,
} from "lucide-react";
import { Button } from "./ui/button";

interface LogViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogViewer({ isOpen, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [logPath, setLogPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    if (!window.electronAPI?.getLogs) return;

    setIsLoading(true);
    try {
      const result = await window.electronAPI.getLogs();
      setLogs(result.lines || []);
      setLogPath(result.logPath || "");
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
      // Auto-refresh every 2 seconds when open
      const interval = setInterval(fetchLogs, 2000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleOpenFolder = async () => {
    if (window.electronAPI?.openLogFolder) {
      await window.electronAPI.openLogFolder();
    }
  };

  const handleDownload = () => {
    const content = logs.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = logPath
      ? logPath.split(/[/\\]/).pop() || "backend.log"
      : "backend.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="flex h-[80vh] w-full max-w-4xl flex-col rounded-lg border border-zinc-700 bg-zinc-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 p-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Backend Logs</h2>
            <span
              className="max-w-[300px] truncate font-mono text-xs text-zinc-500"
              title={logPath}
            >
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
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
              className={`${autoScroll ? "text-blue-400" : "text-zinc-400"} hover:text-white`}
              title={
                autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"
              }
            >
              {autoScroll ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-zinc-400 hover:text-white"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Log content */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-auto bg-black p-4 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <div className="py-8 text-center text-zinc-500">No logs yet...</div>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, index) => {
                // Color code log levels
                let lineClass = "text-zinc-300";
                if (
                  line.includes(" - ERROR - ") ||
                  line.includes(" - CRITICAL - ")
                ) {
                  lineClass = "text-red-400";
                } else if (line.includes(" - WARNING - ")) {
                  lineClass = "text-yellow-400";
                } else if (line.includes(" - INFO - ")) {
                  lineClass = "text-blue-300";
                } else if (line.includes(" - DEBUG - ")) {
                  lineClass = "text-zinc-500";
                }

                return (
                  <div
                    key={index}
                    className={`${lineClass} whitespace-pre-wrap break-all`}
                  >
                    {line}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-700 p-3 text-xs text-zinc-500">
          <span>{logs.length} lines (last 200)</span>
          <span>Auto-refreshing every 2s</span>
        </div>
      </div>
    </div>
  );
}
