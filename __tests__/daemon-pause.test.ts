import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-loop-pause-"));
}

const defaultFm = `---
last_run: "2026-07-05T12:00:00.000Z"
current_state: running
iteration: 0
active_children: 0
high_priority: 0
watch_items: 0
task_count: 0
---

# Agent Loop
`;

function stateMdPausedTrue(): string {
  return `---
last_run: "2026-07-05T12:00:00.000Z"
current_state: running
iteration: 0
active_children: 0
high_priority: 0
watch_items: 0
task_count: 0
paused: true
---

# Agent Loop
`;
}

describe("Daemon pause/resume", () => {
  test("GET /api/pause returns false when STATE.md has no paused flag", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/api/pause`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ paused: false });
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GET /api/pause returns true when STATE.md has paused: true", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), stateMdPausedTrue());

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/api/pause`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ paused: true });
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GET /api/pause returns false when STATE.md does not exist", async () => {
    const dir = await tempDir();

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const resp = await fetch(`http://localhost:${d.getState().port}/api/pause`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ paused: false });
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause with paused:true updates STATE.md and is reflected in GET", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      // Set paused
      const setResp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      });
      expect(setResp.status).toBe(200);
      const setBody = await setResp.json();
      expect(setBody).toEqual({ status: "ok", paused: true });

      // Verify via GET
      const getResp = await fetch(`http://localhost:${port}/api/pause`);
      const getBody = await getResp.json();
      expect(getBody).toEqual({ paused: true });

      // Verify STATE.md on disk contains paused: true
      const content = await readFile(join(dir, "STATE.md"), "utf-8");
      expect(content).toContain("paused: true");
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause with paused:false clears paused flag from STATE.md", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), stateMdPausedTrue());

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      // Ensure we start paused
      const preResp = await fetch(`http://localhost:${port}/api/pause`);
      expect((await preResp.json()).paused).toBe(true);

      // Unpause
      const resumeResp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      });
      expect(resumeResp.status).toBe(200);
      expect((await resumeResp.json())).toEqual({ status: "ok", paused: false });

      // Verify via GET
      const getResp = await fetch(`http://localhost:${port}/api/pause`);
      expect((await getResp.json())).toEqual({ paused: false });
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause with non-boolean paused returns 400", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      const resp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: "yes" }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toBeDefined();
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause with invalid JSON returns 400", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      const resp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(resp.status).toBe(400);
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause rejects unauthorized requests when LOOP_API_KEY is set", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      // Temporarily set key
      const origKey = process.env.LOOP_API_KEY;
      process.env.LOOP_API_KEY = "secret-key";

      const resp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      });
      expect(resp.status).toBe(401);
      const body = await resp.json();
      expect(body.error).toBe("unauthorized");

      if (origKey === undefined) {
        delete process.env.LOOP_API_KEY;
      } else {
        process.env.LOOP_API_KEY = origKey;
      }
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("POST /api/pause succeeds with correct Bearer token", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), defaultFm);

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      const origKey = process.env.LOOP_API_KEY;
      process.env.LOOP_API_KEY = "secret-key";

      const resp = await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-key",
        },
        body: JSON.stringify({ paused: true }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ status: "ok", paused: true });

      if (origKey === undefined) {
        delete process.env.LOOP_API_KEY;
      } else {
        process.env.LOOP_API_KEY = origKey;
      }
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tasks stay queued when daemon is paused", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), stateMdPausedTrue());

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      // Enqueue a task while paused
      const taskResp = await fetch(`http://localhost:${port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello" }),
      });
      expect(taskResp.status).toBe(201);
      const taskBody = await taskResp.json();

      // Give the daemon a moment to attempt processing (which it should skip)
      await new Promise((r) => setTimeout(r, 200));

      // Task should still be queued (never dequeued)
      const stateResp = await fetch(`http://localhost:${port}/state`);
      const stateBody = await stateResp.json();
      expect(stateBody.queueLength).toBeGreaterThanOrEqual(1);
      expect(stateBody.currentTask).toBeNull();
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tasks execute after unpausing", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "STATE.md"), stateMdPausedTrue());

    const d = new Daemon(0, dir);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      // Enqueue a task while paused
      const taskResp = await fetch(`http://localhost:${port}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello" }),
      });
      expect(taskResp.status).toBe(201);
      const taskBody = await taskResp.json();

      // Wait briefly — task should remain queued
      await new Promise((r) => setTimeout(r, 200));

      let stateResp = await fetch(`http://localhost:${port}/state`);
      let stateBody = await stateResp.json();
      expect(stateBody.queueLength).toBe(1);

      // Unpause — this triggers maybeProcessQueue
      await fetch(`http://localhost:${port}/api/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      });

      // Wait for the daemon to execute
      await new Promise((r) => setTimeout(r, 500));

      // Task should now be completed
      stateResp = await fetch(`http://localhost:${port}/state`);
      stateBody = await stateResp.json();
      expect(stateBody.queueLength).toBe(0);
    } finally {
      d.stop();
      await startPromise;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
