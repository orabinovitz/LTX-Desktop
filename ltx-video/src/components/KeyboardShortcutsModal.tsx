import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  X,
  Search,
  Keyboard,
  RotateCcw,
  Save,
  AlertTriangle,
  ChevronDown,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useKeyboardShortcuts } from "../contexts/KeyboardShortcutsContext";
import {
  ACTION_REGISTRY,
  ActionId,
  KeyCombo,
  formatKeyCombo,
  findConflicts,
  ActionDefinition,
} from "../lib/keyboard-shortcuts";

// ── Visual keyboard layout (US QWERTY) ──
// Each key: { id: lowercase key id matching KeyCombo.key, label: display text, w: width units (1 = standard key) }
interface KBKey {
  id: string;
  label: string;
  w: number;
}

const KB_ROWS: KBKey[][] = [
  // Row 0: Number row
  [
    { id: "`", label: "`", w: 1 },
    { id: "1", label: "1", w: 1 },
    { id: "2", label: "2", w: 1 },
    { id: "3", label: "3", w: 1 },
    { id: "4", label: "4", w: 1 },
    { id: "5", label: "5", w: 1 },
    { id: "6", label: "6", w: 1 },
    { id: "7", label: "7", w: 1 },
    { id: "8", label: "8", w: 1 },
    { id: "9", label: "9", w: 1 },
    { id: "0", label: "0", w: 1 },
    { id: "-", label: "-", w: 1 },
    { id: "=", label: "=", w: 1 },
    { id: "backspace", label: "Bksp", w: 2 },
  ],
  // Row 1: QWERTY
  [
    { id: "tab", label: "Tab", w: 1.5 },
    { id: "q", label: "Q", w: 1 },
    { id: "w", label: "W", w: 1 },
    { id: "e", label: "E", w: 1 },
    { id: "r", label: "R", w: 1 },
    { id: "t", label: "T", w: 1 },
    { id: "y", label: "Y", w: 1 },
    { id: "u", label: "U", w: 1 },
    { id: "i", label: "I", w: 1 },
    { id: "o", label: "O", w: 1 },
    { id: "p", label: "P", w: 1 },
    { id: "[", label: "[", w: 1 },
    { id: "]", label: "]", w: 1 },
    { id: "\\", label: "\\", w: 1.5 },
  ],
  // Row 2: Home row
  [
    { id: "capslock", label: "Caps", w: 1.8 },
    { id: "a", label: "A", w: 1 },
    { id: "s", label: "S", w: 1 },
    { id: "d", label: "D", w: 1 },
    { id: "f", label: "F", w: 1 },
    { id: "g", label: "G", w: 1 },
    { id: "h", label: "H", w: 1 },
    { id: "j", label: "J", w: 1 },
    { id: "k", label: "K", w: 1 },
    { id: "l", label: "L", w: 1 },
    { id: ";", label: ";", w: 1 },
    { id: "'", label: "'", w: 1 },
    { id: "enter", label: "Enter", w: 2.2 },
  ],
  // Row 3: Shift row
  [
    { id: "shift-l", label: "Shift", w: 2.5 },
    { id: "z", label: "Z", w: 1 },
    { id: "x", label: "X", w: 1 },
    { id: "c", label: "C", w: 1 },
    { id: "v", label: "V", w: 1 },
    { id: "b", label: "B", w: 1 },
    { id: "n", label: "N", w: 1 },
    { id: "m", label: "M", w: 1 },
    { id: ",", label: ",", w: 1 },
    { id: ".", label: ".", w: 1 },
    { id: "/", label: "/", w: 1 },
    { id: "shift-r", label: "Shift", w: 2.5 },
  ],
  // Row 4: Bottom row
  [
    { id: "ctrl-l", label: "Ctrl", w: 1.5 },
    { id: "alt-l", label: "Alt", w: 1.5 },
    { id: " ", label: "Space", w: 7 },
    { id: "alt-r", label: "Alt", w: 1.5 },
    { id: "ctrl-r", label: "Ctrl", w: 1.5 },
  ],
  // Row 5: Navigation cluster
  [
    { id: "escape", label: "Esc", w: 1 },
    { id: "delete", label: "Del", w: 1 },
    { id: "home", label: "Home", w: 1 },
    { id: "end", label: "End", w: 1 },
    { id: "f9", label: "F9", w: 1 },
    { id: "f10", label: "F10", w: 1 },
    { id: "f11", label: "F11", w: 1 },
    { id: "arrowleft", label: "\u2190", w: 1 },
    { id: "arrowup", label: "\u2191", w: 1 },
    { id: "arrowdown", label: "\u2193", w: 1 },
    { id: "arrowright", label: "\u2192", w: 1 },
  ],
];

