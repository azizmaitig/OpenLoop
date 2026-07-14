import { describe, expect, test, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LoopOrchestrator } from "../src/orchestrator.js";
import { TaskQueue } from "../src/task-queue.js";
import { TriggerManager } from "../src/triggers.js";
import { Daemon } from "../src/daemon.js";

function makeOrchestrator(): LoopOrchestrator {
  return new LoopOrchestrator(new TaskQueue(), new TriggerManager());
}

describe("LoopOrchestrator", () => {
  let orch: LoopOrchestrator;

  beforeEach(() => {
    orch = makeOrchestrator();
  });

  test("addChild returns an ID and adds to list", () => {
    const id = orch.addChild({ name: "test-loop", planPath: "./plan.yaml" });
    expect(id).toMatch(/^child-/);
    expect(orch.listChildren()).toHaveLength(1);
  });

  test("addChild with watchDir creates fileWatch trigger", () => {
    const id = orch.addChild({ name: "watcher", planPath: "./p.yaml", watchDir: "./incoming" });
    const state = orch.getChildState(id);
    expect(state).not.toBeNull();
    expect(state!.triggers).toHaveLength(1);
    expect(state!.triggers[0].type).toBe("fileWatch");
    expect((state!.triggers[0] as any).watchDir).toBe("./incoming");
  });

  test("addChild enabled defaults to true", () => {
    const id = orch.addChild({ name: "default-enabled", planPath: "./p.yaml" });
    expect(orch.getChildState(id)!.enabled).toBe(true);
  });

  test("addChild respects enabled: false", () => {
    const id = orch.addChild({ name: "disabled", planPath: "./p.yaml", enabled: false });
    expect(orch.getChildState(id)!.enabled).toBe(false);
  });

  test("removeChild removes from list", () => {
    const id = orch.addChild({ name: "removable", planPath: "./p.yaml" });
    expect(orch.listChildren()).toHaveLength(1);
    expect(orch.removeChild(id)).toBe(true);
    expect(orch.listChildren()).toHaveLength(0);
  });

  test("removeChild returns false for unknown id", () => {
    expect(orch.removeChild("nonexistent")).toBe(false);
  });

  test("getChildState returns null for unknown id", () => {
    expect(orch.getChildState("nonexistent")).toBeNull();
  });

  test("listChildren returns summary with correct fields", () => {
    orch.addChild({ name: "c1", planPath: "./p1.yaml" });
    orch.addChild({ name: "c2", planPath: "./p2.yaml", enabled: false });

    const list = orch.listChildren();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("c1");
    expect(list[0].planPath).toBe("./p1.yaml");
    expect(list[0].triggerCount).toBe(0);
    expect(list[0].enabled).toBe(true);
    expect(list[1].name).toBe("c2");
    expect(list[1].enabled).toBe(false);
  });

  test("startChild changes status to running", async () => {
    const id = orch.addChild({ name: "runnable", planPath: "./p.yaml" });
    expect(orch.getChildState(id)!.status).toBe("stopped");

    const started = await orch.startChild(id);
    expect(started).toBe('ok');
    expect(orch.getChildState(id)!.status).toBe("running");
    expect(orch.getChildState(id)!.startedAt).toBeDefined();
  });

  test("startChild returns false for unknown id", async () => {
    const started = await orch.startChild("nope");
    expect(started).toBe('not_found');
  });

  test("startChild returns false if already running", async () => {
    const id = orch.addChild({ name: "already", planPath: "./p.yaml" });
    await orch.startChild(id);
    const second = await orch.startChild(id);
    expect(second).toBe('already_running');
  });

  test("stopChild changes status back to stopped", async () => {
    const id = orch.addChild({ name: "stoppable", planPath: "./p.yaml" });
    await orch.startChild(id);
    expect(orch.getChildState(id)!.status).toBe("running");

    const stopped = await orch.stopChild(id);
    expect(stopped).toBe('ok');
    expect(orch.getChildState(id)!.status).toBe("stopped");
  });

  test("stopChild returns false if not running", async () => {
    const id = orch.addChild({ name: "not-running", planPath: "./p.yaml" });
    const stopped = await orch.stopChild(id);
    expect(stopped).toBe('not_running');
  });

  test("stopChild returns false for unknown id", async () => {
    const stopped = await orch.stopChild("nope");
    expect(stopped).toBe('not_found');
  });

  test("removeChild on running child stops it first", async () => {
    const id = orch.addChild({ name: "running-remove", planPath: "./p.yaml" });
    await orch.startChild(id);
    expect(orch.removeChild(id)).toBe(true);
    expect(orch.listChildren()).toHaveLength(0);
  });
});

