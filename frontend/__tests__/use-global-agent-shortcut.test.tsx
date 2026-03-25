import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProvider, useAgentContext } from "@/contexts/AgentContext";
import { ProjectProvider, useProjects } from "@/contexts/ProjectContext";
import { useGlobalAgentShortcut } from "@/hooks/use-global-agent-shortcut";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ProjectProvider>
      <AgentProvider>{children}</AgentProvider>
    </ProjectProvider>
  );
}

function useShortcutHarness() {
  useGlobalAgentShortcut();
  return {
    agent: useAgentContext(),
    projects: useProjects(),
  };
}

function triggerShortcut() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: " ",
      metaKey: true,
      bubbles: true,
    }),
  );
}

describe("useGlobalAgentShortcut", () => {
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
  });

  it("ignores the shortcut outside a project and opens inside a project", () => {
    const { result } = renderHook(() => useShortcutHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      triggerShortcut();
    });

    expect(result.current.agent.agentOpen).toBe(false);

    act(() => {
      const project = result.current.projects.createProject("Project A");
      result.current.projects.openProject(project.id);
    });

    act(() => {
      triggerShortcut();
    });

    expect(result.current.agent.agentOpen).toBe(true);
  });
});
