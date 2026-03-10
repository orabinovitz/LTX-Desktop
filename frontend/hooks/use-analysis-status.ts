import { useCallback, useEffect, useRef, useState } from "react";

export type AnalysisStatus = "analyzing" | "complete" | "failed";

export function useAnalysisStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, AnalysisStatus>>(
    new Map(),
  );
  const pollingRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backendUrlRef = useRef<string | null>(null);

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

      if (!backendUrlRef.current) {
        backendUrlRef.current = await window.electronAPI.getBackendUrl();
      }
      const backendUrl = backendUrlRef.current;

      const results = await Promise.allSettled(
        ids.map(async (assetId) => {
          const res = await fetch(
            `${backendUrl}/api/agent/video-metadata/${assetId}`,
          );
          if (!res.ok) return null;
          const data = await res.json();
          return { assetId, status: data.analysis_status as string | undefined };
        }),
      );

      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value) continue;
        const { assetId, status } = result.value;
        if (status === "complete" || status === "failed") {
          pollingRef.current.delete(assetId);
          setStatusMap((prev) => {
            const next = new Map(prev);
            next.set(assetId, status as AnalysisStatus);
            return next;
          });
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
