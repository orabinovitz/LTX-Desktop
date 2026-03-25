import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentDispatch } from "@/contexts/AgentContext";
import { useProjects } from "@/contexts/ProjectContext";
import App from "@/App";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/use-backend", () => ({
  useBackend: () => ({
    status: { connected: true, modelsLoaded: true, gpuInfo: null },
    processStatus: "alive",
    isLoading: false,
    error: null,
    checkHealth: vi.fn(),
    downloadModel: vi.fn(),
  }),
}));

vi.mock("@/contexts/AppSettingsContext", () => ({
  AppSettingsProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppSettings: () => ({
    settings: { hasLtxApiKey: true, hasFalApiKey: true },
    saveLtxApiKey: vi.fn(),
    saveFalApiKey: vi.fn(),
    forceApiGenerations: false,
    isLoaded: true,
    runtimePolicyLoaded: true,
    shouldVideoGenerateWithLtxApi: false,
  }),
}));

vi.mock("@/contexts/ProjectMemoryContext", () => ({
  ProjectMemoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/contexts/KeyboardShortcutsContext", () => ({
  KeyboardShortcutsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/KeyboardShortcutsModal", () => ({
  KeyboardShortcutsModal: () => null,
}));

vi.mock("@/views/Home", () => ({
  Home: function MockHome() {
    const { createProject, openProject } = useProjects();
    const { setAgentOpen } = useAgentDispatch();
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const project = createProject("Test Project");
            openProject(project.id);
          }}
        >
          Open Project
        </button>
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
        >
          Force Open Agent
        </button>
      </>
    );
  },
}));

vi.mock("@/views/Project", () => ({
  Project: () => <div>Project View</div>,
}));

vi.mock("@/views/Playground", () => ({
  Playground: () => <div>Playground View</div>,
}));

vi.mock("@/components/FirstRunSetup", () => ({
  LaunchGate: () => null,
}));

vi.mock("@/components/PythonSetup", () => ({
  PythonSetup: () => null,
}));

vi.mock("@/components/SettingsModal", () => ({
  SettingsModal: () => null,
}));

vi.mock("@/components/LogViewer", () => ({
  LogViewer: () => null,
}));

vi.mock("@/components/ApiGatewayModal", () => ({
  ApiGatewayModal: () => null,
}));

vi.mock("@/views/editor/components/AgentPromptBox", () => ({
  AgentPromptBox: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>Agent Panel</div> : null,
}));

vi.mock("@/hooks/use-global-agent-shortcut", () => ({
  useGlobalAgentShortcut: () => undefined,
}));

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, "electronAPI", {
    value: {
      checkPythonReady: vi.fn().mockResolvedValue({ ready: true }),
      startPythonBackend: vi.fn().mockResolvedValue(undefined),
      checkFirstRun: vi.fn().mockResolvedValue({ needsSetup: false, needsLicense: false }),
      getBackend: vi.fn().mockResolvedValue({
        url: "http://localhost:8000",
        token: "test-token",
      }),
    },
    writable: true,
    configurable: true,
  });
});

describe("App agent launcher", () => {
  it("only shows the launcher inside a project", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Open Project")).toBeInTheDocument();
    });

    expect(
      screen.queryByTitle("Open AI Agent (⌘ Space)"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Open Project"));

    await waitFor(() => {
      expect(screen.getByText("Project View")).toBeInTheDocument();
    });

    expect(screen.getByTitle("Open AI Agent (⌘ Space)")).toBeInTheDocument();
  });

  it("does not render the agent panel outside a project even if the state is open", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Force Open Agent")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Force Open Agent"));

    expect(screen.queryByText("Agent Panel")).not.toBeInTheDocument();
  });
});
