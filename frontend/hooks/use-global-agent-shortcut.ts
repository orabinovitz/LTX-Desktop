import { useEffect } from "react";
import { useAgentDispatch } from "@/contexts/AgentContext";
import { useProjects } from "@/contexts/ProjectContext";
import { isProjectAgentAvailable } from "@/lib/agent-session";

/**
 * Listens for the agent shortcut (Ctrl+Space or Ctrl+/) globally
 * and toggles the agent prompt box open/closed.
 */
export function useGlobalAgentShortcut() {
  const { setAgentOpen } = useAgentDispatch();
  const { currentView, currentProjectId } = useProjects();
  const canUseAgent = isProjectAgentAvailable(currentView, currentProjectId);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!canUseAgent) return;

      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === " " && e.metaKey) {
        e.preventDefault();
        setAgentOpen((prev) => !prev);
        return;
      }

      const isCtrl = e.ctrlKey || e.metaKey;
      if (!isCtrl) return;

      if (e.key === "/") {
        e.preventDefault();
        setAgentOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canUseAgent, setAgentOpen]);
}
