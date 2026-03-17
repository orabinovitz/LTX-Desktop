let cached: { url: string; token: string } | null = null

export async function getBackendCredentials(): Promise<{ url: string; token: string }> {
  if (!cached) cached = await window.electronAPI.getBackend()
  return cached
}

export function resetBackendCredentials(): void {
  cached = null
}

let _requestCounter = 0

function generateRequestId(): string {
  _requestCounter += 1
  const ts = Date.now().toString(36)
  const seq = _requestCounter.toString(36)
  return `${ts}-${seq}`
}

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const { url, token } = await getBackendCredentials()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('X-Request-ID')) {
    headers.set('X-Request-ID', generateRequestId())
  }
  return fetch(`${url}${path}`, { ...init, headers })
}

export interface SSEEvent {
  event: string;
  data: unknown;
}

/**
 * POST to a backend SSE endpoint and yield parsed events.
 * Falls back to a normal fetch if the response is not text/event-stream.
 */
export async function* backendSSE(
  path: string,
  init?: RequestInit,
): AsyncGenerator<SSEEvent, void, undefined> {
  const response = await backendFetch(path, init);
  if (!response.ok) throw new Error(`SSE request failed: ${response.status}`);
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim() || part.startsWith(": ")) continue;
        let eventType = "message";
        let data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data) {
          try {
            yield { event: eventType, data: JSON.parse(data) };
          } catch {
            yield { event: eventType, data };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function backendWsUrl(path: string): Promise<string> {
  const { url } = await getBackendCredentials()
  const ws = url.replace('http://', 'ws://')
  return `${ws}${path}`
}

export async function getWsProtocols(): Promise<string[]> {
  const { token } = await getBackendCredentials()
  if (!token) return []
  return [`bearer.${token}`]
}
