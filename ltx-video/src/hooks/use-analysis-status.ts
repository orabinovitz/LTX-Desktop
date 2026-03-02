import { useCallback, useEffect, useRef, useState } from "react";

export type AnalysisStatus = "analyzing" | "complete" | "failed";

export function useAnalysisStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, AnalysisStatus>>(
    new Map(),
  );
  const pollingRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const markAnalyzing = useCallback((assetId: string) => {
    pollingRef.current.add(assetId);
    setStatusMap((prev) => {
      const next = new Map(prev);
      next.set(assetId, "analyzing");
      return next;
    });
  }, []);

  useEffect(() => {
    const poll = async () => {
      const ids = [...pollingRef.current];
      if (ids.length === 0) return;

      for (const assetId of ids) {
        try {
          const backendUrl = await window.electronAPI.getBackendUrl();
          const res = await fetch(
            `${backendUrl}/api/agent/video-metadata/${assetId}`,
          );
          if (!res.ok) continue;
          const data = await res.json();
          const status = data.analysis_status as string | undefined;

          if (status === "complete" || status === "failed") {
            pollingRef.current.delete(assetId);
            setStatusMap((prev) => {
              const next = new Map(prev);
              next.set(assetId, status as AnalysisStatus);
              return next;
            });
          }
        } catch {
          // Network error — keep polling
        }
      }
    };

    intervalRef.current = setInterval(poll, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { statusMap, markAnalyzing };
}