describe("LoopOrchestrator — trigger integration", () => {
  test("startChild with cron trigger registers with TriggerManager", async () => {
    const tq = new TaskQueue();
    const tm = new TriggerManager();
    const orch = new LoopOrchestrator(tq, tm);

    const id = orch.addChild({
      name: "cron-child",
      planPath: "./p.yaml",
      triggers: [{ type: "cron", expression: "0 9 * * *" }],
    });

    await orch.startChild(id);
    const triggers = tm.list();
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("cron");
    expect(triggers[0].running).toBe(true);
  });

  test("startChild with fileWatch trigger registers with TriggerManager", async () => {
    const tq = new TaskQueue();
    const tm = new TriggerManager();
    const orch = new LoopOrchestrator(tq, tm);

    const tmpDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
    const id = orch.addChild({
      name: "watch-child",
      planPath: "./p.yaml",
      watchDir: tmpDir,
    });

    await orch.startChild(id);
    const triggers = tm.list();
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("fileWatch");

    tm.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stopChild deregisters triggers", async () => {
    const tq = new TaskQueue();
    const tm = new TriggerManager();
    const orch = new LoopOrchestrator(tq, tm);

    const id = orch.addChild({
      name: "stop-me",
      planPath: "./p.yaml",
      triggers: [{ type: "cron", expression: "0 9 * * *" }],
    });

    await orch.startChild(id);
    expect(tm.list()).toHaveLength(1);

    await orch.stopChild(id);
    expect(tm.list()).toHaveLength(0);
  });
});

describe("LoopOrchestrator — API integration", () => {
  test("POST /loops creates child, appears in GET /loops", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;

      const postResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "api-loop", planPath: "./plan.yaml" }),
      });
      expect(postResp.status).toBe(201);
      const postBody = await postResp.json();
      expect(postBody.id).toMatch(/^child-/);

      const getResp = await fetch(`http://localhost:${port}/loops`);
      expect(getResp.status).toBe(200);
      const list = await getResp.json();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("api-loop");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops with missing fields returns 400", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-planpath" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /loops/:id returns single child state", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "single", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      const getResp = await fetch(`http://localhost:${port}/loops/${id}`);
      expect(getResp.status).toBe(200);
      const state = await getResp.json();
      expect(state.name).toBe("single");
      expect(state.planPath).toBe("./p.yaml");
      expect(state.status).toBe("stopped");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("GET /loops/:id returns 404 for unknown id", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops/nonexistent`);
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/start starts a child loop", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "startable", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      const startResp = await fetch(`http://localhost:${port}/loops/${id}/start`, { method: "POST" });
      expect(startResp.status).toBe(200);

      const stateResp = await fetch(`http://localhost:${port}/loops/${id}`);
      const state = await stateResp.json();
      expect(state.status).toBe("running");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/stop stops a running child", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "stoppable", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      await fetch(`http://localhost:${port}/loops/${id}/start`, { method: "POST" });
      const stopResp = await fetch(`http://localhost:${port}/loops/${id}/stop`, { method: "POST" });
      expect(stopResp.status).toBe(200);

      const stateResp = await fetch(`http://localhost:${port}/loops/${id}`);
      const state = await stateResp.json();
      expect(state.status).toBe("stopped");
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/start for already-running returns 409", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "double-start", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      await fetch(`http://localhost:${port}/loops/${id}/start`, { method: "POST" });
      const secondStart = await fetch(`http://localhost:${port}/loops/${id}/start`, { method: "POST" });
      expect(secondStart.status).toBe(409);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("DELETE /loops/:id removes a child loop", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deletable", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      const deleteResp = await fetch(`http://localhost:${port}/loops/${id}`, { method: "DELETE" });
      expect(deleteResp.status).toBe(200);

      const getResp = await fetch(`http://localhost:${port}/loops`);
      expect(await getResp.json()).toHaveLength(0);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("DELETE /loops/:id returns 404 for unknown id", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops/nonexistent`, { method: "DELETE" });
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/start returns 404 for unknown id", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops/nonexistent/start`, { method: "POST" });
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/stop returns 404 for unknown id", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops/nonexistent/stop`, { method: "POST" });
      expect(resp.status).toBe(404);
    } finally {
      d.stop();
      await startPromise;
    }
  });

  test("POST /loops/:id/stop on already-stopped returns 409", async () => {
    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      const createResp = await fetch(`http://localhost:${port}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "already-stopped", planPath: "./p.yaml" }),
      });
      const { id } = await createResp.json();

      // Start then stop the child
      await fetch(`http://localhost:${port}/loops/${id}/start`, { method: "POST" });
      await fetch(`http://localhost:${port}/loops/${id}/stop`, { method: "POST" });

      // Try to stop again
      const stopAgain = await fetch(`http://localhost:${port}/loops/${id}/stop`, { method: "POST" });
      expect(stopAgain.status).toBe(409);
    } finally {
      d.stop();
      await startPromise;
    }
  });
});

