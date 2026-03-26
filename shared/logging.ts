export type LogLevel = "INFO" | "WARNING" | "ERROR" | "DEBUG";
export type LogSource = "Electron" | "Renderer" | "Backend";

export interface LogSinks {
  terminal?: boolean;
  sessionFile?: boolean;
  errorTracking?: boolean;
}

export interface LogEntry {
  level: LogLevel;
  source: LogSource;
  message: string;
  category?: string;
  requestId?: string;
  traceId?: string;
  agentSessionId?: string;
  taskId?: string;
  toolCallId?: string;
  durationMs?: number;
  statusCode?: number;
  provider?: string;
  retryCause?: string;
  sinks?: LogSinks;
}

export interface ParsedLogLine {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  category?: string;
  message: string;
  context: Record<string, string>;
  raw: string;
}

const CONTEXT_FIELDS: Array<[keyof LogEntry, string]> = [
  ["requestId", "request_id"],
  ["traceId", "trace_id"],
  ["agentSessionId", "agent_session_id"],
  ["taskId", "task_id"],
  ["toolCallId", "tool_call_id"],
  ["durationMs", "duration_ms"],
  ["statusCode", "status_code"],
  ["provider", "provider"],
  ["retryCause", "retry_cause"],
];

const TERMINAL_MILESTONE_CATEGORIES = new Set([
  "agent.session",
  "agent.plan",
  "agent.task",
  "agent.error",
  "agent.api",
  "backend.process",
  "backend.request",
  "desktop.error",
  "desktop.process",
]);

function isPresent(value: unknown): value is string | number {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

export function formatTimestamp(date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())},${pad(date.getMilliseconds(), 3)}`;
}

export function formatLogMessage(entry: Pick<LogEntry, "source" | "category" | "message">): string {
  const prefix = entry.category
    ? `[${entry.source}] [${entry.category}]`
    : `[${entry.source}]`;
  return `${prefix} ${entry.message}`;
}

export function formatLogContext(entry: Partial<LogEntry>): string[] {
  const parts: string[] = [];
  for (const [field, key] of CONTEXT_FIELDS) {
    const value = entry[field];
    if (isPresent(value)) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts;
}

export function formatRenderedLogLine(entry: LogEntry): string {
  const base = formatLogMessage(entry);
  const context = formatLogContext(entry);
  return context.length > 0 ? `${base} | ${context.join(" ")}` : base;
}

export function formatPersistedLogLine(entry: LogEntry, timestamp = formatTimestamp()): string {
  return `${timestamp} - ${entry.level} - ${formatRenderedLogLine(entry)}`;
}

export function parseLogLine(line: string): ParsedLogLine | null {
  const match = line.match(
    /^(?<timestamp>.+?) - (?<level>INFO|WARNING|ERROR|DEBUG) - \[(?<source>Electron|Renderer|Backend)\](?: \[(?<category>[^\]]+)\])? (?<rest>.*)$/,
  );
  if (!match?.groups) {
    return null;
  }

  const rest = match.groups.rest;
  let message = rest;
  let contextText = "";
  const contextSeparator = rest.lastIndexOf(" | ");
  if (contextSeparator >= 0) {
    const candidateContext = rest.slice(contextSeparator + 3);
    const contextTokens = candidateContext.split(" ").filter(Boolean);
    const looksStructuredContext = contextTokens.length > 0
      && contextTokens.every((token) => token.includes("="));
    if (looksStructuredContext) {
      message = rest.slice(0, contextSeparator);
      contextText = candidateContext;
    }
  }
  const context: Record<string, string> = {};
  if (contextText) {
    for (const token of contextText.split(" ")) {
      const [key, ...valueParts] = token.split("=");
      if (!key || valueParts.length === 0) continue;
      context[key] = valueParts.join("=");
    }
  }

  return {
    timestamp: match.groups.timestamp,
    level: match.groups.level as LogLevel,
    source: match.groups.source as LogSource,
    category: match.groups.category,
    message,
    context,
    raw: line,
  };
}

export function shouldEmitToTerminal(entry: LogEntry): boolean {
  if (entry.sinks?.terminal === false) {
    return false;
  }
  if (entry.sinks?.terminal === true) {
    return true;
  }
  if (entry.level === "ERROR" || entry.level === "WARNING") {
    return true;
  }
  return entry.category ? TERMINAL_MILESTONE_CATEGORIES.has(entry.category) : false;
}
