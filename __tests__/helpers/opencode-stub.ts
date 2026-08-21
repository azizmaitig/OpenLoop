// __tests__/helpers/opencode-stub.ts
// Implements the REAL opencode HTTP surface (verified against the live server's
// OpenAPI 3.1.0 doc at /doc, 2026-08-19):
//   GET  /api/health                → { healthy: true }
//   POST /session                   → create (records calls)
//   POST /session/{id}/prompt_async → 204 (records the prompt text)
//   GET  /api/session/{id}/event    → SSE (queued events, hold-open by default)
//   POST /session/{id}/abort        → true (records calls)
//   GET  /session/{id}/message      → { info, parts }[] (configured messages)
//   GET  /session/{id}/message/{mid}/part/{pid} → single part (configured)
// Zero live opencode — Bun.serve HTTP only (AC: unit tests mock the server).

export interface StubCall {
  method: string;
  path: string;
  body?: unknown;
}

/** One message as served by GET /session/{id}/message (Message = { info, parts }). */
export interface StubMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

export interface StubBehavior {
  /** Respond 500 to GET /api/health. */
  unhealthy?: boolean;
  /** SSE events to emit on the session event stream. */
  events?: Array<Record<string, unknown>>;
  /** Close the event stream after the queued events (default: hold it open). */
  closeEvents?: boolean;
  /** Messages served by GET /session/{id}/message (crash-recovery refetch). */
  messages?: StubMessage[];
  /** Lookup table for GET /session/{id}/message/{mid}/part/{pid}, keyed by `${mid}:${pid}`. */
  parts?: Map<string, Record<string, unknown>>;
}

export interface StubServer {
  url: string;
  close(): void;
  calls: StubCall[];
  /** Prompt texts sent to each session via prompt_async, keyed by session id. */
  prompts: Map<string, string[]>;
  /** Most recent prompt text sent to any session. */
  lastPrompt(): string | undefined;
  sessionCreateCount(): number;
  abortCount(): number;
  /** Number of GET /session/{id}/message calls (refetch path). */
  messageListCount(): number;
}

export function startOpenCodeStub(behavior: StubBehavior = {}): StubServer {
  let nextId = 1;
  const calls: StubCall[] = [];
  const sessions = new Set<string>();
  const prompts = new Map<string, string[]>();
  let lastPromptText: string | undefined;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      calls.push({ method: req.method, path, body });

      if (req.method === "GET" && path === "/api/health") {
        return behavior.unhealthy
          ? Response.json({ healthy: false }, { status: 500 })
          : Response.json({ healthy: true });
      }

      if (req.method === "POST" && path === "/session") {
        const id = `ses_${nextId++}`;
        sessions.add(id);
        return Response.json({ id, title: "stub session" });
      }

      if (req.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path)) {
        const id = path.split("/")[2];
        const parts = (body as { parts?: Array<{ text?: string }> } | undefined)?.parts;
        const text = parts?.[0]?.text ?? "";
        lastPromptText = text;
        const list = prompts.get(id) ?? [];
        list.push(text);
        prompts.set(id, list);
        return new Response(null, { status: 204 });
      }

      if (req.method === "GET" && /^\/api\/session\/[^/]+\/event$/.test(path)) {
        const events = behavior.events ?? [];
        const payload = events
          .map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`)
          .join("");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (payload) controller.enqueue(new TextEncoder().encode(payload));
            if (behavior.closeEvents) controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) {
        const id = path.split("/")[2];
        if (!sessions.has(id)) return Response.json({ error: "stub: not found" }, { status: 404 });
        return Response.json(true);
      }

      if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(path)) {
        return Response.json(behavior.messages ?? []);
      }

      if (req.method === "GET" && /^\/session\/[^/]+\/message\/[^/]+\/part\/[^/]+$/.test(path)) {
        const [, , , messageId, , partId] = path.split("/");
        const part = behavior.parts?.get(`${messageId}:${partId}`);
        if (!part) return Response.json({ error: "stub: part not found" }, { status: 404 });
        return Response.json(part);
      }

      return Response.json({ error: "stub: not found" }, { status: 404 });
    },
  });

  return {
    url: server.url.origin,
    close: () => server.stop(true),
    calls,
    prompts,
    lastPrompt: () => lastPromptText,
    sessionCreateCount: () => calls.filter((c) => c.method === "POST" && c.path === "/session").length,
    abortCount: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/abort")).length,
    messageListCount: () => calls.filter((c) => c.method === "GET" && c.path.endsWith("/message")).length,
  };
}