// Category → color mapping
const CATEGORY_COLORS: Record<
  string,
  { bg: string; border: string; text: string; dot: string }
> = {
  Tools: {
    bg: "bg-blue-600/30",
    border: "border-blue-500/60",
    text: "text-blue-300",
    dot: "bg-blue-400",
  },
  Transport: {
    bg: "bg-emerald-600/30",
    border: "border-emerald-500/60",
    text: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  Editing: {
    bg: "bg-amber-600/30",
    border: "border-amber-500/60",
    text: "text-amber-300",
    dot: "bg-amber-400",
  },
  Marking: {
    bg: "bg-rose-600/30",
    border: "border-rose-500/60",
    text: "text-rose-300",
    dot: "bg-rose-400",
  },
  Timeline: {
    bg: "bg-blue-600/30",
    border: "border-blue-500/60",
    text: "text-blue-300",
    dot: "bg-blue-400",
  },
};

// Keys that are modifier indicators (not assignable targets)
const MODIFIER_KEY_IDS = new Set([
  "shift-l",
  "shift-r",
  "ctrl-l",
  "ctrl-r",
  "alt-l",
  "alt-r",
  "capslock",
  "tab",
]);

export function KeyboardShortcutsModal() {
  const {
    activeLayout,
    activePresetId,
    presets,
    switchPreset,
    updateBinding,
    resetToPreset,
    saveAsCustomPreset,
    deleteCustomPreset,
    isEditorOpen,
    setEditorOpen,
  } = useKeyboardShortcuts();

  const [searchQuery, setSearchQuery] = useState("");
  const [recordingAction, setRecordingAction] = useState<ActionId | null>(null);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const recordRef = useRef<HTMLDivElement>(null);

  // Visual keyboard state
  const [kbModCtrl, setKbModCtrl] = useState(false);
  const [kbModShift, setKbModShift] = useState(false);
  const [kbModAlt, setKbModAlt] = useState(false);
  const [hoveredActionId, setHoveredActionId] = useState<ActionId | null>(null);
  const [draggedActionId, setDraggedActionId] = useState<ActionId | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(true);

  const conflicts = findConflicts(activeLayout);
  const activePreset = presets.find((p) => p.id === activePresetId);

  // ── Reverse lookup: given current modifier state, map keyId → ActionId ──
  const keyToAction = useMemo(() => {
    const map = new Map<
      string,
      { actionId: ActionId; action: ActionDefinition }
    >();
    for (const [actionId, combos] of Object.entries(activeLayout)) {
      if (!combos) continue;
      for (const combo of combos) {
        // Check if this combo matches the current modifier filter
        const comboCtrl = !!combo.ctrl || !!combo.meta;
        const comboShift = !!combo.shift;
        const comboAlt = !!combo.alt;
        if (
          comboCtrl === kbModCtrl &&
          comboShift === kbModShift &&
          comboAlt === kbModAlt
        ) {
          const def = ACTION_REGISTRY.find((a) => a.id === actionId);
          if (def) {
            map.set(combo.key, { actionId: actionId as ActionId, action: def });
          }
        }
      }
    }
    return map;
  }, [activeLayout, kbModCtrl, kbModShift, kbModAlt]);

  // ── Keys assigned to the hovered action (for highlighting) ──
  const hoveredKeys = useMemo(() => {
    if (!hoveredActionId) return new Set<string>();
    const combos = activeLayout[hoveredActionId] || [];
    return new Set(combos.map((c) => c.key));
  }, [hoveredActionId, activeLayout]);

  // Close on Escape (only when not recording)
  useEffect(() => {
    if (!isEditorOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !recordingAction) {
        setEditorOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isEditorOpen, recordingAction, setEditorOpen]);

  // Recording mode: capture the next keystroke as a new binding
  const handleRecordKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recordingAction) return;
      e.preventDefault();
      e.stopPropagation();

      // Ignore modifier-only presses
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      const combo: KeyCombo = {
        key: e.key.toLowerCase(),
        ...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
        ...(e.shiftKey ? { shift: true } : {}),
        ...(e.altKey ? { alt: true } : {}),
      };

      // If Escape pressed alone, cancel recording
      if (combo.key === "escape" && !combo.ctrl && !combo.shift && !combo.alt) {
        setRecordingAction(null);
        return;
      }

      // Set the new binding (replace existing)
      updateBinding(recordingAction, [combo]);
      setRecordingAction(null);
    },
    [recordingAction, updateBinding],
  );

  useEffect(() => {
    if (recordingAction) {
      window.addEventListener("keydown", handleRecordKeyDown, true);
      return () =>
        window.removeEventListener("keydown", handleRecordKeyDown, true);
    }
  }, [recordingAction, handleRecordKeyDown]);

  // ── Drag and drop via React state (avoids HTML5 DnD issues in Electron) ──
  // We track the dragged action in a ref so it's always current
  const draggedActionRef = useRef<ActionId | null>(null);

  // Mouse-based drag: user mousedowns on an action, moves to a key, mouseups to drop
  const handleActionMouseDown = useCallback(
    (e: React.MouseEvent, actionId: ActionId) => {
      // Only left-click
      if (e.button !== 0) return;
      e.preventDefault();
      draggedActionRef.current = actionId;
      setDraggedActionId(actionId);
    },
    [],
  );

  // Global mouse handlers for drag (attached when dragging)
  useEffect(() => {
    if (!draggedActionId) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Find which keyboard key the mouse is over
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const keyEl = el?.closest("[data-kb-key]") as HTMLElement | null;
      if (keyEl) {
        const keyId = keyEl.getAttribute("data-kb-key");
        if (keyId && !MODIFIER_KEY_IDS.has(keyId)) {
          setDropTargetKey(keyId);
        } else {
          setDropTargetKey(null);
        }
      } else {
        setDropTargetKey(null);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const actionId = draggedActionRef.current;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const keyEl = el?.closest("[data-kb-key]") as HTMLElement | null;

      if (actionId && keyEl) {
        const keyId = keyEl.getAttribute("data-kb-key");
        if (keyId && !MODIFIER_KEY_IDS.has(keyId)) {
          // Build combo from current modifier state + dropped key
          const combo: KeyCombo = {
            key: keyId,
            ...(kbModCtrl ? { ctrl: true } : {}),
            ...(kbModShift ? { shift: true } : {}),
            ...(kbModAlt ? { alt: true } : {}),
          };
          updateBinding(actionId, [combo]);
        }
      }

      draggedActionRef.current = null;
      setDraggedActionId(null);
      setDropTargetKey(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggedActionId, kbModCtrl, kbModShift, kbModAlt, updateBinding]);

  // Click on a key to select the action assigned to it
  const handleKeyClick = useCallback(
    (keyId: string) => {
      if (MODIFIER_KEY_IDS.has(keyId)) return;
      // Don't treat mouseup from a drag as a click
      if (draggedActionRef.current) return;
      const assigned = keyToAction.get(keyId);
      if (assigned) {
        setSelectedCategory(null);
        setSearchQuery(assigned.action.label);
      }
    },
    [keyToAction],
  );

  if (!isEditorOpen) return null;

  // Filter and group actions
  const categories = [
    "Tools",
    "Transport",
    "Editing",
    "Marking",
    "Timeline",
  ] as const;
  const filteredActions = ACTION_REGISTRY.filter((a) => {
    if (selectedCategory && a.category !== selectedCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const combos = activeLayout[a.id];
      const comboStr = combos?.map(formatKeyCombo).join(" ") || "";
      return (
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        comboStr.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const groupedActions: Record<string, ActionDefinition[]> = {};
  for (const a of filteredActions) {
    if (!groupedActions[a.category]) groupedActions[a.category] = [];
    groupedActions[a.category].push(a);
  }

  // Unit size for keyboard keys
  const KEY_UNIT = 42; // px per 1 unit of key width
  const KEY_GAP = 2; // px gap between keys
  const KEY_H = 36; // px key height

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !recordingAction)
          setEditorOpen(false);
      }}
    >
      <div className="flex max-h-[90vh] w-[880px] flex-col overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/95 px-5 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/20">
            <Keyboard className="h-4 w-4 text-blue-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-white">
              Keyboard Shortcuts
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Customize keybindings — drag actions onto keys or click Edit
            </p>
          </div>
          <button
            onClick={() => setShowKeyboard(!showKeyboard)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
              showKeyboard
                ? "bg-blue-600/20 text-blue-300"
                : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            }`}
          >
            {showKeyboard ? "Hide Keyboard" : "Show Keyboard"}
          </button>
          <button
            onClick={() => setEditorOpen(false)}
            className="p-1 text-zinc-500 transition-colors hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar: Preset selector + Search + Actions */}
        <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/50 px-4 py-2">
          {/* Preset dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowPresetDropdown(!showPresetDropdown)}
              className="flex items-center gap-2 rounded-md border border-zinc-700/60 bg-zinc-800 px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              <span className="max-w-[140px] truncate">
                {activePreset?.name || "Custom"}
              </span>
              <ChevronDown className="h-3 w-3 text-zinc-500" />
            </button>
            {showPresetDropdown && (
              <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl">
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center gap-1 transition-colors hover:bg-zinc-700 ${
                      p.id === activePresetId ? "bg-blue-600/15" : ""
                    }`}
                  >
                    <button
                      onClick={() => {
                        switchPreset(p.id);
                        setShowPresetDropdown(false);
                      }}
                      className={`flex-1 px-3 py-2 text-left text-[11px] ${
                        p.id === activePresetId
                          ? "text-blue-300"
                          : "text-zinc-300"
                      }`}
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="mt-0.5 text-[10px] text-zinc-500">
                        {p.description}
                      </div>
                    </button>
                    {/* Delete button — only for user-created (non-built-in) presets */}
                    {!p.builtIn && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete preset "${p.name}"?`)) {
                            deleteCustomPreset(p.id);
                            if (
                              presets.filter((pr) => pr.id !== p.id).length > 0
                            ) {
                              setShowPresetDropdown(true);
                            } else {
                              setShowPresetDropdown(false);
                            }
                          }
                        }}
                        className="mr-1.5 rounded p-1.5 text-zinc-600 transition-colors hover:bg-red-600/10 hover:text-red-400"
                        title={`Delete "${p.name}"`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
            <input
              type="text"
              placeholder="Search actions or keys..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-zinc-700/40 bg-zinc-800 py-1.5 pl-8 pr-3 text-[11px] text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500/50"
            />
          </div>

          {/* Reset button */}
          <button
            onClick={() => resetToPreset(activePresetId)}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Reset all shortcuts to the selected preset"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>

          {/* Save as custom */}
          <div className="relative">
            <button
              onClick={() => setShowSaveDialog(!showSaveDialog)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              title="Save current layout as a custom preset"
            >
              <Save className="h-3 w-3" />
              Save As
            </button>
            {showSaveDialog && (
              <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-zinc-700 bg-zinc-800 p-3 shadow-xl">
                <p className="mb-2 text-[10px] text-zinc-400">
                  Save as custom preset:
                </p>
                <input
                  type="text"
                  placeholder="Preset name..."
                  value={savePresetName}
                  onChange={(e) => setSavePresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && savePresetName.trim()) {
                      saveAsCustomPreset(savePresetName.trim());
                      setSavePresetName("");
                      setShowSaveDialog(false);
                    }
                  }}
                  className="mb-2 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-white placeholder-zinc-600 outline-none focus:border-blue-500"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (savePresetName.trim()) {
                      saveAsCustomPreset(savePresetName.trim());
                      setSavePresetName("");
                      setShowSaveDialog(false);
                    }
                  }}
                  disabled={!savePresetName.trim()}
                  className="w-full rounded bg-blue-600 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  Save Preset
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Conflict warning */}
        {conflicts.size > 0 && (
          <div className="flex items-center gap-2 border-b border-amber-800/30 bg-amber-950/30 px-4 py-2">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
            <span className="text-[11px] text-amber-400/90">
              {conflicts.size} shortcut conflict{conflicts.size > 1 ? "s" : ""}{" "}
              detected — some keys are assigned to multiple actions
            </span>
          </div>
        )}

        {/* ══════════════ Visual Keyboard ══════════════ */}
        {showKeyboard && (
          <div className="border-b border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
            {/* Modifier toggles */}
            <div className="mb-2.5 flex items-center gap-2">
              <span className="mr-1 text-[10px] font-medium text-zinc-500">
                Modifiers:
              </span>
              {(
                [
                  {
                    label: "Ctrl",
                    active: kbModCtrl,
                    toggle: () => setKbModCtrl((v) => !v),
                  },
                  {
                    label: "Shift",
                    active: kbModShift,
                    toggle: () => setKbModShift((v) => !v),
                  },
                  {
                    label: "Alt",
                    active: kbModAlt,
                    toggle: () => setKbModAlt((v) => !v),
                  },
                ] as const
              ).map((mod) => (
                <button
                  key={mod.label}
                  onClick={mod.toggle}
                  className={`rounded px-3 py-1 text-[10px] font-bold transition-all ${
                    mod.active
                      ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                      : "border border-zinc-700/50 bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                  }`}
                >
                  {mod.label}
                </button>
              ))}
              <div className="flex-1" />
              {/* Category legend */}
              <div className="flex items-center gap-3">
                {categories.map((cat) => {
                  const c = CATEGORY_COLORS[cat];
                  return (
                    <div key={cat} className="flex items-center gap-1">
                      <div className={`h-2 w-2 rounded-sm ${c.dot}`} />
                      <span className="text-[9px] text-zinc-500">{cat}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Keyboard rows */}
            <div className="flex flex-col items-center gap-[2px]">
              {KB_ROWS.map((row, rowIdx) => (
                <div key={rowIdx} className="flex gap-[2px]">
                  {row.map((kbKey) => {
                    const isModifier = MODIFIER_KEY_IDS.has(kbKey.id);
                    const assigned = keyToAction.get(kbKey.id);
                    const catColors = assigned
                      ? CATEGORY_COLORS[assigned.action.category]
                      : null;
                    const isHighlighted = hoveredKeys.has(kbKey.id);
                    const isDropTarget = dropTargetKey === kbKey.id;
                    const isDragging = !!draggedActionId;

                    // Check if this key has a conflict
                    const comboStr = assigned
                      ? formatKeyCombo({
                          key: kbKey.id,
                          ...(kbModCtrl ? { ctrl: true } : {}),
                          ...(kbModShift ? { shift: true } : {}),
                          ...(kbModAlt ? { alt: true } : {}),
                        })
                      : null;
                    const hasConflict = comboStr
                      ? conflicts.has(comboStr)
                      : false;

                    return (
                      <div
                        key={kbKey.id}
                        className={`relative flex select-none flex-col items-center justify-center rounded-md border text-center transition-all duration-100 ${
                          isModifier
                            ? "cursor-default border-zinc-700/40 bg-zinc-800/60"
                            : isDropTarget
                              ? "scale-105 border-blue-400 bg-blue-600/40 ring-1 ring-blue-400"
                              : isHighlighted
                                ? "border-blue-500 bg-blue-600/30 ring-1 ring-blue-400/50"
                                : hasConflict
                                  ? "border-amber-600/60 bg-amber-900/30"
                                  : assigned && catColors
                                    ? `${catColors.bg} ${catColors.border}`
                                    : isDragging && !isModifier
                                      ? "border-dashed border-zinc-600/80 bg-zinc-800/80 hover:border-blue-500/60 hover:bg-zinc-700/50"
                                      : "bg-zinc-850 border-zinc-700/50 hover:border-zinc-600"
                        } ${!isModifier ? "cursor-pointer" : ""} `}
                        style={{
                          width: kbKey.w * KEY_UNIT + (kbKey.w - 1) * KEY_GAP,
                          height: KEY_H,
                        }}
                        data-kb-key={kbKey.id}
                        onClick={() => handleKeyClick(kbKey.id)}
                        title={
                          assigned
                            ? `${assigned.action.label} (${assigned.action.category})`
                            : isModifier
                              ? kbKey.label
                              : "Unassigned — drag an action here"
                        }
                      >
                        {/* Key label */}
                        <span
                          className={`text-[9px] font-medium leading-none ${
                            isModifier
                              ? "text-zinc-600"
                              : assigned && catColors
                                ? catColors.text
                                : isHighlighted
                                  ? "text-blue-300"
                                  : "text-zinc-500"
                          }`}
                        >
                          {kbKey.label}
                        </span>
                        {/* Assigned action label (truncated) */}
                        {assigned && !isModifier && (
                          <span
                            className={`mt-0.5 max-w-full truncate px-0.5 text-[7px] leading-tight ${
                              catColors ? catColors.text : "text-zinc-400"
                            }`}
                            style={{ opacity: 0.8 }}
                          >
                            {assigned.action.label
                              .replace(/ Tool$/, "")
                              .replace(/ \(.*\)$/, "")}
                          </span>
                        )}
                        {/* Conflict indicator */}
                        {hasConflict && (
                          <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400" />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Drag hint */}
            {draggedActionId && (
              <div className="mt-2 animate-pulse text-center text-[10px] text-blue-400">
                Drop on a key to assign — current modifiers:{" "}
                {[kbModCtrl && "Ctrl", kbModShift && "Shift", kbModAlt && "Alt"]
                  .filter(Boolean)
                  .join("+") || "None"}
              </div>
            )}
          </div>
        )}

        {/* Category tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-800/60 bg-zinc-950/30 px-4 py-2">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
              !selectedCategory
                ? "bg-blue-600/20 text-blue-300"
                : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            }`}
          >
            All
          </button>
          {categories.map((cat) => {
            const c = CATEGORY_COLORS[cat];
            return (
              <button
                key={cat}
                onClick={() =>
                  setSelectedCategory(cat === selectedCategory ? null : cat)
                }
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  selectedCategory === cat
                    ? `${c.bg} ${c.text}`
                    : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
              >
                <div className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                {cat}
              </button>
            );
          })}
        </div>

        {/* Actions list */}
        <div className="min-h-0 flex-1 overflow-y-auto" ref={recordRef}>
          {categories.map((cat) => {
            const actions = groupedActions[cat];
            if (!actions || actions.length === 0) return null;
            const catColor = CATEGORY_COLORS[cat];
            return (
              <div key={cat}>
                {/* Category header */}
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800/50 bg-zinc-950/95 px-4 py-1.5">
                  <div className={`h-1.5 w-1.5 rounded-full ${catColor.dot}`} />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                    {cat}
                  </span>
                </div>
                {/* Action rows */}
                {actions.map((action) => {
                  const combos = activeLayout[action.id] || [];
                  const isRecording = recordingAction === action.id;
                  const hasConflict = combos.some((c) => {
                    const key = formatKeyCombo(c);
                    return conflicts.has(key);
                  });

                  return (
                    <div
                      key={action.id}
                      onMouseDown={(e) => {
                        if (!isRecording) handleActionMouseDown(e, action.id);
                      }}
                      onMouseEnter={() => setHoveredActionId(action.id)}
                      onMouseLeave={() => setHoveredActionId(null)}
                      className={`flex select-none items-center gap-3 border-b border-zinc-800/30 px-4 py-2 transition-colors ${
                        isRecording
                          ? "bg-blue-950/30"
                          : draggedActionId === action.id
                            ? "bg-blue-600/20 ring-1 ring-blue-500/50"
                            : hoveredActionId === action.id
                              ? "bg-zinc-800/40"
                              : "hover:bg-zinc-800/30"
                      } ${!isRecording ? "cursor-grab active:cursor-grabbing" : ""}`}
                    >
                      {/* Drag handle */}
                      {!isRecording && (
                        <GripVertical
                          className={`h-3 w-3 flex-shrink-0 ${
                            draggedActionId === action.id
                              ? "cursor-grabbing text-blue-400"
                              : "cursor-grab text-zinc-700"
                          }`}
                        />
                      )}

                      {/* Category dot */}
                      <div
                        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${catColor.dot}`}
                      />

                      {/* Action label */}
                      <div className="min-w-0 flex-1">
                        <span
                          className={`text-[12px] ${hasConflict ? "text-amber-300" : "text-zinc-300"}`}
                        >
                          {action.label}
                        </span>
                        {action.description && (
                          <span className="ml-2 text-[10px] text-zinc-600">
                            {action.description}
                          </span>
                        )}
                        {hasConflict && (
                          <AlertTriangle className="-mt-0.5 ml-1.5 inline-block h-3 w-3 text-amber-400" />
                        )}
                      </div>

                      {/* Current binding(s) */}
                      <div className="flex items-center gap-1.5">
                        {isRecording ? (
                          <div className="flex animate-pulse items-center gap-2 rounded-md border border-blue-500/50 bg-blue-600/20 px-3 py-1">
                            <span className="text-[11px] text-blue-300">
                              Press a key...
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setRecordingAction(null);
                              }}
                              className="text-zinc-500 hover:text-white"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            {combos.length === 0 ? (
                              <span className="text-[11px] italic text-zinc-600">
                                Unassigned
                              </span>
                            ) : (
                              combos.map((combo, i) => {
                                const comboKey = formatKeyCombo(combo);
                                const conflicting = conflicts.has(comboKey);
                                return (
                                  <span
                                    key={i}
                                    className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px] font-medium ${
                                      conflicting
                                        ? "border border-amber-700/50 bg-amber-900/30 text-amber-300"
                                        : `${catColor.bg} ${catColor.text} border ${catColor.border}`
                                    }`}
                                  >
                                    {comboKey}
                                  </span>
                                );
                              })
                            )}
                          </>
                        )}
                      </div>

                      {/* Edit / Clear buttons */}
                      {!isRecording && (
                        <div className="ml-2 flex items-center gap-1">
                          <button
                            onClick={() => setRecordingAction(action.id)}
                            className="rounded px-2 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-blue-600/10 hover:text-blue-400"
                          >
                            Edit
                          </button>
                          {combos.length > 0 && (
                            <button
                              onClick={() => updateBinding(action.id, [])}
                              className="rounded px-2 py-0.5 text-[10px] text-zinc-600 transition-colors hover:bg-red-600/10 hover:text-red-400"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950/80 px-4 py-2.5">
          <span className="text-[10px] text-zinc-600">
            {ACTION_REGISTRY.length} actions &middot; Drag actions onto keys or
            click "Edit" to record
          </span>
          <button
            onClick={() => setEditorOpen(false)}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
