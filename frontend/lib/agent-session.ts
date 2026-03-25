import type { ViewType } from "@/types/project";

export function getAgentProjectSessionKey(
  currentView: ViewType,
  currentProjectId: string | null,
): string | null {
  if (currentView !== "project" || !currentProjectId) {
    return null;
  }

  return currentProjectId;
}

export function isProjectAgentAvailable(
  currentView: ViewType,
  currentProjectId: string | null,
): boolean {
  return getAgentProjectSessionKey(currentView, currentProjectId) !== null;
}
