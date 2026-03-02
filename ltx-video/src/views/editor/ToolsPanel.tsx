import React from "react";
import { Magnet, Type } from "lucide-react";
import { PRIMARY_TOOLS, TRIM_TOOLS, ToolType } from "./video-editor-utils";
import { getShortcutLabel, type KeyboardLayout } from "./video-editor-utils";
import { Tooltip } from "@/components/ui/tooltip";

interface ToolsPanelProps {
  activeTool: ToolType;
  setActiveTool: (t: ToolType) => void;
  lastTrimTool: ToolType;
  setLastTrimTool: (t: ToolType) => void;
  showTrimFlyout: boolean;
  setShowTrimFlyout: (v: boolean) => void;
  trimFlyoutOpenedRef: React.MutableRefObject<boolean>;
  trimLongPressRef: React.MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
  snapEnabled: boolean;
  setSnapEnabled: (v: boolean) => void;
  showEffectsBrowser: boolean;
  setShowEffectsBrowser: (v: boolean) => void;
  addTextClip: () => void;
  kbLayout: KeyboardLayout;
}

export function ToolsPanel({
  activeTool,
  setActiveTool,
  lastTrimTool,
  setLastTrimTool,
  showTrimFlyout,
  setShowTrimFlyout,
  trimFlyoutOpenedRef,
  trimLongPressRef,
  snapEnabled,
  setSnapEnabled,
  showEffectsBrowser: _showEffectsBrowser, // eslint-disable-line @typescript-eslint/no-unused-vars -- EFFECTS HIDDEN: kept for future re-enable
  setShowEffectsBrowser: _setShowEffectsBrowser, // eslint-disable-line @typescript-eslint/no-unused-vars -- EFFECTS HIDDEN: kept for future re-enable
  addTextClip,
  kbLayout,
}: ToolsPanelProps) {
  return (
    <div className="flex w-10 flex-shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-zinc-800 bg-zinc-900 py-1">
      {PRIMARY_TOOLS.map((tool) => (
        <Tooltip
          key={tool.id}
          side="right"
          content={
            <>
              {tool.label}{" "}
              <span className="text-zinc-400">
                ({getShortcutLabel(kbLayout, tool.actionId)})
              </span>
            </>
          }
        >
          <button
            onClick={() => setActiveTool(tool.id)}
            className={`flex-shrink-0 rounded-lg p-1.5 transition-colors ${
              activeTool === tool.id
                ? "bg-blue-600 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            <tool.icon className="h-4 w-4" />
          </button>
        </Tooltip>
      ))}

      {/* Trim tools group button */}
      {(() => {
        const trimToolIds = new Set(TRIM_TOOLS.map((t) => t.id));
        const isTrimActive = trimToolIds.has(activeTool);
        const currentTrimTool =
          TRIM_TOOLS.find(
            (t) => t.id === (isTrimActive ? activeTool : lastTrimTool),
          ) || TRIM_TOOLS[0];
        return (
          <div className="relative flex-shrink-0">
            <Tooltip
              side="right"
              content={
                <>
                  {currentTrimTool.label}{" "}
                  <span className="text-zinc-400">
                    ({getShortcutLabel(kbLayout, currentTrimTool.actionId)}) —
                    right-click or hold for more
                  </span>
                </>
              }
            >
              <button
                onClick={() => {
                  if (trimFlyoutOpenedRef.current) {
                    trimFlyoutOpenedRef.current = false;
                    return;
                  }
                  setActiveTool(currentTrimTool.id);
                  setLastTrimTool(currentTrimTool.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (trimLongPressRef.current) {
                    clearTimeout(trimLongPressRef.current);
                    trimLongPressRef.current = null;
                  }
                  trimFlyoutOpenedRef.current = true;
                  setShowTrimFlyout(true);
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  trimFlyoutOpenedRef.current = false;
                  trimLongPressRef.current = setTimeout(() => {
                    trimLongPressRef.current = null;
                    trimFlyoutOpenedRef.current = true;
                    setShowTrimFlyout(true);
                  }, 400);
                }}
                onMouseUp={() => {
                  if (trimLongPressRef.current) {
                    clearTimeout(trimLongPressRef.current);
                    trimLongPressRef.current = null;
                  }
                }}
                onMouseLeave={() => {
                  if (trimLongPressRef.current) {
                    clearTimeout(trimLongPressRef.current);
                    trimLongPressRef.current = null;
                  }
                }}
                data-trim-group-btn=""
                className={`relative rounded-lg p-1.5 transition-colors ${
                  isTrimActive
                    ? "bg-blue-600 text-white"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                <currentTrimTool.icon className="h-4 w-4" />
                <div className="absolute bottom-0 right-0 h-0 w-0 border-b-[4px] border-l-[4px] border-b-current border-l-transparent opacity-60" />
              </button>
            </Tooltip>
            {showTrimFlyout &&
              (() => {
                const btnEl = document.querySelector("[data-trim-group-btn]");
                const rect = btnEl?.getBoundingClientRect();
                return (
                  <>
                    <div
                      className="fixed inset-0 z-[9998]"
                      onMouseDown={() => setShowTrimFlyout(false)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setShowTrimFlyout(false);
                      }}
                    />
                    <div
                      className="fixed z-[9999] min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
                      style={{
                        top: rect?.top ?? 0,
                        left: (rect?.right ?? 44) + 4,
                      }}
                    >
                      {TRIM_TOOLS.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => {
                            setActiveTool(t.id);
                            setLastTrimTool(t.id);
                            setShowTrimFlyout(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            activeTool === t.id
                              ? "bg-blue-600/30 text-white"
                              : "text-zinc-300 hover:bg-zinc-700"
                          }`}
                        >
                          <t.icon className="h-3.5 w-3.5" />
                          <span className="flex-1">{t.label}</span>
                          <span className="text-[10px] text-zinc-500">
                            {getShortcutLabel(kbLayout, t.actionId)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                );
              })()}
          </div>
        );
      })()}

      <div className="my-1 h-px w-6 flex-shrink-0 bg-zinc-700" />

      <Tooltip
        side="right"
        content={snapEnabled ? "Snapping On" : "Snapping Off"}
      >
        <button
          onClick={() => setSnapEnabled(!snapEnabled)}
          className={`flex-shrink-0 rounded-lg p-1.5 transition-colors ${
            snapEnabled
              ? "bg-blue-600 text-white"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
          }`}
        >
          <Magnet className="h-4 w-4" />
        </button>
      </Tooltip>

      {/* EFFECTS HIDDEN - FX button hidden because effects are not applied during export
      <div className="w-6 h-px bg-zinc-700 my-1 flex-shrink-0" />

      <Tooltip side="right" content="Effects Browser">
        <button
          onClick={() => setShowEffectsBrowser(!showEffectsBrowser)}
          className={`p-1.5 rounded-lg transition-colors flex-shrink-0 text-[10px] font-bold ${
            showEffectsBrowser
              ? 'bg-blue-600 text-white'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
          }`}
        >
          FX
        </button>
      </Tooltip>
      EFFECTS HIDDEN */}

      <div className="my-1 h-px w-6 flex-shrink-0 bg-zinc-700" />

      <Tooltip side="right" content="Add Text Overlay">
        <button
          onClick={() => addTextClip()}
          className="flex-shrink-0 rounded-lg p-1.5 text-cyan-400 transition-colors hover:bg-cyan-900/30 hover:text-cyan-300"
        >
          <Type className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
