import { describe, expect, test } from "bun:test";
import { createOpenCodeClient, OpenCodeApiError } from "../src/opencode-client.js";
import type { OpenCodeClient, OpenCodeSession } from "../src/opencode-client.js";

// ── Mock opencode server ──────────────────────────────────────────────────────
// Implements the REAL opencode HTTP surface (verified against the live server's
// OpenAPI 3.1.0 doc at /doc, 2026-08-19):
//   GET  /api/health              → { healthy: true }
//   POST /session                 → create ({ title?, agent?, model?, permission? })
//   GET  /session                 → list (Session[])
//   GET  /session/{id}            → get (Session)
//   POST /session/{id}/abort      → abort (true)
// Zero live opencode — Bun.serve HTTP only (AC: unit tests mock the server).

interface StubCall {
  method: string;
  path: string;
  body?: unknown;
}

interface StubBehavior {
  /** Respond 500 to GET /api/health (default healthy). */
  healthy?: boolean;
  /** Respond 200 with { healthy: false } — payload, not status, is the contract. */
  healthyBodyFalse?: boolean;
  /** Never respond to GET /api/health — proves the client's probe is time-bounded. */
  hangHealth?: boolean;
  /** Respond 500 to POST /session. */
  failCreate?: boolean;
}

interface StubServer {
  url: string;
  close(): void;
  calls: StubCall[];
  sessions: Map<string, OpenCodeSession>;
  createdId?: string;
}

function startOpenCodeStub(behavior: StubBehavior = {}): StubServer {
  let nextId = 1;
  let createdId: string | undefined;
  const calls: StubCall[] = [];
  const sessions = new Map<string, OpenCodeSession>();

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
        if (behavior.hangHealth) {
          // Never respond — the client's AbortSignal.timeout must bound the probe.
          return new Promise<Response>(() => {});
        }
        if (behavior.healthyBodyFalse) {
          return Response.json({ healthy: false });
        }
        return behavior.healthy === false
          ? Response.json({ healthy: false }, { status: 500 })
          : Response.json({ healthy: true });
      }

      if (req.method === "POST" && path === "/session") {
        if (behavior.failCreate) {
          return Response.json({ error: "stub: create failed" }, { status: 500 });
        }
        const b = (body ?? {}) as { agent?: string; model?: unknown; permission?: unknown };
        const session: OpenCodeSession = {
          id: `ses_${nextId++}`,
          title: "stub session",
          agent: b.agent,
          model: b.model as OpenCodeSession["model"],
          directory: process.cwd(),
          time: { created: Date.now(), updated: Date.now() },
        };
        sessions.set(session.id, session);
        createdId = session.id;
        return Response.json(session);
      }

      if (req.method === "GET" && path === "/session") {
        return Response.json([...sessions.values()]);
      }

      if (req.method === "GET" && /^\/session\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const session = sessions.get(id);
        if (!session) return Response.json({ error: "stub: session not found" }, { status: 404 });
        return Response.json(session);
      }

      if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) {
        const id = path.split("/")[2];
        if (!sessions.has(id)) return Response.json({ error: "stub: session not found" }, { status: 404 });
        return Response.json(true);
      }

      return Response.json({ error: "stub: not found" }, { status: 404 });
    },
  });

  return {
    url: server.url.origin,
    close: () => server.stop(true),
    calls,
    sessions,
    get createdId() {
      return createdId;
    },
  };
}

// ── createOpenCodeClient ──────────────────────────────────────────────────────

