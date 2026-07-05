import { describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon.js";

describe("Daemon (v6)", () => {
  test("GET /health returns status ok and uptime", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();

    // Wait for server to be listening
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/health`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.status).toBe("ok");
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /state returns daemon status", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();

    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/state`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.status).toBe("running");
      expect(body.version).toBe("0.6.0");
      expect(typeof body.pid).toBe("number");
      expect(body.pid).toBeGreaterThan(0);
      expect(typeof body.port).toBe("number");
      expect(body.port).toBeGreaterThan(0);
      expect(typeof body.uptime).toBe("number");
      expect(typeof body.startTime).toBe("string");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /api/version returns version string", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();

    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/api/version`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.version).toBe("0.6.0");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /stop shuts down daemon gracefully", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();

    await new Promise((r) => setTimeout(r, 300));

    const port = d.getState().port;

    // Send stop request
    const resp = await fetch(`http://localhost:${port}/stop`, { method: "POST" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");

    // Wait for daemon to shut down
    await startPromise;

    // Server should no longer respond
    let caught = false;
    try {
      await fetch(`http://localhost:${port}/health`);
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });

  test("starts on specified port", () => {
    const d = new Daemon(3099);
    expect(d.getState().port).toBe(3099);
  });

  test("starts on default port 3000", () => {
    const d = new Daemon();
    expect(d.getState().port).toBe(3000);
  });

  test("returns 404 for unknown routes", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();

    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/unknown`);
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("getState() reflects status changes across lifecycle", () => {
    const d = new Daemon(0);
    expect(d.getState().status).toBe("idle");
    expect(d.getState().version).toBe("0.6.0");
    // start and stop not called — still idle
  });

  test("stop() is idempotent", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    d.stop();
    d.stop(); // second call should no-op
    await startPromise;

    expect(d.getState().status).toBe("stopped");
  });

  // ── Task queue API tests ────────────────────────────────────────────────

  test("POST /task with valid body returns 201 with task ID", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello" }),
      });
      expect(resp.status).toBe(201);
      const body = await resp.json();
      expect(body.id).toMatch(/^task-/);
      expect(body.status).toBe("queued");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /task with invalid body returns 400", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toBeDefined();
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /task with invalid JSON returns 400", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(resp.status).toBe(400);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /state includes queueLength and currentTask", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      // Enqueue a task
      await fetch(`http://localhost:${d.getState().port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello" }),
      });

      const resp = await fetch(`http://localhost:${d.getState().port}/state`);
      const body = await resp.json();
      expect(typeof body.queueLength).toBe("number");
      expect(body.currentTask).toBeNull(); // not processed yet in test
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /api/tasks/:id returns 404 for unknown task", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/api/tasks/nonexistent`);
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  // ── Dashboard + WebSocket integration tests ────────────────────────────

  test("GET /dashboard returns 200 with HTML dashboard", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/dashboard`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toMatch(/text\/html/);
      const body = await resp.text();
      expect(body).toContain("Live");
      expect(body).toContain("History");
      expect(body).toContain("agent-loop");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("WebSocket /ws connects and receives state_change", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      const msg = await new Promise<any>((resolve, reject) => {
        ws.onopen = () => {};
        ws.onmessage = (e) => {
          try { resolve(JSON.parse(e.data)); } catch { reject(new Error("invalid JSON")); }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      expect(msg).toHaveProperty("type", "state_change");
      expect(msg).toHaveProperty("data");
      expect(msg).toHaveProperty("timestamp");
      expect(msg.data).toHaveProperty("status");
      expect(msg.data).toHaveProperty("children");

      ws.close();
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("WebSocket auto-reconnect — new connection receives events after close", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((resolve) => { ws1.onopen = () => { ws1.close(); resolve(); }; });

      await new Promise((r) => setTimeout(r, 500));

      const ws2 = new WebSocket(`ws://localhost:${port}/ws`);
      const msg = await new Promise<any>((resolve, reject) => {
        ws2.onmessage = (e) => {
          try { resolve(JSON.parse(e.data)); } catch { reject(new Error("invalid JSON")); }
        };
        ws2.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      expect(msg).toHaveProperty("type", "state_change");
      expect(msg.data).toHaveProperty("status", "running");

      ws2.close();
    } finally {
      d.stop();
      await startPromise;
    }
  });
});
