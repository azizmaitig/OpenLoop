import { describe, expect, test } from "bun:test";
import { createFetchHandler } from "../src/routes.js";
import type { DaemonAPI } from "../src/daemon-api.js";
import { TaskQueue } from "../src/task-queue.js";
import { LoopOrchestrator } from "../src/orchestrator.js";
import { TriggerManager } from "../src/triggers.js";

// ── Mock DaemonAPI (no I/O) ──────────────────────────────────────────────────

function mockAPI(overrides?: Partial<DaemonAPI>): DaemonAPI {
  const taskQueue = new TaskQueue();
  const triggerManager = new TriggerManager();
  const orchestrator = new LoopOrchestrator(taskQueue, triggerManager);
  return {
    getState: () => ({
      status: "running" as const,
      uptime: 42,
      queueLength: 0,
      currentTask: null,
      startTime: new Date().toISOString(),
      version: "8.0.0",
      pid: process.pid,
      port: 3000,
    }),
    stop: () => {},
    isAuthorized: () => true,
    isPaused: async () => false,
    broadcast: () => {},
    maybeProcessQueue: () => {},
    callLLM: async () => 'mock-llm-response',
    saveTaskHistory: async () => '',
    readTaskHistory: async () => null,
    listTaskHistory: async () => ({ tasks: [], total: 0, page: 1, pageSize: 20 }),
    updateStateMd: async () => {},
    isSafeCommand: (cmd: string) => !/[;&|`$\n\r]/.test(cmd),
    taskQueue,
    orchestrator,
    triggerManager,
    baseDir: ".",
    dashboardHtml: "<html>mock dashboard</html>",
    startedAt: Date.now() - 42000,
    server: null,
    wsClients: new Set(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("routes — createFetchHandler", () => {
  test("GET /health returns uptime", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.uptime).toBeGreaterThanOrEqual(41);
  });

  test("GET /state returns daemon state", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/state"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(typeof body.uptime).toBe("number");
  });

  test("GET /api/version returns version string", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/api/version"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("8.0.0");
  });

  test("POST /stop returns ok and calls stop()", async () => {
    let stopped = false;
    const handler = createFetchHandler(mockAPI({ stop: () => { stopped = true; } }));
    const res = await handler(new Request("http://test/stop", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    // stop() is called via setTimeout so we wait briefly
    await new Promise(r => setTimeout(r, 80));
    expect(stopped).toBe(true);
  });

  test("POST /stop returns 401 when unauthorized", async () => {
    const handler = createFetchHandler(mockAPI({ isAuthorized: () => false }));
    const res = await handler(new Request("http://test/stop", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("POST /task with valid command returns 201", async () => {
    const api = mockAPI();
    const handler = createFetchHandler(api);
    const res = await handler(new Request("http://test/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hello" }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.lifecycle).toBe("queued");
    expect(api.taskQueue.length).toBe(1);
  });

  test("POST /task with empty command returns 400", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "" }),
    }));
    expect(res.status).toBe(400);
  });

  test("POST /task with unsafe command returns 400", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hello; rm -rf /" }),
    }));
    expect(res.status).toBe(400);
  });

  test("GET /dashboard returns HTML", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/dashboard"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("mock dashboard");
  });

  test("unknown route returns 404", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/nonexistent"));
    expect(res.status).toBe(404);
  });

  test("GET /api/pause returns paused state", async () => {
    const handler = createFetchHandler(mockAPI({ isPaused: async () => true }));
    const res = await handler(new Request("http://test/api/pause"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
  });

  test("POST /api/pause sets pause state and calls maybeProcessQueue on unpause", async () => {
    let unpaused = false;
    const handler = createFetchHandler(mockAPI({
      maybeProcessQueue: () => { unpaused = true; },
    }));
    const res = await handler(new Request("http://test/api/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    }));
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    expect(unpaused).toBe(true);
  });

  test("POST /api/pause with invalid body returns 400", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/api/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    }));
    expect(res.status).toBe(400);
  });

  // ── Seam coverage: routes reach LLM / history / state purely through DaemonAPI ──

  test("POST /api/llm calls api.callLLM and returns the response", async () => {
    let called = false;
    const handler = createFetchHandler(mockAPI({
      callLLM: async () => { called = true; return "llm-out"; },
    }));
    const res = await handler(new Request("http://test/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(called).toBe(true);
    expect(body.response).toBe("llm-out");
  });

  test("POST /api/llm with empty prompt returns 400", async () => {
    const handler = createFetchHandler(mockAPI());
    const res = await handler(new Request("http://test/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    }));
    expect(res.status).toBe(400);
  });

  test("GET /api/history calls api.listTaskHistory", async () => {
    let called = false;
    const handler = createFetchHandler(mockAPI({
      listTaskHistory: async () => { called = true; return { tasks: [], total: 0, page: 2, pageSize: 5 }; },
    }));
    const res = await handler(new Request("http://test/api/history?page=2&pageSize=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(called).toBe(true);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(5);
  });

  test("GET /api/tasks/:id calls api.readTaskHistory and 404s when missing", async () => {
    let called = false;
    const handler = createFetchHandler(mockAPI({
      readTaskHistory: async () => { called = true; return null; },
    }));
    const res = await handler(new Request("http://test/api/tasks/ghost"));
    expect(res.status).toBe(404);
    expect(called).toBe(true);
  });
});
