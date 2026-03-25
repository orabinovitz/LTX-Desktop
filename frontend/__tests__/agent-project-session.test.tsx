import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProvider, useAgentContext } from "@/contexts/AgentContext";
import { ProjectProvider, useProjects } from "@/contexts/ProjectContext";
import { resetBackendCredentials } from "@/lib/backend";

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

function useAgentProjectHarness() {
  return {
    agent: useAgentContext(),
    projects: useProjects(),
  };
}

function createJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    body: null,
  };
}

function createSseResponse(body: unknown) {
  const encoded = new TextEncoder().encode(
    `event: result\ndata: ${JSON.stringify(body)}\n\n`,
  );

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => {
            if (sent) {
              return { done: true, value: undefined };
            }

            sent = true;
            return { done: false, value: encoded };
          },
          releaseLock: () => undefined,
        };
      },
    },
  };
}

function mockSimpleAgentFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.endsWith("/api/agent/resolve-intent")) {
      return createJsonResponse({
        grounded_prompt: "Hello agent",
        complexity: "simple",
        relevant_memory_ids: [],
        intent_summary: "Simple chat",
        requires_generation: false,
      });
    }

    if (url.endsWith("/api/agent/execute/stream")) {
      return createSseResponse({
        plan: "",
        tool_calls: [],
        message: "Done.",
        done: true,
        session_id: "sess-1",
      });
    }

    if (url.endsWith("/api/agent/execute")) {
      return createJsonResponse({
        plan: "",
        tool_calls: [],
        message: "Done.",
        done: true,
        session_id: "sess-1",
      });
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function seedAgentSession(
  result: {
    current: ReturnType<typeof useAgentProjectHarness>;
  },
) {
  act(() => {
    result.current.agent.setAgentOpen(true);
  });

  act(() => {
    result.current.agent.sendAgentPrompt("Hello agent");
  });

  await waitFor(() => {
    expect(result.current.agent.messages).toHaveLength(2);
    expect(result.current.agent.progress.phase).toBe("done");
  });

  expect(result.current.agent.agentOpen).toBe(true);
}

describe("project-scoped agent sessions", () => {
  beforeEach(() => {
    resetBackendCredentials();
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
        getBackend: vi.fn().mockResolvedValue({
          url: "http://localhost:8000",
          token: "test-token",
        }),
      },
      writable: true,
      configurable: true,
    });

    vi.stubGlobal("fetch", mockSimpleAgentFetch());
  });

  afterEach(() => {
    resetBackendCredentials();
    vi.restoreAllMocks();
  });

  it("clears the session when leaving a project", async () => {
    const { result } = renderHook(() => useAgentProjectHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      const project = result.current.projects.createProject("Project A");
      result.current.projects.openProject(project.id);
    });

    await seedAgentSession(result);

    act(() => {
      result.current.projects.goHome();
    });

    await waitFor(() => {
      expect(result.current.agent.messages).toEqual([]);
      expect(result.current.agent.progress.phase).toBe("idle");
      expect(result.current.agent.agentOpen).toBe(false);
    });
  });

  it("clears the session when switching to a different project", async () => {
    const { result } = renderHook(() => useAgentProjectHarness(), {
      wrapper: TestWrapper,
    });

    let secondProjectId = "";
    act(() => {
      const firstProject = result.current.projects.createProject("Project A");
      const secondProject = result.current.projects.createProject("Project B");
      secondProjectId = secondProject.id;
      result.current.projects.openProject(firstProject.id);
    });

    await seedAgentSession(result);

    act(() => {
      result.current.projects.openProject(secondProjectId);
    });

    await waitFor(() => {
      expect(result.current.agent.messages).toEqual([]);
      expect(result.current.agent.progress.phase).toBe("idle");
      expect(result.current.agent.agentOpen).toBe(false);
    });
  });

  it("keeps the current session when switching tabs in the same project", async () => {
    const { result } = renderHook(() => useAgentProjectHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      const project = result.current.projects.createProject("Project A");
      result.current.projects.openProject(project.id);
    });

    await seedAgentSession(result);

    const previousMessages = [...result.current.agent.messages];

    act(() => {
      result.current.projects.setCurrentTab("video-editor");
    });

    expect(result.current.agent.messages).toEqual(previousMessages);
    expect(result.current.agent.progress.phase).toBe("done");
    expect(result.current.agent.agentOpen).toBe(true);
  });

  it("ignores late prompt results after leaving the project", async () => {
    const deferredIntent = createDeferred<ReturnType<typeof createJsonResponse>>();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.endsWith("/api/agent/resolve-intent")) {
          return deferredIntent.promise;
        }

        if (url.endsWith("/api/agent/execute/stream")) {
          return createSseResponse({
            plan: "",
            tool_calls: [],
            message: "Done.",
            done: true,
            session_id: "sess-1",
          });
        }

        throw new Error(`Unexpected fetch request: ${url}`);
      }),
    );

    const { result } = renderHook(() => useAgentProjectHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      const project = result.current.projects.createProject("Project A");
      result.current.projects.openProject(project.id);
    });

    act(() => {
      result.current.agent.setAgentOpen(true);
      result.current.agent.sendAgentPrompt("Hello agent");
    });

    await waitFor(() => {
      expect(result.current.agent.isProcessing).toBe(true);
    });

    act(() => {
      result.current.projects.goHome();
    });

    await act(async () => {
      deferredIntent.resolve(
        createJsonResponse({
          grounded_prompt: "Hello agent",
          complexity: "simple",
          relevant_memory_ids: [],
          intent_summary: "Simple chat",
          requires_generation: false,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.agent.messages).toEqual([]);
      expect(result.current.agent.isProcessing).toBe(false);
      expect(result.current.agent.agentOpen).toBe(false);
    });
  });
});
