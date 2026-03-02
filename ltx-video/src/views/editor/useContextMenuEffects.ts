import { useEffect, useCallback } from "react";

interface TimelineContextMenu {
  timelineId: string;
  x: number;
  y: number;
}
interface ClipContextMenu {
  clipId: string;
  x: number;
  y: number;
}
interface AssetContextMenu {
  assetId: string;
  x: number;
  y: number;
}
interface TakeContextMenu {
  assetId: string;
  takeIndex: number;
  x: number;
  y: number;
}
interface BinContextMenu {
  bin: string;
  x: number;
  y: number;
}

interface UseContextMenuEffectsParams {
  timelineContextMenu: TimelineContextMenu | null;
  setTimelineContextMenu: React.Dispatch<
    React.SetStateAction<TimelineContextMenu | null>
  >;
  timelineContextMenuRef: React.RefObject<HTMLDivElement>;
  clipContextMenu: ClipContextMenu | null;
  setClipContextMenu: React.Dispatch<
    React.SetStateAction<ClipContextMenu | null>
  >;
  clipContextMenuRef: React.RefObject<HTMLDivElement>;
  assetContextMenu: AssetContextMenu | null;
  setAssetContextMenu: React.Dispatch<
    React.SetStateAction<AssetContextMenu | null>
  >;
  assetContextMenuRef: React.RefObject<HTMLDivElement>;
  takeContextMenu: TakeContextMenu | null;
  setTakeContextMenu: React.Dispatch<
    React.SetStateAction<TakeContextMenu | null>
  >;
  takeContextMenuRef: React.RefObject<HTMLDivElement>;
  binContextMenu: BinContextMenu | null;
  setBinContextMenu: React.Dispatch<
    React.SetStateAction<BinContextMenu | null>
  >;
  binContextMenuRef: React.RefObject<HTMLDivElement>;
  previewZoomOpen: boolean;
  setPreviewZoomOpen: (v: boolean) => void;
  playbackResOpen: boolean;
  setPlaybackResOpen: (v: boolean) => void;
  previewZoom: number | "fit";
  setPreviewZoom: React.Dispatch<React.SetStateAction<number | "fit">>;
  setPreviewPan: (v: { x: number; y: number }) => void;
  previewContainerRef: React.RefObject<HTMLDivElement>;
  setIsFullscreen: (v: boolean) => void;
  setVideoFrameSize: React.Dispatch<
    React.SetStateAction<{ width: number; height: number }>
  >;
  timelineAddMenuOpen: boolean;
  setTimelineAddMenuOpen: (v: boolean) => void;
  creatingBin: boolean;
  newBinInputRef: React.RefObject<HTMLInputElement>;
}