describe("createOpenCodeClient", () => {
  test("checkHealth returns true when the server is healthy", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      expect(await client.checkHealth()).toBe(true);
    } finally {
      stub.close();
    }
  });

  test("checkHealth returns false when the server reports unhealthy", async () => {
    const stub = startOpenCodeStub({ healthy: false });
    try {
      const client = createOpenCodeClient(stub.url);
      expect(await client.checkHealth()).toBe(false);
    } finally {
      stub.close();
    }
  });

  test("checkHealth returns false on 200 with { healthy: false }", async () => {
    const stub = startOpenCodeStub({ healthyBodyFalse: true });
    try {
      const client = createOpenCodeClient(stub.url);
      expect(await client.checkHealth()).toBe(false);
      await expect(client.assertHealthy()).rejects.toThrow(/not healthy/);
    } finally {
      stub.close();
    }
  });

  test("base URL with a trailing slash is normalized (no //session 404)", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(`${stub.url}/`);
      expect(await client.checkHealth()).toBe(true);
      const session = await client.createSession({ agent: "build" });
      expect(session.id).toMatch(/^ses_/);
      expect(stub.calls.some((c) => c.path === "/session")).toBe(true);
      expect(stub.calls.some((c) => c.path === "//session")).toBe(false);
    } finally {
      stub.close();
    }
  });

  test("assertHealthy throws a clear diagnostic when the server is down", async () => {
    const stub = startOpenCodeStub({ healthy: false });
    try {
      const client = createOpenCodeClient(stub.url);
      await expect(client.assertHealthy()).rejects.toThrow(
        `opencode server at ${stub.url} is not healthy — is \`opencode serve\` running?`,
      );
    } finally {
      stub.close();
    }
  });

  test("checkHealth never hangs when the server never responds", async () => {
    const stub = startOpenCodeStub({ hangHealth: true });
    try {
      const client = createOpenCodeClient(stub.url);
      const started = Date.now();
      expect(await client.checkHealth()).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000); // bounded by the health timeout
    } finally {
      stub.close();
    }
  });

  test("createSession POSTs to /session with agent/model/permission and surfaces the ses_ id", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      const session = await client.createSession({
        agent: "build",
        model: { id: "deepseek-v4-flash-free", providerID: "opencode" },
        permissionMode: [{ permission: "edit", pattern: ".env", action: "deny" }],
      });
      expect(session.id).toMatch(/^ses_/);
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/session");
      expect(create?.body).toEqual({
        agent: "build",
        model: { id: "deepseek-v4-flash-free", providerID: "opencode" },
        permission: [{ permission: "edit", pattern: ".env", action: "deny" }],
      });
    } finally {
      stub.close();
    }
  });

  test("createSession with no opts sends an empty body", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      const session = await client.createSession();
      expect(session.id).toMatch(/^ses_/);
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/session");
      expect(create?.body).toEqual({});
    } finally {
      stub.close();
    }
  });

  test("listSessions GETs /session and returns the sessions", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      await client.createSession({ agent: "build" });
      await client.createSession({ agent: "plan" });
      const sessions = await client.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions.map((s) => s.agent)).toEqual(["build", "plan"]);
      expect(stub.calls.some((c) => c.method === "GET" && c.path === "/session")).toBe(true);
    } finally {
      stub.close();
    }
  });

  test("getSession GETs /session/{id} and returns the session", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      const created = await client.createSession({ agent: "build" });
      const fetched = await client.getSession(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.agent).toBe("build");
      expect(stub.calls.some((c) => c.method === "GET" && c.path === `/session/${created.id}`)).toBe(true);
    } finally {
      stub.close();
    }
  });

  test("abortSession POSTs to /session/{id}/abort", async () => {
    const stub = startOpenCodeStub();
    try {
      const client = createOpenCodeClient(stub.url);
      const created = await client.createSession();
      await client.abortSession(created.id);
      expect(stub.calls.some((c) => c.method === "POST" && c.path === `/session/${created.id}/abort`)).toBe(true);
    } finally {
      stub.close();
    }
  });

  test("non-2xx responses surface a typed error with status and message", async () => {
    const stub = startOpenCodeStub({ failCreate: true });
    try {
      const client = createOpenCodeClient(stub.url);
      const err = await client.createSession().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenCodeApiError);
      expect((err as OpenCodeApiError).status).toBe(500);
      expect((err as OpenCodeApiError).message).toContain("stub: create failed");
    } finally {
      stub.close();
    }
  });

  test("works against any base URL — no hardcoded :4096 (the :4097 shim is config-only)", async () => {
    const stub = startOpenCodeStub();
    try {
      expect(stub.url).not.toContain(":4096");
      const client = createOpenCodeClient(stub.url);
      const session = await client.createSession({ agent: "build" });
      expect(session.id).toMatch(/^ses_/);
      expect(await client.listSessions()).toHaveLength(1);
    } finally {
      stub.close();
    }
  });
});

// ── stub helper is a real server, so give the harness a moment-free teardown ──
test("stub helper starts on an ephemeral port", () => {
  const stub = startOpenCodeStub();
  try {
    expect(new URL(stub.url).port).toMatch(/^\d+$/);
  } finally {
    stub.close();
  }
});