describe("Loops YAML parser", () => {
  // Access via loadFromConfig which internally uses parseLoopsYaml
  test("parses valid loops.yaml", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "loops-yaml-"));
    const yamlPath = join(tmpDir, "loops.yaml");
    writeFileSync(yamlPath, `
loops:
  - name: daily-triage
    planPath: ./plans/triage.plan.yaml
    triggers:
      - type: cron
        schedule: "0 9 * * *"
    enabled: true
  - name: file-watcher
    planPath: ./plans/watch.plan.yaml
    watchDir: ./incoming
    enabled: false
`);

    const orch = makeOrchestrator();
    await orch.loadFromConfig(yamlPath);

    const children = orch.listChildren();
    expect(children).toHaveLength(2);
    expect(children[0].name).toBe("daily-triage");
    expect(children[0].planPath).toBe("./plans/triage.plan.yaml");
    expect(children[0].triggerCount).toBe(1);
    expect(children[0].enabled).toBe(true);

    // Auto-started since enabled: true
    const state0 = orch.getChildState(children[0].id);
    expect(state0!.status).toBe("running");

    expect(children[1].name).toBe("file-watcher");
    expect(children[1].enabled).toBe(false);
    expect(children[1].triggerCount).toBe(1); // watchDir triggers created as fileWatch

    // Not auto-started since enabled: false
    const state1 = orch.getChildState(children[1].id);
    expect(state1!.status).toBe("stopped");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadFromConfig warns on missing file", async () => {
    const logs: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => logs.push(msg);

    const orch = makeOrchestrator();
    await orch.loadFromConfig("./does-not-exist.yaml");

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("loops config not found");

    console.warn = origWarn;
  });

  test("loadFromConfig handles invalid YAML gracefully — no crash, empty list", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "loops-bad-yaml-"));
    const yamlPath = join(tmpDir, "loops.yaml");
    writeFileSync(yamlPath, "not: valid: yaml: structure\n  broken");

    const orch = makeOrchestrator();
    await orch.loadFromConfig(yamlPath);

    expect(orch.listChildren()).toHaveLength(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("LoopOrchestrator — bounded concurrency", () => {
    test("(a) caps concurrent children at maxConcurrentLoops", async () => {
      const tq = new TaskQueue();
      const tm = new TriggerManager();
      const orch = new LoopOrchestrator(tq, tm, { maxConcurrentLoops: 2, getRemainingRuns: async () => 100 });

      const id1 = orch.addChild({ name: "c1", planPath: "./p1.yaml" });
      const id2 = orch.addChild({ name: "c2", planPath: "./p2.yaml" });
      const id3 = orch.addChild({ name: "c3", planPath: "./p3.yaml" });
      const id4 = orch.addChild({ name: "c4", planPath: "./p4.yaml" });

      await orch.startChild(id1);
      await orch.startChild(id2);
      await orch.startChild(id3);
      await orch.startChild(id4);

      expect(orch.getChildState(id1)!.status).toBe("running");
      expect(orch.getChildState(id2)!.status).toBe("running");
      expect(orch.getChildState(id3)!.status).toBe("queued");
      expect(orch.getChildState(id4)!.status).toBe("queued");

      // Stop one running → next queued starts
      await orch.stopChild(id1);
      expect(orch.getChildState(id3)!.status).toBe("running");
      expect(orch.getChildState(id4)!.status).toBe("queued");

      await orch.stopChild(id2);
      expect(orch.getChildState(id4)!.status).toBe("running");
    });

    test("(b) budget clamp reduces effective cap", async () => {
      const tq = new TaskQueue();
      const tm = new TriggerManager();
      // remainingRuns=3, maxConcurrentLoops=10, avgCostPerLoop=2 → effectiveCap = floor(3/2) = 1
      let remaining = 3;
      const orch = new LoopOrchestrator(tq, tm, {
        maxConcurrentLoops: 10,
        avgCostPerLoop: 2,
        getRemainingRuns: async () => remaining,
      });

      const id1 = orch.addChild({ name: "c1", planPath: "./p1.yaml" });
      const id2 = orch.addChild({ name: "c2", planPath: "./p2.yaml" });

      await orch.startChild(id1);
      await orch.startChild(id2);

      // effectiveCap=1 → only first starts, second queues
      expect(orch.getChildState(id1)!.status).toBe("running");
      expect(orch.getChildState(id2)!.status).toBe("queued");
    });

    test("(c) pause+queue when budget exhausted, resumes on recovery", async () => {
      const tq = new TaskQueue();
      const tm = new TriggerManager();
      let remaining = 0;
      const orch = new LoopOrchestrator(tq, tm, {
        maxConcurrentLoops: 5,
        avgCostPerLoop: 1,
        getRemainingRuns: async () => remaining,
      });

      const id1 = orch.addChild({ name: "c1", planPath: "./p1.yaml" });
      const id2 = orch.addChild({ name: "c2", planPath: "./p2.yaml" });

      // Budget exhausted → both queue
      await orch.startChild(id1);
      expect(orch.getChildState(id1)!.status).toBe("queued");

      await orch.startChild(id2);
      expect(orch.getChildState(id2)!.status).toBe("queued");

      // Budget recovers
      remaining = 10;

      // Starting a 3rd triggers drainQueue which processes all queued
      const id3 = orch.addChild({ name: "c3", planPath: "./p3.yaml" });
      await orch.startChild(id3);
      expect(orch.getChildState(id3)!.status).toBe("running");
      // id1 and id2 should have been drained from queue
      expect(orch.getChildState(id1)!.status).toBe("running");
      expect(orch.getChildState(id2)!.status).toBe("running");
    });

    test("(d) priority ordering: higher-priority queued child starts first", async () => {
      const tq = new TaskQueue();
      const tm = new TriggerManager();
      const orch = new LoopOrchestrator(tq, tm, { maxConcurrentLoops: 1 });

      const lowPri = orch.addChild({ name: "Daily Triage", planPath: "./low.yaml" });
      const highPri = orch.addChild({ name: "CI Sweeper", planPath: "./high.yaml" });

      await orch.startChild(lowPri);
      await orch.startChild(highPri);

      expect(orch.getChildState(lowPri)!.status).toBe("running");
      expect(orch.getChildState(highPri)!.status).toBe("queued");

      // Stop low-pri → the high-pri one (queued) should start before any lower-priority
      await orch.stopChild(lowPri);
      expect(orch.getChildState(highPri)!.status).toBe("running");

      // Now stop and test reverse order
      await orch.stopChild(highPri);

      const midPri = orch.addChild({ name: "PR Babysitter", planPath: "./mid.yaml" });
      // highPri takes the only slot; midPri and lowPri queue
      await orch.startChild(highPri);
      await orch.startChild(midPri);
      await orch.startChild(lowPri);

      // Only 1 slot used by highPri, rest queued
      expect(orch.getChildState(highPri)!.status).toBe("running");
      expect(orch.getChildState(midPri)!.status).toBe("queued");
      expect(orch.getChildState(lowPri)!.status).toBe("queued");

      // Stop the running one → drainQueue: midPri (80) starts before lowPri (20)
      await orch.stopChild(highPri);
      expect(orch.getChildState(midPri)!.status).toBe("running");
      expect(orch.getChildState(lowPri)!.status).toBe("queued");
    });
  });

  test("Daemon starts with --loops-config and auto-starts enabled children", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "daemon-loops-"));
    const yamlPath = join(tmpDir, "loops.yaml");
    writeFileSync(yamlPath, `
loops:
  - name: auto-start
    planPath: ./plan.yaml
    enabled: true
  - name: manual-only
    planPath: ./plan2.yaml
    enabled: false
`);

    const d = new Daemon(0, undefined, { loopsConfig: yamlPath });
    const startPromise = d.start();
    await new Promise(r => setTimeout(r, 500));

    try {
      const port = d.getState().port;
      const resp = await fetch(`http://localhost:${port}/loops`);
      const list = await resp.json() as any[];
      expect(list).toHaveLength(2);

      // Auto-started
      expect(list.find((c: any) => c.name === "auto-start")!.status).toBe("running");
      // Not auto-started
      expect(list.find((c: any) => c.name === "manual-only")!.status).toBe("stopped");
    } finally {
      d.stop();
      await startPromise;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
