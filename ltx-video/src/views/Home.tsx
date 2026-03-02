import { useState, useEffect } from "react";
import {
  Plus,
  Folder,
  FolderOpen,
  MoreVertical,
  Trash2,
  Pencil,
  Sparkles,
} from "lucide-react";
import { useProjects } from "../contexts/ProjectContext";
import { LtxLogo } from "../components/LtxLogo";
import { Button } from "../components/ui/button";
import type { Project } from "../types/project";

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ProjectCard({
  project,
  onOpen,
  onDelete,
  onRename,
  onSetAssetFolder,
}: {
  project: Project;
  onOpen: () => void;
  onDelete: () => void;
  onRename: () => void;
  onSetAssetFolder: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [imgError, setImgError] = useState(false);

  // Get thumbnail: use stored thumbnail, or first asset's URL as fallback
  const thumbnailUrl =
    project.thumbnail ||
    (project.assets.length > 0 ? project.assets[0].url : null);
  // For videos, try to find the first image asset for a better thumbnail
  const bestThumbnail =
    project.assets.find((a) => a.type === "image")?.url || thumbnailUrl;

  return (
    <div
      className="group relative cursor-pointer overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700"
      onClick={onOpen}
    >
      {/* Thumbnail */}
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-zinc-800">
        {bestThumbnail && !imgError ? (
          project.assets.find(
            (a) => a.type === "video" && a.url === bestThumbnail,
          ) ? (
            <video
              src={bestThumbnail}
              className="h-full w-full object-cover"
              muted
              preload="metadata"
              onError={() => setImgError(true)}
            />
          ) : (
            <img
              src={bestThumbnail}
              alt={project.name}
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          )
        ) : (
          <Folder className="h-12 w-12 text-zinc-600" />
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/30 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      {/* Info */}
      <div className="p-3">
        <h3 className="truncate font-medium text-white">{project.name}</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {formatDate(project.updatedAt)}
        </p>
      </div>

      {/* Menu button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowMenu(!showMenu);
        }}
        className="absolute right-2 top-2 rounded bg-black/50 p-1.5 opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
      >
        <MoreVertical className="h-4 w-4 text-white" />
      </button>

      {/* Dropdown menu */}
      {showMenu && (
        <div
          className="absolute right-2 top-10 z-10 min-w-[120px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onRename();
              setShowMenu(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700"
          >
            <Pencil className="h-4 w-4" />
            Rename
          </button>
          <button
            onClick={() => {
              onSetAssetFolder();
              setShowMenu(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700"
          >
            <FolderOpen className="h-4 w-4" />
            Asset Folder
          </button>
          <button
            onClick={() => {
              onDelete();
              setShowMenu(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-700"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function Home() {
  const {
    projects,
    createProject,
    deleteProject,
    renameProject,
    updateProject,
    openProject,
    openPlayground,
  } = useProjects();
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectAssetPath, setNewProjectAssetPath] = useState("");
  const [defaultDownloadsPath, setDefaultDownloadsPath] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [assetFolderProjectId, setAssetFolderProjectId] = useState<
    string | null
  >(null);
  const [assetFolderPath, setAssetFolderPath] = useState("");

  useEffect(() => {
    window.electronAPI
      ?.getDownloadsPath()
      .then((p) => {
        setDefaultDownloadsPath(p);
      })
      .catch(() => {});
  }, []);

  const getDefaultAssetPath = (name: string) => {
    if (!defaultDownloadsPath) return "";
    const sep = defaultDownloadsPath.includes("\\") ? "\\" : "/";
    return `${defaultDownloadsPath}${sep}Ltx Desktop Assets${sep}${name}`;
  };

  const handleCreateProject = () => {
    if (newProjectName.trim()) {
      const assetPath =
        newProjectAssetPath.trim() ||
        getDefaultAssetPath(newProjectName.trim());
      const project = createProject(
        newProjectName.trim(),
        assetPath || undefined,
      );
      setNewProjectName("");
      setNewProjectAssetPath("");
      setIsCreating(false);
      openProject(project.id);
    }
  };

  const handleBrowseAssetFolder = async (setter: (v: string) => void) => {
    const dir = await window.electronAPI?.showOpenDirectoryDialog({
      title: "Select Asset Folder",
    });
    if (dir) setter(dir);
  };

  const handleSaveAssetFolder = () => {
    if (assetFolderProjectId && assetFolderPath.trim()) {
      updateProject(assetFolderProjectId, {
        assetSavePath: assetFolderPath.trim(),
      });
    }
    setAssetFolderProjectId(null);
    setAssetFolderPath("");
  };

  const handleRenameProject = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const submitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameProject(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue("");
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-zinc-800">
        <div className="p-6">
          <LtxLogo className="h-6 w-auto text-white" />
        </div>

        <nav className="flex-1 px-3">
          <button className="flex w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm font-medium text-white">
            <Folder className="h-4 w-4" />
            Home
          </button>

          <div className="mt-6">
            <h4 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Quick Actions
            </h4>
            <button
              onClick={openPlayground}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Sparkles className="h-4 w-4" />
              Playground
            </button>
          </div>

          {projects.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Recent Projects
              </h4>
              {projects.slice(0, 5).map((project) => (
                <button
                  key={project.id}
                  onClick={() => openProject(project.id)}
                  className="flex w-full items-center gap-2 truncate rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                >
                  <Folder className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{project.name}</span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="border-t border-zinc-800 p-4">
          <button
            onClick={() => setIsCreating(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {/* Header Banner with video background */}
        <div className="relative h-72 overflow-hidden">
          <video
            src="./hero-video.mp4"
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* Dark overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />
          <div className="absolute bottom-6 left-8 z-10">
            <h1 className="mb-2 text-3xl font-bold text-white drop-shadow-lg">
              LTX Desktop
            </h1>
            <p className="text-zinc-200 drop-shadow-md">
              Create and manage your video projects
            </p>
          </div>
        </div>

        {/* Projects Grid */}
        <div className="p-8">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">Projects</h2>
          </div>

          {projects.length === 0 ? (
            <div className="py-16 text-center">
              <Folder className="mx-auto mb-4 h-16 w-16 text-zinc-700" />
              <h3 className="mb-2 text-lg font-medium text-zinc-400">
                No projects yet
              </h3>
              <p className="mb-6 text-zinc-500">
                Create your first project to get started
              </p>
              <Button
                onClick={() => setIsCreating(true)}
                className="bg-blue-600 hover:bg-blue-500"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Project
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => openProject(project.id)}
                  onDelete={() => {
                    if (confirm(`Delete "${project.name}"?`)) {
                      deleteProject(project.id);
                    }
                  }}
                  onRename={() => handleRenameProject(project.id, project.name)}
                  onSetAssetFolder={() => {
                    setAssetFolderProjectId(project.id);
                    setAssetFolderPath(
                      project.assetSavePath ||
                        getDefaultAssetPath(project.name),
                    );
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Create Project Modal */}
      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              Create New Project
            </h2>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Project name"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
            />
            <div className="mt-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Asset Save Folder
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={
                    newProjectAssetPath ||
                    (newProjectName.trim()
                      ? getDefaultAssetPath(newProjectName.trim())
                      : "")
                  }
                  onChange={(e) => setNewProjectAssetPath(e.target.value)}
                  placeholder={
                    newProjectName.trim()
                      ? getDefaultAssetPath(newProjectName.trim())
                      : "Downloads/Ltx Desktop Assets/..."
                  }
                  className="flex-1 truncate rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0 border-zinc-700"
                  onClick={() =>
                    handleBrowseAssetFolder(setNewProjectAssetPath)
                  }
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-zinc-600">
                Where generated assets will be saved
              </p>
            </div>
            <div className="mt-6 flex gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setIsCreating(false);
                  setNewProjectName("");
                  setNewProjectAssetPath("");
                }}
                className="flex-1 border-zinc-700"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className="flex-1 bg-blue-600 hover:bg-blue-500"
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renamingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              Rename Project
            </h2>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Project name"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submitRename()}
            />
            <div className="mt-6 flex gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setRenamingId(null);
                  setRenameValue("");
                }}
                className="flex-1 border-zinc-700"
              >
                Cancel
              </Button>
              <Button
                onClick={submitRename}
                disabled={!renameValue.trim()}
                className="flex-1 bg-blue-600 hover:bg-blue-500"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Asset Folder Modal */}
      {assetFolderProjectId &&
        (() => {
          const proj = projects.find((p) => p.id === assetFolderProjectId);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
              <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                <h2 className="mb-1 text-xl font-semibold text-white">
                  Asset Save Folder
                </h2>
                <p className="mb-4 text-xs text-zinc-500">
                  Where generated assets for "{proj?.name}" will be saved
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={assetFolderPath}
                    onChange={(e) => setAssetFolderPath(e.target.value)}
                    placeholder="Select a folder..."
                    className="flex-1 truncate rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
                    autoFocus
                    onKeyDown={(e) =>
                      e.key === "Enter" && handleSaveAssetFolder()
                    }
                  />
                  <Button
                    variant="outline"
                    className="flex-shrink-0 border-zinc-700"
                    onClick={() => handleBrowseAssetFolder(setAssetFolderPath)}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-6 flex gap-3">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setAssetFolderProjectId(null);
                      setAssetFolderPath("");
                    }}
                    className="flex-1 border-zinc-700"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSaveAssetFolder}
                    disabled={!assetFolderPath.trim()}
                    className="flex-1 bg-blue-600 hover:bg-blue-500"
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