export function useContextMenuEffects(params: UseContextMenuEffectsParams) {
  const {
    timelineContextMenu,
    setTimelineContextMenu,
    timelineContextMenuRef,
    clipContextMenu,
    setClipContextMenu,
    clipContextMenuRef,
    assetContextMenu,
    setAssetContextMenu,
    assetContextMenuRef,
    takeContextMenu,
    setTakeContextMenu,
    takeContextMenuRef,
    binContextMenu,
    setBinContextMenu,
    binContextMenuRef,
    previewZoomOpen,
    setPreviewZoomOpen,
    playbackResOpen,
    setPlaybackResOpen,
    previewZoom,
    setPreviewZoom,
    setPreviewPan,
    previewContainerRef,
    setIsFullscreen,
    setVideoFrameSize,
    timelineAddMenuOpen,
    setTimelineAddMenuOpen,
    creatingBin,
    newBinInputRef,
  } = params;

  // Close timeline context menu on click elsewhere
  useEffect(() => {
    if (!timelineContextMenu) return;
    const handler = () => setTimelineContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [timelineContextMenu, setTimelineContextMenu]);

  // Adjust timeline context menu position to stay within viewport
  useEffect(() => {
    if (!timelineContextMenu || !timelineContextMenuRef.current) return;
    const el = timelineContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = timelineContextMenu;
    let adjusted = false;

    if (rect.right > vw - 8) {
      x = vw - rect.width - 8;
      adjusted = true;
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8;
      adjusted = true;
    }
    if (x < 8) {
      x = 8;
      adjusted = true;
    }
    if (y < 8) {
      y = 8;
      adjusted = true;
    }

    if (adjusted) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [timelineContextMenu, timelineContextMenuRef]);

  // Close clip context menu on click elsewhere
  useEffect(() => {
    if (!clipContextMenu) return;
    const handler = () => setClipContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [clipContextMenu, setClipContextMenu]);

  // Adjust context menu position to stay within viewport
  useEffect(() => {
    if (!clipContextMenu || !clipContextMenuRef.current) return;
    const el = clipContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = clipContextMenu;
    let adjusted = false;

    if (rect.right > vw - 8) {
      x = vw - rect.width - 8;
      adjusted = true;
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8;
      adjusted = true;
    }
    if (x < 8) {
      x = 8;
      adjusted = true;
    }
    if (y < 8) {
      y = 8;
      adjusted = true;
    }

    if (adjusted) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [clipContextMenu, clipContextMenuRef]);

  // Close zoom dropdown on click outside
  // Defer listener attachment by one frame to avoid catching the same click that opened it
  useEffect(() => {
    if (!previewZoomOpen) return;
    const handler = () => setPreviewZoomOpen(false);
    const raf = requestAnimationFrame(() => {
      window.addEventListener("click", handler);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("click", handler);
    };
  }, [previewZoomOpen, setPreviewZoomOpen]);

  // Close playback resolution dropdown on click outside
  useEffect(() => {
    if (!playbackResOpen) return;
    const handler = () => setPlaybackResOpen(false);
    const raf = requestAnimationFrame(() => {
      window.addEventListener("click", handler);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("click", handler);
    };
  }, [playbackResOpen, setPlaybackResOpen]);

  // Reset pan when switching to fit
  useEffect(() => {
    if (previewZoom === "fit") setPreviewPan({ x: 0, y: 0 });
  }, [previewZoom, setPreviewPan]);

  // Fullscreen toggle for preview
  const toggleFullscreen = useCallback(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, [previewContainerRef]);

  // Track fullscreen state changes (user can exit via Esc too)
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [setIsFullscreen]);

  // Populate fullscreen ref for keyboard handler

  // Mouse wheel zoom on preview
  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPreviewZoom((prev) => {
        const current = prev === "fit" ? 100 : prev;
        const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = Math.round(Math.min(1600, Math.max(10, current * delta)));
        return next;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [previewContainerRef, setPreviewZoom]);

  // Observe preview container size → compute video frame dimensions (16:9 "contain" fit)
  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    const PROJECT_RATIO = 16 / 9;
    const compute = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      let fw: number, fh: number;
      if (width / height > PROJECT_RATIO) {
        // Container is wider → height is the constraint
        fh = height;
        fw = height * PROJECT_RATIO;
      } else {
        // Container is taller → width is the constraint
        fw = width;
        fh = width / PROJECT_RATIO;
      }
      setVideoFrameSize((prev) =>
        prev.width === fw && prev.height === fh
          ? prev
          : { width: fw, height: fh },
      );
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [previewContainerRef, setVideoFrameSize]);

  // Close asset context menu on click elsewhere
  useEffect(() => {
    if (!assetContextMenu) return;
    const handler = () => setAssetContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [assetContextMenu, setAssetContextMenu]);

  // Close timeline add menu on click elsewhere
  useEffect(() => {
    if (!timelineAddMenuOpen) return;
    const handler = () => setTimelineAddMenuOpen(false);
    // Delay so the toggle click itself doesn't immediately close
    const timer = setTimeout(
      () => window.addEventListener("click", handler),
      0,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handler);
    };
  }, [timelineAddMenuOpen, setTimelineAddMenuOpen]);

  // Adjust asset context menu position to stay within viewport
  useEffect(() => {
    if (!assetContextMenu || !assetContextMenuRef.current) return;
    const el = assetContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = assetContextMenu;
    let adjusted = false;
    if (rect.right > vw - 8) {
      x = vw - rect.width - 8;
      adjusted = true;
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8;
      adjusted = true;
    }
    if (x < 8) {
      x = 8;
      adjusted = true;
    }
    if (y < 8) {
      y = 8;
      adjusted = true;
    }
    if (adjusted) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [assetContextMenu, assetContextMenuRef]);

  // Close take context menu on click elsewhere
  useEffect(() => {
    if (!takeContextMenu) return;
    const handler = () => setTakeContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [takeContextMenu, setTakeContextMenu]);

  // Adjust take context menu position
  useEffect(() => {
    if (!takeContextMenu || !takeContextMenuRef.current) return;
    const el = takeContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = takeContextMenu;
    let adjusted = false;
    if (rect.right > vw - 8) {
      x = vw - rect.width - 8;
      adjusted = true;
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8;
      adjusted = true;
    }
    if (x < 8) {
      x = 8;
      adjusted = true;
    }
    if (y < 8) {
      y = 8;
      adjusted = true;
    }
    if (adjusted) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [takeContextMenu, takeContextMenuRef]);

  // Close bin context menu on click elsewhere
  useEffect(() => {
    if (!binContextMenu) return;
    const handler = () => setBinContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [binContextMenu, setBinContextMenu]);

  // Adjust bin context menu position to stay within viewport
  useEffect(() => {
    if (!binContextMenu || !binContextMenuRef.current) return;
    const el = binContextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = binContextMenu;
    let adjusted = false;
    if (rect.right > vw - 8) {
      x = vw - rect.width - 8;
      adjusted = true;
    }
    if (rect.bottom > vh - 8) {
      y = vh - rect.height - 8;
      adjusted = true;
    }
    if (x < 8) {
      x = 8;
      adjusted = true;
    }
    if (y < 8) {
      y = 8;
      adjusted = true;
    }
    if (adjusted) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [binContextMenu, binContextMenuRef]);

  // Focus new bin input when creating
  useEffect(() => {
    if (creatingBin) {
      setTimeout(() => newBinInputRef.current?.focus(), 0);
    }
  }, [creatingBin, newBinInputRef]);

  return { toggleFullscreen };
}
