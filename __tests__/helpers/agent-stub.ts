/**
 * agent-stub.ts — shared stub Agent Server for T2 executor tests.
 *
 * Implements the minimal conversation contract the executor talks to:
 *   POST   /api/conversations                → create (returns { id, status, events })
 *   POST   /api/conversations/{id}/events    → send a message (agent replies)
 *   GET    /api/conversations/{id}           → poll (status + events)
 *   DELETE /api/conversations/{id}           → cleanup
 *
 * Zero live OpenHands/Python — Bun.serve HTTP only (AC: tests use a stubbed
 * endpoint). Behavior is per-test configurable via `behavior`.
 */

export interface StubAgentEvent {
  type: string;
  source?: string;
  content?: string;
}

export interface StubConversation {
  id: string;
  status: string;
  events: StubAgentEvent[];
}

export interface StubCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface StubBehavior {
  /** Terminal status to flip to after `terminalAfter` polls. undefined = stays running forever. */
  terminalStatus?: string;
  /** How many getConversation polls before the terminal status is applied (default 1). */
  terminalAfter?: number;
  /** Respond 500 to POST /api/conversations. */
  failCreate?: boolean;
}

export interface StubServer {
  url: string;
  close(): void;
  calls: StubCall[];
  conversations: Map<string, StubConversation>;
  /** The id of the most recently created conversation (survives DELETE cleanup). */
  createdId?: string;
}

export function startAgentStub(behavior: StubBehavior = {}): StubServer {
  let nextId = 1;
  let polls = 0;
  let createdId: string | undefined;
  const calls: StubCall[] = [];
  const conversations = new Map<string, StubConversation>();

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

      if (req.method === "POST" && path === "/api/conversations") {
        if (behavior.failCreate) {
          return Response.json({ error: "stub: create failed" }, { status: 500 });
        }
        const conv: StubConversation = { id: `conv-${nextId++}`, status: "running", events: [] };
        conversations.set(conv.id, conv);
        createdId = conv.id;
        return Response.json(conv);
      }

      if (req.method === "POST" && /^\/api\/conversations\/[^/]+\/events$/.test(path)) {
        const id = path.split("/")[3];
        const conv = conversations.get(id);
        if (!conv) return Response.json({ error: "stub: conversation not found" }, { status: 404 });
        const content = (body as { content?: string })?.content ?? "";
        conv.events.push({ type: "message", source: "user", content });
        conv.events.push({ type: "message", source: "agent", content: `agent reply to: ${content}` });
        return Response.json({ ok: true });
      }

      if (req.method === "GET" && /^\/api\/conversations\/[^/]+$/.test(path)) {
        const id = path.split("/")[3];
        const conv = conversations.get(id);
        if (!conv) return Response.json({ error: "stub: conversation not found" }, { status: 404 });
        if (behavior.terminalStatus && conv.status === "running") {
          polls++;
          if (polls >= (behavior.terminalAfter ?? 1)) {
            conv.status = behavior.terminalStatus;
            conv.events.push({ type: "status_changed", source: "system", content: behavior.terminalStatus });
          }
        }
        return Response.json(conv);
      }

      if (req.method === "DELETE" && /^\/api\/conversations\/[^/]+$/.test(path)) {
        const id = path.split("/")[3];
        conversations.delete(id);
        return Response.json({ ok: true });
      }

      return Response.json({ error: "stub: not found" }, { status: 404 });
    },
  });

  return {
    url: server.url.origin,
    close: () => server.stop(true),
    calls,
    conversations,
    get createdId() {
      return createdId;
    },
  };
}

/** Pull the conversation id the executor created (the first POST /api/conversations). */
export function createdConversationId(stub: StubServer): string | undefined {
  return stub.createdId;
}