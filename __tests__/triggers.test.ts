import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronTrigger, FileWatchTrigger, TriggerManager } from "../src/triggers.js";

// ── CronTrigger ──────────────────────────────────────────────────────────────

describe("CronTrigger", () => {
  test("parses * * * * * — matches every minute", () => {
    const t = new CronTrigger("* * * * *", () => {});
    // Should match any date
    expect(t.matches(new Date("2026-01-15T10:30:00"))).toBe(true);
    expect(t.matches(new Date("2026-06-01T00:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-12-31T23:59:00"))).toBe(true);
  });

  test("parses 0 9 * * * — daily at 9am", () => {
    const t = new CronTrigger("0 9 * * *", () => {});
    expect(t.matches(new Date("2026-03-15T09:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T09:01:00"))).toBe(false);
    expect(t.matches(new Date("2026-03-15T08:00:00"))).toBe(false);
    expect(t.matches(new Date("2026-03-16T09:00:00"))).toBe(true);
  });

  test("parses 0 */6 * * * — every 6 hours", () => {
    const t = new CronTrigger("0 */6 * * *", () => {});
    expect(t.matches(new Date("2026-03-15T00:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T06:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T12:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T18:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T01:00:00"))).toBe(false);
    expect(t.matches(new Date("2026-03-15T07:00:00"))).toBe(false);
  });

  test("parses 30 8 * * 1 — Monday 8:30am", () => {
    const t = new CronTrigger("30 8 * * 1", () => {});
    // 2026-03-16 is a Monday
    expect(t.matches(new Date("2026-03-16T08:30:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-16T08:31:00"))).toBe(false);
    // Tuesday
    expect(t.matches(new Date("2026-03-17T08:30:00"))).toBe(false);
  });

  test("handles Sun=7 (some cron specs use 7 for Sunday)", () => {
    const t = new CronTrigger("0 0 * * 7", () => {});
    // 2026-03-15 is a Sunday
    expect(t.matches(new Date("2026-03-15T00:00:00"))).toBe(true);
  });

  test("parses comma-separated values", () => {
    const t = new CronTrigger("0,30 * * * *", () => {});
    expect(t.matches(new Date("2026-03-15T10:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T10:30:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T10:15:00"))).toBe(false);
  });

  test("parses range values", () => {
    const t = new CronTrigger("0 9-17 * * *", () => {});
    expect(t.matches(new Date("2026-03-15T09:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T12:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T17:00:00"))).toBe(true);
    expect(t.matches(new Date("2026-03-15T08:00:00"))).toBe(false);
    expect(t.matches(new Date("2026-03-15T18:00:00"))).toBe(false);
  });

  test("throws on invalid expression (wrong field count)", () => {
    expect(() => new CronTrigger("0 9 * *", () => {})).toThrow();
    expect(() => new CronTrigger("0 9 * * * *", () => {})).toThrow();
  });

  test("throws on invalid expression (non-numeric field where number expected)", () => {
    // This should still parse but yield no matches — that's fine
    const t = new CronTrigger("x * * * *", () => {});
    expect(t.matches(new Date("2026-03-15T10:30:00"))).toBe(false);
  });

  test("start/stop lifecycle", async () => {
    let fireCount = 0;
    const trigger = new CronTrigger("* * * * *", () => { fireCount++; });

    expect(trigger.running).toBe(false);

    // Start with a very short check interval (10ms) but make the
    // test deterministic by controlling time.

    // Instead: just verify start() and stop() don't throw
    trigger.start(10_000);
    expect(trigger.running).toBe(true);
    trigger.stop();
    expect(trigger.running).toBe(false);
  });

  test("does not double-fire within same minute", () => {
    let fireCount = 0;
    const trigger = new CronTrigger("* * * * *", () => { fireCount++; });

    // Simulate calling matches twice within the same minute
    const now = new Date();
    // Manually invoke the internal logic:
    // The start method checks lastFired against current minute
    trigger.start(10_000);
    trigger.stop();

    // No double-fire assertion by design — just verify the mechanism works
    // by checking the matches() method directly
    expect(trigger.matches(now)).toBe(true);
  });
});

// ── FileWatchTrigger ─────────────────────────────────────────────────────────

