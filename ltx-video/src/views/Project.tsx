import { ArrowLeft, Sparkles, Film } from "lucide-react";
import { useProjects } from "../contexts/ProjectContext";
import { LtxLogo } from "../components/LtxLogo";
import { Button } from "../components/ui/button";
import { GenSpace } from "./GenSpace";
import { VideoEditor } from "./VideoEditor";
import type { ProjectTab } from "../types/project";

export function Project() {
  const { currentProject, currentTab, setCurrentTab, goHome } = useProjects();

  if (!currentProject) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <p className="mb-4 text-zinc-400">Project not found</p>
          <Button onClick={goHome}>Go Home</Button>
        </div>
      </div>
    );
  }

  const tabs: { id: ProjectTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "gen-space",
      label: "Gen Space",
      icon: <Sparkles className="h-4 w-4" />,
    },
    {
      id: "video-editor",
      label: "Video Editor",
      icon: <Film className="h-4 w-4" />,
    },
  ];

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex items-center border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-1 items-center gap-4">
          {/* Back button and logo */}
          <button
            onClick={goHome}
            className="rounded-lg p-2 transition-colors hover:bg-zinc-800"
          >
            <ArrowLeft className="h-5 w-5 text-zinc-400" />
          </button>

          <LtxLogo className="h-5 w-auto text-white" />

          {/* Project name */}
          <span className="font-medium text-white">{currentProject.name}</span>
        </div>

        {/* Center - Tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-zinc-900 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                currentTab === tab.id
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Right spacer - equal to left to keep tabs centered */}
        <div className="flex-1" />
      </header>

      {/* Main Content - both views stay mounted to preserve state */}
      <main className="relative flex-1 overflow-hidden">
        <div
          className={`absolute inset-0 ${currentTab === "gen-space" ? "" : "pointer-events-none invisible"}`}
        >
          <GenSpace />
        </div>
        <div
          className={`absolute inset-0 ${currentTab === "video-editor" ? "" : "pointer-events-none invisible"}`}
        >
          <VideoEditor />
        </div>
      </main>
    </div>
  );
}
