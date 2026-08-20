/**
 * opencode-client.ts — reusable HTTP client for the opencode session API.
 *
 * Transport-only: the loop is a pure HTTP client with NO process ownership.
 * The client attaches to `opencodeServer.url` (default http://127.0.0.1:4096)
 * and is health-gated before every agent task via `assertHealthy()` — a down
 * server surfaces a clear diagnostic instead of a hung phase.
 *
 * The :4097 compat shim stays usable as a container fallback purely via
 * config: point `opencodeServer.url` at it and this client speaks the same
 * opencode HTTP surface — zero code change.
 *
 * Contract verified against the REAL opencode server OpenAPI 3.1.0 doc
 * (/doc, 2026-08-19):
 *   GET  /api/health                → { healthy: true }
 *   POST /session                   → create ({ title?, agent?, model?, permission? })
 *   GET  /session                   → list (Session[])
 *   GET  /session/{id}              → get (Session)
 *   POST /session/{id}/prompt_async → send a text prompt ({ parts: [{ type: 'text', text }] }) → 204
 *   GET  /api/session/{id}/event    → SSE event stream (data = SessionDurableEvent JSON)
 *   POST /session/{id}/abort        → abort (true)
 */

/** Cap on error-body snippets attached to non-2xx failures. */
const ERROR_BODY_SNIPPET_MAX = 200;

/** How long a health probe waits before the backend counts as unhealthy. */
const HEALTH_CHECK_TIMEOUT_MS = 2000;

/** Model selection for a session (wire shape: { id, providerID, variant? }). */
export interface OpenCodeSessionModel {
  id: string;
  providerID: string;
  variant?: string;
}

export type PermissionAction = 'allow' | 'deny' | 'ask';

/** One permission rule (wire shape: { permission, pattern, action }). */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/** A session as returned by the opencode server (subset of the Session schema). */
export interface OpenCodeSession {
  id: string;
  slug?: string;
  title?: string;
  agent?: string;
  model?: OpenCodeSessionModel;
  directory?: string;
  time?: { created?: number; updated?: number };
}

/**
 * One event from the session event stream. `data` is the raw
 * SessionDurableEvent JSON — discriminated by `data.type` (e.g.
 * `session.next.text.ended` with `data.text`, `session.next.step.ended`
 * with `data.finish`, `session.next.step.failed` with `data.error`).
 */
export interface OpenCodeEventData {
  type?: string;
  text?: string;
  finish?: string;
  error?: string;
  [key: string]: unknown;
}

/** A parsed SSE block from GET /api/session/{id}/event. */
export interface OpenCodeStreamEvent {
  id?: string;
  event?: string;
  data?: OpenCodeEventData;
}

export interface CreateSessionOptions {
  /** Agent name (e.g. "build", "plan"). */
  agent?: string;
  /** Model selection. */
  model?: OpenCodeSessionModel;
  /**
   * Permission ruleset. The server's wire key is `permission` (a
   * PermissionRuleset array); `permissionMode` is the client-side name for it.
   */
  permissionMode?: PermissionRule[];
}

export interface OpenCodeClient {
  /** Probe the server health endpoint. Returns false on any failure/timeout — never throws. */
  checkHealth(): Promise<boolean>;
  /** Health gate: throws a clear diagnostic when the server is down. */
  assertHealthy(): Promise<void>;
  /** Create a session and return it (the `ses_...` id is surfaced on the result). */
  createSession(opts?: CreateSessionOptions): Promise<OpenCodeSession>;
  /** List all sessions. */
  listSessions(): Promise<OpenCodeSession[]>;
  /** Fetch a single session by id. */
  getSession(id: string): Promise<OpenCodeSession>;
  /** Abort/close a session by id. */
  abortSession(id: string): Promise<void>;
  /** Send a text prompt to a session (POST /session/{id}/prompt_async). */
  sendPrompt(sessionId: string, text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Open the session event stream (GET /api/session/{id}/event, SSE) as parsed events. */
  streamEvents(sessionId: string, opts?: { signal?: AbortSignal }): AsyncIterable<OpenCodeStreamEvent>;
}

/** Typed error for non-2xx responses — carries the server's status and message. */
export class OpenCodeApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(
      `opencode ${method} ${url} failed (${status}): ${body.slice(0, ERROR_BODY_SNIPPET_MAX) || '(empty body)'}`,
    );
    this.name = 'OpenCodeApiError';
    this.status = status;
    this.method = method;
    this.url = url;
  }
}