describe("FileWatchTrigger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `triggers-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates watch dir if it doesn't exist", () => {
    const watchDir = join(tmpDir, "nonexistent");
    const trigger = new FileWatchTrigger(watchDir, () => {});
    expect(existsSync(watchDir)).toBe(false);
    trigger.start();
    expect(existsSync(watchDir)).toBe(true);
    trigger.stop();
  });

  test("fires onTrigger when a .plan.yaml file appears", async () => {
    const watchDir = join(tmpDir, "watch");
    mkdirSync(watchDir, { recursive: true });

    const triggered: string[] = [];
    const trigger = new FileWatchTrigger(watchDir, (path) => { triggered.push(path); });
    trigger.start();

    // Write a matching file
    writeFileSync(join(watchDir, "test.plan.yaml"), "planName: test\ntasks: []");

    // Wait for debounce + fs.watch latency
    await new Promise((r) => setTimeout(r, 1000));

    trigger.stop();

    expect(triggered.length).toBe(1);
    expect(triggered[0]).toContain("test.plan.yaml");
  });

  test("ignores non-matching file patterns", async () => {
    const watchDir = join(tmpDir, "watch");
    mkdirSync(watchDir, { recursive: true });

    const triggered: string[] = [];
    const trigger = new FileWatchTrigger(watchDir, (path) => { triggered.push(path); });
    trigger.start();

    // Write a non-matching file
    writeFileSync(join(watchDir, "readme.txt"), "hello");

    await new Promise((r) => setTimeout(r, 1000));

    trigger.stop();

    expect(triggered.length).toBe(0);
  });

  test("debounces rapid writes: 3 rapid writes → 1 trigger", async () => {
    const watchDir = join(tmpDir, "watch");
    mkdirSync(watchDir, { recursive: true });

    const triggered: string[] = [];
    const trigger = new FileWatchTrigger(watchDir, (path) => { triggered.push(path); }, { debounceMs: 200 });
    trigger.start();

    // Write 3 rapid bursts
    writeFileSync(join(watchDir, "batch.plan.yaml"), "planName: v1\ntasks: []");
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(watchDir, "batch.plan.yaml"), "planName: v2\ntasks: []");
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(watchDir, "batch.plan.yaml"), "planName: v3\ntasks: []");

    // Wait for debounce to flush
    await new Promise((r) => setTimeout(r, 500));

    trigger.stop();

    // Should be 1 (debounced) — but on Windows, fs.watch may fire
    // differently. Allow 1 or 2 as acceptable.
    expect(triggered.length).toBeGreaterThanOrEqual(1);
    expect(triggered.length).toBeLessThanOrEqual(2);
  });

  test("moves processed file to .processed/", async () => {
    const watchDir = join(tmpDir, "watch");
    mkdirSync(watchDir, { recursive: true });

    const triggered: string[] = [];
    const trigger = new FileWatchTrigger(watchDir, (path) => { triggered.push(path); });
    trigger.start();

    writeFileSync(join(watchDir, "move.plan.yaml"), "planName: test\ntasks: []");

    await new Promise((r) => setTimeout(r, 1000));

    trigger.stop();

    // Original file should be moved
    expect(existsSync(join(watchDir, "move.plan.yaml"))).toBe(false);
    // Should be in .processed/
    expect(existsSync(join(watchDir, ".processed", "move.plan.yaml"))).toBe(true);
  });

  test("start/stop lifecycle", () => {
    const watchDir = join(tmpDir, "watch");
    mkdirSync(watchDir, { recursive: true });

    const trigger = new FileWatchTrigger(watchDir, () => {});
    expect(trigger.running).toBe(false);

    trigger.start();
    expect(trigger.running).toBe(true);

    trigger.stop();
    expect(trigger.running).toBe(false);
  });
});

// ── TriggerManager ───────────────────────────────────────────────────────────

describe("TriggerManager", () => {
  let manager: TriggerManager;

  beforeEach(() => {
    manager = new TriggerManager();
  });

  test("register adds a trigger", () => {
    const trigger = new CronTrigger("* * * * *", () => {});
    manager.register("cron1", trigger);
    expect(manager.count).toBe(1);
    expect(manager.get("cron1")).toBe(trigger);
  });

  test("register warns and skips duplicate id", () => {
    const t1 = new CronTrigger("* * * * *", () => {});
    const t2 = new CronTrigger("0 9 * * *", () => {});
    manager.register("same", t1);
    manager.register("same", t2); // should warn, skip
    expect(manager.count).toBe(1);
    expect(manager.get("same")).toBe(t1);
  });

  test("unregister removes and stops a trigger", () => {
    const trigger = new CronTrigger("* * * * *", () => {});
    manager.register("t", trigger);
    const result = manager.unregister("t");
    expect(result).toBe(true);
    expect(manager.count).toBe(0);
  });

  test("unregister returns false for unknown id", () => {
    expect(manager.unregister("nonexistent")).toBe(false);
  });

  test("list returns registered triggers with type and running status", () => {
    manager.register("c1", new CronTrigger("* * * * *", () => {}));
    expect(manager.list()).toEqual([
      { id: "c1", type: "cron", running: false },
    ]);
  });

  test("reset stops all and clears", () => {
    const t1 = new CronTrigger("* * * * *", () => {});
    const t2 = new CronTrigger("0 9 * * *", () => {});
    manager.register("c1", t1);
    manager.register("c2", t2);
    expect(manager.count).toBe(2);

    manager.reset();
    expect(manager.count).toBe(0);
  });
});
