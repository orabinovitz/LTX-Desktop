import { useState, useEffect } from "react";
import { Loader2, AlertCircle, Settings, FileText } from "lucide-react";
import { ProjectProvider, useProjects } from "./contexts/ProjectContext";
import { KeyboardShortcutsProvider } from "./contexts/KeyboardShortcutsContext";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { useBackend } from "./hooks/use-backend";
import { Home } from "./views/Home";
import { Project } from "./views/Project";
import { Playground } from "./views/Playground";
import { FirstRunSetup } from "./components/FirstRunSetup";
import { PythonSetup } from "./components/PythonSetup";
import { SettingsModal, type AppSettings } from "./components/SettingsModal";
import { LogViewer } from "./components/LogViewer";
import { Button } from "./components/ui/button";

const DEFAULT_APP_SETTINGS: AppSettings = {
  useTorchCompile: false,
  loadOnStartup: true,
  ltxApiKey: "",
  useLocalTextEncoder: false,
  fastModel: { useUpscaler: true },
  proModel: { steps: 20, useUpscaler: true },
  promptCacheSize: 1,
  promptEnhancerEnabledT2V: false,
  promptEnhancerEnabledI2V: false,
  geminiApiKey: "",
  t2vSystemPrompt: "",
  i2vSystemPrompt: "",
  seedLocked: false,
  lockedSeed: 42,
};

function AppContent() {
  const { currentView } = useProjects();
  const {
    status,
    isLoading: backendLoading,
    error: backendError,
  } = useBackend();
  const [pythonReady, setPythonReady] = useState<boolean | null>(null);
  const [backendStarted, setBackendStarted] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [appSettings, setAppSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Fetch settings from backend
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl();
        const response = await fetch(`${backendUrl}/api/settings`);
        if (response.ok) {
          const data = await response.json();
          setAppSettings({
            useTorchCompile:
              data.useTorchCompile ?? DEFAULT_APP_SETTINGS.useTorchCompile,
            loadOnStartup:
              data.loadOnStartup ?? DEFAULT_APP_SETTINGS.loadOnStartup,
            ltxApiKey: data.ltxApiKey ?? DEFAULT_APP_SETTINGS.ltxApiKey,
            useLocalTextEncoder:
              data.useLocalTextEncoder ??
              DEFAULT_APP_SETTINGS.useLocalTextEncoder,
            fastModel: data.fastModel ?? DEFAULT_APP_SETTINGS.fastModel,
            proModel: data.proModel ?? DEFAULT_APP_SETTINGS.proModel,
            promptCacheSize:
              data.promptCacheSize ?? DEFAULT_APP_SETTINGS.promptCacheSize,
            promptEnhancerEnabledT2V:
              data.promptEnhancerEnabledT2V ??
              DEFAULT_APP_SETTINGS.promptEnhancerEnabledT2V,
            promptEnhancerEnabledI2V:
              data.promptEnhancerEnabledI2V ??
              DEFAULT_APP_SETTINGS.promptEnhancerEnabledI2V,
            geminiApiKey:
              data.geminiApiKey ?? DEFAULT_APP_SETTINGS.geminiApiKey,
            t2vSystemPrompt:
              data.t2vSystemPrompt ?? DEFAULT_APP_SETTINGS.t2vSystemPrompt,
            i2vSystemPrompt:
              data.i2vSystemPrompt ?? DEFAULT_APP_SETTINGS.i2vSystemPrompt,
            seedLocked: data.seedLocked ?? DEFAULT_APP_SETTINGS.seedLocked,
            lockedSeed: data.lockedSeed ?? DEFAULT_APP_SETTINGS.lockedSeed,
          });
        }
      } catch (e) {
        console.warn("Failed to fetch settings:", e);
      } finally {
        setSettingsLoaded(true);
      }
    };
    if (status.connected) fetchSettings();
  }, [status.connected]);

  // Sync settings to backend
  useEffect(() => {
    if (!settingsLoaded || !status.connected) return;
    const syncSettings = async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl();
        await fetch(`${backendUrl}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(appSettings),
        });
      } catch (e) {
        console.warn("Failed to sync settings:", e);
      }
    };
    syncSettings();
  }, [appSettings, settingsLoaded, status.connected]);

  // Check if Python environment is ready (Windows may need download)
  useEffect(() => {
    const check = async () => {
      try {
        const result = await window.electronAPI.checkPythonReady();
        setPythonReady(result.ready);
      } catch (e) {
        console.error("Failed to check Python readiness:", e);
        // In dev mode or if check fails, assume ready
        setPythonReady(true);
      }
    };
    check();
  }, []);

  // Start backend once Python is ready
  useEffect(() => {
    if (pythonReady !== true || backendStarted) return;
    setBackendStarted(true);
    const start = async () => {
      try {
        console.log("Starting Python backend...");
        await window.electronAPI.startPythonBackend();
        console.log("Python backend started successfully");
      } catch (e) {
        console.error("Failed to start Python backend:", e);
      }
    };
    start();
  }, [pythonReady, backendStarted]);

  // Check for first run
  useEffect(() => {
    const checkFirstRun = async () => {
      try {
        const firstRun = await window.electronAPI.checkFirstRun();
        setIsFirstRun(firstRun);
      } catch (e) {
        console.error("Failed to check first run:", e);
        setIsFirstRun(false);
      }
    };
    checkFirstRun();
  }, []);

  // Show spinner while checking Python readiness
  if (pythonReady === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show Python download/setup screen (Windows first launch)
  if (pythonReady === false) {
    return <PythonSetup onReady={() => setPythonReady(true)} />;
  }

  // Wait for backend before showing first-run setup (it needs the API)
  if (backendLoading || isFirstRun === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-primary" />
          <h2 className="mb-2 text-xl font-semibold text-foreground">
            Starting LTX Desktop...
          </h2>
          <p className="text-muted-foreground">
            Initializing the inference engine
          </p>
        </div>
      </div>
    );
  }

  // Show error screen if backend failed
  if (backendError && !status.connected) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-red-500" />
          <h2 className="mb-2 text-xl font-semibold text-foreground">
            Connection Failed
          </h2>
          <p className="mb-4 text-muted-foreground">{backendError}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  // Show first run setup (after backend is connected)
  if (isFirstRun) {
    return <FirstRunSetup onComplete={() => setIsFirstRun(false)} />;
  }

  // Check if settings/logs buttons should show (not on home/loading screens)
  const showGlobalControls = currentView !== "home" && status.connected;

  const renderView = () => {
    switch (currentView) {
      case "home":
        return <Home />;
      case "project":
        return <Project />;
      case "playground":
        return <Playground />;
      default:
        return <Home />;
    }
  };

  return (
    <div className="relative h-screen w-screen">
      {renderView()}

      {/* Global Settings & Logs buttons - top right, always available */}
      {showGlobalControls && (
        <div className="fixed right-3 top-[18px] z-50 flex items-center gap-1">
          {/* Logs */}
          <button
            onClick={() => setIsLogViewerOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            title="View Backend Logs"
          >
            <FileText className="h-4 w-4" />
          </button>
          {/* Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Global Modals */}
      <LogViewer
        isOpen={isLogViewerOpen}
        onClose={() => setIsLogViewerOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={appSettings}
        onSettingsChange={setAppSettings}
      />
    </div>
  );
}

export default function App() {
  return (
    <ProjectProvider>
      <KeyboardShortcutsProvider>
        <AppContent />
        <KeyboardShortcutsModal />
      </KeyboardShortcutsProvider>
    </ProjectProvider>
  );
}
