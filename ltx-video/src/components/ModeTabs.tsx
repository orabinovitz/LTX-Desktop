import { cn } from "@/lib/utils";
import { Video, ImageIcon } from "lucide-react";

export type GenerationMode =
  | "text-to-video"
  | "image-to-video"
  | "text-to-image";

// Simplified tab modes shown in the UI
type TabMode = "video" | "text-to-image";

interface ModeTabsProps {
  mode: GenerationMode;
  onModeChange: (mode: GenerationMode) => void;
  disabled?: boolean;
}

const tabs: {
  id: TabMode;
  label: string;
  genMode: GenerationMode;
  icon: React.ElementType;
}[] = [
  { id: "video", label: "Video", genMode: "text-to-video", icon: Video },
  {
    id: "text-to-image",
    label: "Image",
    genMode: "text-to-image",
    icon: ImageIcon,
  },
];

export function ModeTabs({ mode, onModeChange, disabled }: ModeTabsProps) {
  const activeTab: TabMode =
    mode === "text-to-image" ? "text-to-image" : "video";

  return (
    <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => !disabled && onModeChange(tab.genMode)}
            disabled={disabled}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
              isActive
                ? "bg-white text-zinc-900 shadow-sm"
                : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
