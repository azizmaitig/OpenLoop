import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronTrigger, FileWatchTrigger, TriggerManager } from "../src/triggers.js";
import { Daemon } from "../src/daemon.js";

// ── CronTrigger fire count ──────────────────────────────────────────────────

describe("CronTrigger fire count", () => {
  test("fireCount starts at 0 and lastFiredAt undefined", () => {
    const trigger = new CronTrigger("* * * * *", () => {});
    expect(trigger.fireCount).toBe(0);
    expect(trigger.lastFiredAt).toBeUndefined();
  });

  test("fireCount and lastFiredAt are writable public fields", () => {
    const trigger = new CronTrigger("* * * * *", () => {});
    trigger.fireCount = 3;
    trigger.lastFiredAt = "2026-07-10T12:00:00Z";
    expect(trigger.fireCount).toBe(3);
    expect(trigger.lastFiredAt).toBe("2026-07-10T12:00:00Z");
  });
});

// ── FileWatchTrigger fire count ──────────────────────────────────────────────

describe("FileWatchTrigger fire count", () => {
  test("fireCount increments when a matching file appears", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fwt-fire-"));
    mkdirSync(join(tempDir, ".processed"), { recursive: true });

    try {
      let triggered = false;
      const trigger = new FileWatchTrigger(tempDir, () => { triggered = true; }, {
        pattern: "*.plan.yaml",
        debounceMs: 50,
      });

      trigger.start();
      await new Promise((r) => setTimeout(r, 100));

      // Drop a matching file
      writeFileSync(join(tempDir, "test.plan.yaml"), "task: demo", "utf-8");
      await new Promise((r) => setTimeout(r, 500));

      expect(trigger.fireCount).toBe(1);
      expect(trigger.lastFiredAt).toBeDefined();
      expect(triggered).toBe(true);

      trigger.stop();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── TriggerManager.list() fire tracking ────────────────────────────────────

describe("TriggerManager.list() fire tracking", () => {
  test("returns fireCount and lastFiredAt in list()", () => {
    const manager = new TriggerManager();
    const trigger = new CronTrigger("* * * * *", () => {});

    trigger.fireCount = 5;
    trigger.lastFiredAt = "2026-07-10T12:00:00Z";

    manager.register("test-cron", trigger);
    const list = manager.list();

    expect(list).toHaveLength(1);
    expect(list[0].fireCount).toBe(5);
    expect(list[0].lastFiredAt).toBe("2026-07-10T12:00:00Z");
  });

  test("fireCount is 0 and lastFiredAt undefined for never-fired trigger", () => {
    const manager = new TriggerManager();
    const trigger = new CronTrigger("* * * * *", () => {});
    manager.register("fresh", trigger);
    const list = manager.list();
    expect(list[0].fireCount).toBe(0);
    expect(list[0].lastFiredAt).toBeUndefined();
  });
});

// ── API integration ────────────────────────────────────────────────────────

describe("GET /api/metrics trigger field", () => {
  test("includes triggers array when a cron trigger is registered", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "metrics-trigger-"));

    try {
      writeFileSync(join(tempDir, "loop-run-log.md"), "# Log\n\n<!-- Loop appends below this line -->\n", "utf-8");

      const d = new Daemon(0, tempDir, { cron: "0 9 * * *" });
      const startPromise = d.start();
      await new Promise((r) => setTimeout(r, 300));

      try {
        const resp = await fetch(`http://localhost:${d.getState().port}/api/metrics`);
        expect(resp.status).toBe(200);
        const body = await resp.json();

        expect(body).toHaveProperty("triggers");
        expect(Array.isArray(body.triggers)).toBe(true);
        expect(body.triggers.length).toBeGreaterThanOrEqual(1);

        const t = body.triggers[0];
        expect(t).toHaveProperty("id", "cron-cli");
        expect(t).toHaveProperty("type", "cron");
        expect(t).toHaveProperty("fireCount");
        expect(t).toHaveProperty("running");
        expect(typeof t.fireCount).toBe("number");
        expect(typeof t.running).toBe("boolean");
      } finally {
        d.stop();
        await startPromise;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("triggers is empty array when no triggers registered", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "metrics-notrig-"));

    try {
      writeFileSync(join(tempDir, "loop-run-log.md"), "# Log\n\n<!-- Loop appends below this line -->\n", "utf-8");

      const d = new Daemon(0, tempDir);
      const startPromise = d.start();
      await new Promise((r) => setTimeout(r, 300));

      try {
        const resp = await fetch(`http://localhost:${d.getState().port}/api/metrics`);
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.triggers).toEqual([]);
      } finally {
        d.stop();
        await startPromise;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
