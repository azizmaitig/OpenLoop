/**
 * agent-stub.ts — shared stub Agent Server for T2 executor tests.
 *
 * Implements the REAL Agent Server conversation contract (verified against
 * the live server, 2026-08-18 smoke test):
 *   GET    /health                          → health (NOT /api/health)
 *   POST   /api/conversations               → create ({ workspace, agent.llm, initial_message })
 *   POST   /api/conversations/{id}/events   → send a message ({ role, content: [TextContent] })
 *   GET    /api/conversations/{id}          → poll (execution_status + events)
 *   GET    /api/conversations/{id}/agent_final_response → final agent text
 *   DELETE /api/conversations/{id}          → cleanup
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
  execution_status: string;
  events: StubAgentEvent[];
  lastUserText: string;
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
  /** Respond 500 to GET /health (default healthy). */
  healthy?: boolean;
  /** Respond 500 to GET agent_final_response (forces the executor's event fallback). */
  failFinalResponse?: boolean;
  /** Respond with legacy `status` instead of `execution_status` (tests the client's normalization). */
  legacyStatus?: boolean;
}

export interface StubServer {
  url: string;
  close(): void;
  calls: StubCall[];
  conversations: Map<string, StubConversation>;
  /** The id of the most recently created conversation (survives DELETE cleanup). */
  createdId?: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => typeof p === "object" && p !== null)
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

export function startAgentStub(behavior: StubBehavior = {}): StubServer {
  const statusField = (conv: StubConversation): Record<string, string> =>
    behavior.legacyStatus ? { status: conv.execution_status } : { execution_status: conv.execution_status };
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

      if (req.method === "GET" && path === "/health") {
        return behavior.healthy === false
          ? Response.json({ status: "unhealthy" }, { status: 500 })
          : Response.json({ status: "ok" });
      }

      if (req.method === "POST" && path === "/api/conversations") {
        if (behavior.failCreate) {
          return Response.json({ error: "stub: create failed" }, { status: 500 });
        }
        const b = (body ?? {}) as {
          workspace?: { working_dir?: string };
          agent?: { llm?: unknown };
          initial_message?: { content?: unknown };
        };
        const text = textFromContent(b.initial_message?.content);
        const conv: StubConversation = {
          id: `conv-${nextId++}`,
          execution_status: "running",
          events: [],
          lastUserText: text,
        };
        conv.events.push({ type: "message", source: "user", content: text });
        conv.events.push({ type: "message", source: "agent", content: `agent reply to: ${text}` });
        conversations.set(conv.id, conv);
        createdId = conv.id;
        return Response.json({ id: conv.id, ...statusField(conv), events: [] });
      }

      if (req.method === "POST" && /^\/api\/conversations\/[^/]+\/events$/.test(path)) {
        const id = path.split("/")[3];
        const conv = conversations.get(id);
        if (!conv) return Response.json({ error: "stub: conversation not found" }, { status: 404 });
        const b = (body ?? {}) as { content?: unknown };
        const text = textFromContent(b.content);
        conv.lastUserText = text;
        conv.events.push({ type: "message", source: "user", content: text });
        conv.events.push({ type: "message", source: "agent", content: `agent reply to: ${text}` });
        return Response.json({ ok: true });
      }

      if (req.method === "GET" && /^\/api\/conversations\/[^/]+\/agent_final_response$/.test(path)) {
        const id = path.split("/")[3];
        const conv = conversations.get(id);
        if (!conv) return Response.json({ error: "stub: conversation not found" }, { status: 404 });
        if (behavior.failFinalResponse) {
          return Response.json({ error: "stub: final response unavailable" }, { status: 500 });
        }
        return Response.json({ response: `agent reply to: ${conv.lastUserText}` });
      }

      if (req.method === "GET" && /^\/api\/conversations\/[^/]+$/.test(path)) {
        const id = path.split("/")[3];
        const conv = conversations.get(id);
        if (!conv) return Response.json({ error: "stub: conversation not found" }, { status: 404 });
        if (behavior.terminalStatus && conv.execution_status === "running") {
          polls++;
          if (polls >= (behavior.terminalAfter ?? 1)) {
            conv.execution_status = behavior.terminalStatus;
            conv.events.push({ type: "status_changed", source: "system", content: behavior.terminalStatus });
          }
        }
        return Response.json({ id: conv.id, ...statusField(conv), events: conv.events });
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