export function createOpenCodeClient(
  baseUrl: string,
  signal?: AbortSignal,
): OpenCodeClient {
  // Normalize a trailing slash so `http://host:4096/` + `/session` never
  // produces a double-slash path (which the server would 404).
  const origin = baseUrl.replace(/\/+$/, '');
  const sessionUrl = (id?: string): string =>
    `${origin}/session${id ? `/${encodeURIComponent(id)}` : ''}`;

  async function request<T>(
    method: string,
    url: string,
    body?: unknown,
    reqSignal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: reqSignal ?? signal,
      });
    } catch (err) {
      throw new Error(
        `opencode request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenCodeApiError(method, url, res.status, text);
    }
    // Empty bodies (e.g. 204 from prompt_async) parse to undefined.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      // The server may answer 200 with `{ healthy: false }` — the payload,
      // not the status, is the contract. Fail the gate on an explicit false.
      const body = (await res.json().catch(() => ({}))) as { healthy?: boolean };
      return body.healthy !== false;
    } catch {
      return false;
    }
  }

  async function assertHealthy(): Promise<void> {
    if (!(await checkHealth())) {
      throw new Error(
        `opencode server at ${origin} is not healthy — is \`opencode serve\` running?`,
      );
    }
  }

  return {
    checkHealth,
    assertHealthy,
    async createSession(opts: CreateSessionOptions = {}) {
      const body: Record<string, unknown> = {};
      if (opts.agent !== undefined) body.agent = opts.agent;
      if (opts.model !== undefined) body.model = opts.model;
      if (opts.permissionMode !== undefined) body.permission = opts.permissionMode;
      return request<OpenCodeSession>('POST', sessionUrl(), body);
    },
    async listSessions() {
      return request<OpenCodeSession[]>('GET', sessionUrl());
    },
    async getSession(id) {
      return request<OpenCodeSession>('GET', sessionUrl(id));
    },
    async abortSession(id) {
      const url = `${sessionUrl(id)}/abort`;
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', signal });
      } catch (err) {
        throw new Error(
          `opencode request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OpenCodeApiError('POST', url, res.status, text);
      }
    },
    async sendPrompt(sessionId, text, opts = {}) {
      const url = `${sessionUrl(sessionId)}/prompt_async`;
      await request<void>(
        'POST',
        url,
        { parts: [{ type: 'text', text }] },
        opts.signal,
      );
    },
    async *streamEvents(sessionId, opts = {}): AsyncIterable<OpenCodeStreamEvent> {
      const url = `${origin}/api/session/${encodeURIComponent(sessionId)}/event`;
      const reqSignal = opts.signal ?? signal;
      let res: Response;
      try {
        res = await fetch(url, { method: 'GET', signal: reqSignal });
      } catch (err) {
        throw new Error(
          `opencode request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OpenCodeApiError('GET', url, res.status, text);
      }
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Normalize CRLF so `\n\n` is the only block separator.
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          for (;;) {
            const sep = buffer.indexOf('\n\n');
            if (sep === -1) break;
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const parsed = parseSseBlock(block);
            if (parsed) yield parsed;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Parse one SSE block (`id:`/`event:`/`data:` lines) into a stream event.
 * Blocks without a `data` line (heartbeats, comments) yield nothing.
 */
function parseSseBlock(block: string): OpenCodeStreamEvent | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n');
  let data: OpenCodeEventData;
  try {
    data = JSON.parse(joined) as OpenCodeEventData;
  } catch {
    data = { text: joined };
  }
  return { id, event, data };
}