import { useState, useEffect, useRef } from "react";
import {
  Loader2,
  CheckCircle2,
  Download,
  Clock,
  ChevronDown,
  AlertCircle,
} from "lucide-react";

interface ModelInfo {
  name: string;
  description: string;
  downloaded: boolean;
  size: number;
  expected_size: number;
  is_folder?: boolean;
  required?: boolean;
}

interface ModelsStatus {
  models: ModelInfo[];
  all_downloaded: boolean;
  total_size: number;
  downloaded_size: number;
  total_size_gb: number;
  downloaded_size_gb: number;
}

interface ModelDownloadProgress {
  status: "idle" | "downloading" | "complete" | "error";
  currentFile: string;
  currentFileProgress: number;
  totalProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  filesCompleted: number;
  totalFiles: number;
  error: string | null;
  speedMbps: number;
}

interface ModelStatusDropdownProps {
  className?: string;
}

export function ModelStatusDropdown({
  className = "",
}: ModelStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<ModelDownloadProgress | null>(null);
  const [backendUrl, setBackendUrl] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch backend URL once on mount
  useEffect(() => {
    window.electronAPI.getBackendUrl().then(setBackendUrl);
  }, []);

  // Fetch models status periodically
  useEffect(() => {
    if (!backendUrl) return;

    const fetchModelsStatus = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/models/status`);
        if (response.ok) {
          setModelsStatus(await response.json());
        }
      } catch (e) {
        console.error("Failed to fetch models status:", e);
      }
    };

    fetchModelsStatus();
    const interval = setInterval(fetchModelsStatus, 5000);
    return () => clearInterval(interval);
  }, [backendUrl]);

  // Poll download progress when downloading
  useEffect(() => {
    if (!isOpen || !backendUrl) return;

    const pollProgress = async () => {
      try {
        const response = await fetch(
          `${backendUrl}/api/models/download/progress`,
        );
        if (response.ok) {
          setDownloadProgress(await response.json());
        }
      } catch (e) {
        console.error("Failed to fetch download progress:", e);
      }
    };

    pollProgress();
    const interval = setInterval(pollProgress, 1000);
    return () => clearInterval(interval);
  }, [isOpen, backendUrl]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const isDownloading = downloadProgress?.status === "downloading";
  const isPending = !modelsStatus?.all_downloaded;
  const isReady = modelsStatus?.all_downloaded === true;
  const hasError = downloadProgress?.status === "error";

  // Format bytes to human-readable
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(1)} KB`;
  };

  // Format time remaining
  const formatTimeRemaining = (
    bytesRemaining: number,
    speedMbps: number,
  ): string => {
    if (speedMbps <= 0) return "Calculating...";
    const secondsRemaining = bytesRemaining / 1e6 / speedMbps;
    if (secondsRemaining < 60) return `${Math.ceil(secondsRemaining)}s`;
    if (secondsRemaining < 3600) return `${Math.ceil(secondsRemaining / 60)}m`;
    return `${(secondsRemaining / 3600).toFixed(1)}h`;
  };

  // Get status label
  const getStatusLabel = (): string => {
    if (hasError) return "Error";
    if (isDownloading)
      return `Downloading... ${downloadProgress?.totalProgress || 0}%`;
    if (isReady) return "Ready";
    if (isPending) return "Models needed";
    return "Checking...";
  };

  const startDownload = async () => {
    if (!backendUrl) return;
    try {
      await fetch(`${backendUrl}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.error("Failed to start download:", e);
    }
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Status Badge - Clickable */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 transition-all ${
          hasError
            ? "bg-red-500/20 hover:bg-red-500/30"
            : isReady
              ? "bg-green-500/10 hover:bg-green-500/20"
              : isPending
                ? "bg-zinc-800 hover:bg-zinc-700"
                : "bg-zinc-800 hover:bg-zinc-700"
        } `}
      >
        {isDownloading && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
        )}
        {isReady && !isDownloading && (
          <div className="h-2 w-2 rounded-full bg-green-500" />
        )}
        {isPending && !isDownloading && !isReady && (
          <Download className="h-3.5 w-3.5 text-zinc-400" />
        )}
        {hasError && <AlertCircle className="h-3.5 w-3.5 text-red-400" />}

        <span
          className={`text-xs font-medium ${
            hasError
              ? "text-red-400"
              : isReady
                ? "text-green-400"
                : isPending
                  ? "text-zinc-300"
                  : "text-zinc-300"
          }`}
        >
          {getStatusLabel()}
        </span>

        {isDownloading && (
          <span className="text-xs font-semibold text-blue-400">
            {downloadProgress?.totalProgress || 0}%
          </span>
        )}

        <ChevronDown
          className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-96 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
          {/* Header */}
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Model Status</h3>
              {modelsStatus && (
                <span className="text-xs text-zinc-500">
                  {modelsStatus.downloaded_size_gb.toFixed(1)} /{" "}
                  {modelsStatus.total_size_gb.toFixed(1)} GB
                </span>
              )}
            </div>
          </div>

          {/* Download Progress (if downloading) */}
          {isDownloading && downloadProgress && (
            <div className="border-b border-zinc-800 bg-blue-500/5 px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-blue-300">
                  Downloading
                </span>
                <span className="text-xs text-blue-400">
                  {downloadProgress.speedMbps.toFixed(1)} MB/s
                </span>
              </div>

              {/* Progress bar */}
              <div className="mb-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 via-blue-500 to-blue-500 transition-all duration-300"
                  style={{ width: `${downloadProgress.totalProgress}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span className="mr-2 flex-1 truncate">
                  {downloadProgress.currentFile}
                </span>
                <div className="flex items-center gap-2">
                  <Clock className="h-3 w-3" />
                  <span>
                    {formatTimeRemaining(
                      downloadProgress.totalBytes -
                        downloadProgress.downloadedBytes,
                      downloadProgress.speedMbps,
                    )}
                  </span>
                </div>
              </div>

              <div className="mt-1 text-xs text-zinc-600">
                {downloadProgress.filesCompleted} /{" "}
                {downloadProgress.totalFiles} files complete
              </div>
            </div>
          )}

          {/* Model List */}
          <div className="max-h-64 overflow-y-auto">
            {modelsStatus?.models
              .filter((m) => m.required)
              .map((model, index, arr) => (
                <div
                  key={model.name}
                  className={`flex items-center gap-3 px-4 py-3 ${
                    index !== arr.length - 1
                      ? "border-b border-zinc-800/50"
                      : ""
                  }`}
                >
                  {model.downloaded ? (
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-500" />
                  ) : (
                    <Download className="h-4 w-4 flex-shrink-0 text-zinc-600" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {model.name}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {model.description}
                    </div>
                  </div>

                  <div className="flex-shrink-0 text-right">
                    <div
                      className={`text-xs ${model.downloaded ? "text-green-400" : "text-zinc-600"}`}
                    >
                      {model.downloaded ? "Ready" : "Needed"}
                    </div>
                    <div className="text-xs text-zinc-600">
                      {formatBytes(model.expected_size)}
                    </div>
                  </div>
                </div>
              ))}
          </div>

          {/* Footer Actions */}
          {isPending && !isDownloading && (
            <div className="border-t border-zinc-800 bg-zinc-800/30 px-4 py-3">
              <button
                onClick={startDownload}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                <Download className="h-4 w-4" />
                Download Missing Models
              </button>
            </div>
          )}

          {/* Error State */}
          {downloadProgress?.error && (
            <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-3">
              <div className="text-xs text-red-400">
                {downloadProgress.error}
              </div>
              <button
                onClick={startDownload}
                className="mt-2 text-xs text-red-300 underline hover:text-red-200"
              >
                Retry Download
              </button>
            </div>
          )}

          {/* All Ready */}
          {isReady && (
            <div className="border-t border-zinc-800 bg-green-500/5 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                <span>All models ready</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
