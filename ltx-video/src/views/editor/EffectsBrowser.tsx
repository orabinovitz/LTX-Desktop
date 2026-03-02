import { useState } from "react";
import { Sparkles, X, Search } from "lucide-react";
import {
  EFFECT_DEFINITIONS,
  type EffectType,
  type TimelineClip,
} from "../../types/project";

interface EffectsBrowserProps {
  onClose: () => void;
  selectedClip: TimelineClip | null;
  addEffectToClip: (clipId: string, effectType: EffectType) => void;
}

export function EffectsBrowser({
  onClose,
  selectedClip,
  addEffectToClip,
}: EffectsBrowserProps) {
  const [effectsSearchQuery, setEffectsSearchQuery] = useState("");

  return (
    <div className="flex w-56 flex-shrink-0 flex-col overflow-hidden border-r border-zinc-800/80 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/50 px-3 py-2.5">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600/20">
          <Sparkles className="h-3 w-3 text-blue-400" />
        </div>
        <span className="flex-1 text-[11px] font-semibold text-zinc-200">
          Effects
        </span>
        <button
          onClick={onClose}
          className="text-zinc-600 transition-colors hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Search */}
      <div className="border-b border-zinc-800/60 px-2.5 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
          <input
            type="text"
            placeholder="Search effects..."
            value={effectsSearchQuery}
            onChange={(e) => setEffectsSearchQuery(e.target.value)}
            className="w-full rounded-md border border-zinc-700/40 bg-zinc-800/70 py-1.5 pl-7 pr-2 text-[11px] text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500/50 focus:bg-zinc-800"
          />
        </div>
      </div>
      {/* Effect categories */}
      <div className="custom-scrollbar flex-1 overflow-y-auto py-1.5">
        {(["filter", "stylize", "color-preset"] as const).map((category) => {
          const categoryLabel =
            category === "filter"
              ? "Filters"
              : category === "stylize"
                ? "Stylize"
                : "Color Presets";
          const categoryIcon =
            category === "filter"
              ? "filter"
              : category === "stylize"
                ? "stylize"
                : "color";
          const effects = (
            Object.entries(EFFECT_DEFINITIONS) as [
              EffectType,
              (typeof EFFECT_DEFINITIONS)[EffectType],
            ][]
          )
            .filter(([, def]) => def.category === category)
            .filter(
              ([, def]) =>
                !effectsSearchQuery ||
                def.name
                  .toLowerCase()
                  .includes(effectsSearchQuery.toLowerCase()),
            );
          if (effects.length === 0) return null;
          return (
            <div key={category} className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.08em] text-zinc-500">
                <div
                  className={`h-1 w-1 rounded-full ${categoryIcon === "filter" ? "bg-blue-400" : categoryIcon === "stylize" ? "bg-amber-400" : "bg-emerald-400"}`}
                />
                {categoryLabel}
              </div>
              <div className="space-y-px px-2">
                {effects.map(([type, def]) => {
                  const lutGradient: Record<string, string> = {
                    "lut-cinematic":
                      "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
                    "lut-vintage":
                      "linear-gradient(135deg, #d4a373 0%, #e6ccb2 50%, #b5838d 100%)",
                    "lut-bw":
                      "linear-gradient(135deg, #111 0%, #666 50%, #ccc 100%)",
                    "lut-cool":
                      "linear-gradient(135deg, #4cc9f0 0%, #4895ef 50%, #4361ee 100%)",
                    "lut-warm":
                      "linear-gradient(135deg, #f77f00 0%, #fcbf49 50%, #eae2b7 100%)",
                    "lut-muted":
                      "linear-gradient(135deg, #6b7280 0%, #9ca3af 50%, #d1d5db 100%)",
                    "lut-vivid":
                      "linear-gradient(135deg, #ff006e 0%, #fb5607 50%, #ffbe0b 100%)",
                  };
                  const filterIcon: Record<string, string> = {
                    blur: "B",
                    sharpen: "S",
                    glow: "G",
                    vignette: "V",
                    grain: "N",
                  };
                  const filterColor: Record<string, string> = {
                    blur: "from-blue-500/20 to-blue-600/10 text-blue-400",
                    sharpen: "from-cyan-500/20 to-cyan-600/10 text-cyan-400",
                    glow: "from-amber-500/20 to-amber-600/10 text-amber-400",
                    vignette: "from-blue-500/20 to-blue-600/10 text-blue-400",
                    grain: "from-stone-500/20 to-stone-600/10 text-stone-400",
                  };

                  return (
                    <button
                      key={type}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("effectType", type);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDoubleClick={() => {
                        if (selectedClip)
                          addEffectToClip(selectedClip.id, type);
                      }}
                      className="group flex w-full cursor-grab items-center gap-2.5 rounded-md px-2 py-1.5 transition-all hover:bg-zinc-800/80 active:cursor-grabbing"
                      title={`${def.name} — drag onto clip or double-click to apply`}
                    >
                      {/* Icon/swatch */}
                      {category === "color-preset" ? (
                        <div
                          className="h-7 w-7 flex-shrink-0 rounded-md ring-1 ring-white/10 transition-all group-hover:ring-white/20"
                          style={{
                            background:
                              lutGradient[type] ||
                              "linear-gradient(135deg, #333, #555)",
                          }}
                        />
                      ) : (
                        <div
                          className={`h-7 w-7 flex-shrink-0 rounded-md bg-gradient-to-br ${filterColor[type] || "from-zinc-700 to-zinc-800 text-zinc-400"} flex items-center justify-center ring-1 ring-white/5 transition-all group-hover:ring-white/15`}
                        >
                          <span className="text-[11px] font-black">
                            {filterIcon[type] || "F"}
                          </span>
                        </div>
                      )}
                      {/* Label */}
                      <span className="truncate text-[11px] text-zinc-400 transition-colors group-hover:text-zinc-200">
                        {def.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {/* Footer hint */}
      <div className="border-t border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
        <p className="text-[9px] leading-relaxed text-zinc-600">
          Drag onto a clip or double-click to apply to selection
        </p>
      </div>
    </div>
  );
}
