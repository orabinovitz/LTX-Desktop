/* eslint-disable no-console */
import {
  formatRenderedLogLine,
  type LogEntry,
  type LogLevel,
  shouldEmitToTerminal,
} from "../../shared/logging";

export type RendererLogContext = Omit<LogEntry, "level" | "source" | "message">;
type RendererLogContextState = {
  id: string;
  context: RendererLogContext;
};
const rendererLogContextStack: RendererLogContextState[] = [];

function shouldInheritRendererContext(context: RendererLogContext): boolean {
  return typeof context.category === "string" && context.category.startsWith("agent.");
}

function activeRendererLogContext(context: RendererLogContext): RendererLogContext {
  if (!shouldInheritRendererContext(context)) {
    return {};
  }
  return rendererLogContextStack.at(-1)?.context ?? {};
}

export function setRendererLogContext(context: RendererLogContext): string {
  const id = `renderer-log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  rendererLogContextStack.push({ id, context: { ...context } });
  return id;
}

export function updateRendererLogContext(id: string, context: RendererLogContext): void {
  const state = rendererLogContextStack.find((entry) => entry.id === id);
  if (!state) return;
  state.context = {
    ...state.context,
    ...context,
  };
}

export function clearRendererLogContext(id?: string): void {
  if (!id) {
    rendererLogContextStack.length = 0;
    return;
  }

  const index = rendererLogContextStack.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    rendererLogContextStack.splice(index, 1);
  }
}

function log(
  level: LogLevel,
  consoleMethod: "log" | "warn" | "error",
  message: string,
  context: RendererLogContext = {},
): void {
  const entry: LogEntry = {
    level,
    source: "Renderer",
    message,
    ...activeRendererLogContext(context),
    ...context,
  };
  const rendered = formatRenderedLogLine(entry);

  if (shouldEmitToTerminal(entry)) {
    console[consoleMethod](rendered);
  }

  window.electronAPI?.writeLog?.(entry)?.catch((error: unknown) => {
    console.warn("Failed to persist renderer log", error);
  });
}

export const logger = {
  info: (message: string, context?: RendererLogContext) => log("INFO", "log", message, context),
  warn: (message: string, context?: RendererLogContext) => log("WARNING", "warn", message, context),
  error: (message: string, context?: RendererLogContext) => log("ERROR", "error", message, context),
  debug: (message: string, context?: RendererLogContext) => log("DEBUG", "log", message, context),
};
