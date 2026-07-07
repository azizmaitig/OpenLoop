import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countRunsLast24h, checkBudget } from "../src/budget.js";
import { readRunLog } from "../src/run-log.js";

let tmpDir: string;
const OLD_ENV = { ...process.env };

function logPath(): string {
  return join(tmpDir, "loop-run-log.md");
}

function writeLog(lines: string[]): void {
  const header = [
    "# Loop Run Log — TEST",
    "",
    "Append one entry per run. Prune entries older than 30 days.",
    "",
    "## Format",
    "",
    '```json',
    '{',
    '  "run_id": "2026-06-09T08:15:00Z",',
    '  "pattern": "daily-triage",',
    '  "duration_s": 45,',
    '  "items_found": 4,',
    '  "actions_taken": 1,',
    '  "escalations": 0,',
    '  "tokens_estimate": 52000,',
    '  "outcome": "report-only | fix-proposed | escalated | no-op"',
    '}',
    '```',
    "",
    "## Recent Runs",
    "",
    "<!-- Loop appends below this line -->",
    "",
    ...lines,
  ];
  writeFileSync(logPath(), header.join("\n"), "utf-8");
}

function makeEntry(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    run_id: "test-run-001",
    pattern: "test",
    runs_count: 1,
    outcome: "pass",
    timestamp: new Date().toISOString(),
    duration_ms: 500,
  };
  return JSON.stringify({ ...base, ...overrides });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "budget-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...OLD_ENV };
});

beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.LOOP_DAILY_RUN_CAP;
});

describe("readRunLog", () => {
  test("returns empty array when file does not exist", () => {
    const result = readRunLog("/nonexistent/path");
    expect(result).toEqual([]);
  });

  test("returns empty array when file has no entries after marker", () => {
    writeLog([]);
    const result = readRunLog(logPath());
    expect(result).toEqual([]);
  });

  test("parses single valid JSON entry", () => {
    writeLog([makeEntry({ run_id: "run-1" })]);
    const result = readRunLog(logPath());
    expect(result.length).toBe(1);
    expect(result[0].run_id).toBe("run-1");
    expect(result[0].pattern).toBe("test");
    expect(result[0].runs_count).toBe(1);
    expect(result[0].outcome).toBe("pass");
  });

  test("parses multiple entries", () => {
    writeLog([
      makeEntry({ run_id: "run-1", pattern: "daily-triage" }),
      makeEntry({ run_id: "run-2", pattern: "nightly-cleanup" }),
      makeEntry({ run_id: "run-3", pattern: "monitor" }),
    ]);
    const result = readRunLog(logPath());
    expect(result.length).toBe(3);
    expect(result[0].run_id).toBe("run-1");
    expect(result[1].pattern).toBe("nightly-cleanup");
    expect(result[2].run_id).toBe("run-3");
  });

  test("skips non-JSON lines gracefully", () => {
    writeLog([
      "<!-- this is a comment -->",
      "",
      makeEntry({ run_id: "run-1" }),
      "# some leftover markdown",
      makeEntry({ run_id: "run-2" }),
    ]);
    const result = readRunLog(logPath());
    expect(result.length).toBe(2);
    expect(result[0].run_id).toBe("run-1");
    expect(result[1].run_id).toBe("run-2");
  });

  test("filters by hoursBack using timestamp field", () => {
    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000);
    const twentyHoursAgo = new Date(now.getTime() - 20 * 3600_000);
    const twentySixHoursAgo = new Date(now.getTime() - 26 * 3600_000);

    writeLog([
      makeEntry({ run_id: "recent", timestamp: now.toISOString() }),
      makeEntry({ run_id: "mid", timestamp: threeHoursAgo.toISOString() }),
      makeEntry({ run_id: "oldish", timestamp: twentyHoursAgo.toISOString() }),
      makeEntry({ run_id: "ancient", timestamp: twentySixHoursAgo.toISOString() }),
    ]);

    // 24h window should exclude 'ancient'
    const result = readRunLog(logPath(), 24);
    expect(result.length).toBe(3);
    expect(result.map(r => r.run_id)).not.toContain("ancient");

    // 6h window should only include 'recent' and 'mid'
    const recent = readRunLog(logPath(), 6);
    expect(recent.length).toBe(2);
    expect(recent.map(r => r.run_id)).toEqual(["recent", "mid"]);
  });

  test("includes entries without timestamp when hoursBack is set", () => {
    writeLog([
      makeEntry({ run_id: "no-ts", timestamp: undefined }),
      makeEntry({ run_id: "recent", timestamp: new Date().toISOString() }),
    ]);
    const result = readRunLog(logPath(), 24);
    expect(result.length).toBe(2);
  });
});

describe("countRunsLast24h", () => {
  test("returns 0 when no entries exist", async () => {
    writeLog([]);
    const count = await countRunsLast24h(tmpDir);
    expect(count).toBe(0);
  });

  test("sums runs_count from entries in last 24h", async () => {
    writeLog([
      makeEntry({ run_id: "run-1", runs_count: 1 }),
      makeEntry({ run_id: "run-2", runs_count: 3 }),
      makeEntry({ run_id: "run-3", runs_count: 5 }),
    ]);
    const count = await countRunsLast24h(tmpDir);
    expect(count).toBe(9);
  });

  test("counts each entry as 1 when runs_count is missing", async () => {
    writeLog([
      JSON.stringify({ run_id: "run-1", pattern: "test", outcome: "pass", timestamp: new Date().toISOString() }),
      JSON.stringify({ run_id: "run-2", pattern: "test", outcome: "pass", timestamp: new Date().toISOString() }),
    ]);
    const count = await countRunsLast24h(tmpDir);
    expect(count).toBe(2);
  });

  test("ignores entries older than 24h", async () => {
    const ancient = new Date(Date.now() - 30 * 3600_000).toISOString();
    writeLog([
      makeEntry({ run_id: "recent", runs_count: 2 }),
      makeEntry({ run_id: "old", runs_count: 10, timestamp: ancient }),
    ]);
    const count = await countRunsLast24h(tmpDir);
    expect(count).toBe(2);
  });
});

describe("checkBudget", () => {
  test("returns ok when runs are below 80%", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "100";
    const entries: string[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(makeEntry({ run_id: `run-${i}`, runs_count: 1 }));
    }
    writeLog(entries);
    const result = await checkBudget(tmpDir);
    expect(result.status).toBe("ok");
    expect(result.runsToday).toBe(50);
    expect(result.cap).toBe(100);
  });

  test("returns report_only when runs are 80-99% of cap", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "100";
    const entries: string[] = [];
    for (let i = 0; i < 80; i++) {
      entries.push(makeEntry({ run_id: `run-${i}`, runs_count: 1 }));
    }
    writeLog(entries);
    const result = await checkBudget(tmpDir);
    expect(result.status).toBe("report_only");
    expect(result.runsToday).toBe(80);
    expect(result.cap).toBe(100);
  });

  test("returns exceeded when runs reach 100% of cap", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "100";
    const entries: string[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push(makeEntry({ run_id: `run-${i}`, runs_count: 1 }));
    }
    writeLog(entries);
    const result = await checkBudget(tmpDir);
    expect(result.status).toBe("exceeded");
    expect(result.runsToday).toBe(100);
    expect(result.cap).toBe(100);
  });

  test("returns exceeded when runs exceed cap", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "50";
    const entries: string[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(makeEntry({ run_id: `run-${i}`, runs_count: 1 }));
    }
    writeLog(entries);
    const result = await checkBudget(tmpDir);
    expect(result.status).toBe("exceeded");
    expect(result.runsToday).toBe(60);
    expect(result.cap).toBe(50);
  });

  test("defaults to cap 100 when env var is not set", async () => {
    delete process.env.LOOP_DAILY_RUN_CAP;
    writeLog([]);
    const result = await checkBudget(tmpDir);
    expect(result.cap).toBe(100);
  });

  test("uses LOOP_DAILY_RUN_CAP env var for configurable cap", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "25";
    writeLog([
      makeEntry({ run_id: "run-1", runs_count: 18 }),
    ]);
    const result = await checkBudget(tmpDir);
    expect(result.status).toBe("ok");
    expect(result.runsToday).toBe(18);
    expect(result.cap).toBe(25);
  });

  test("rejects invalid LOOP_DAILY_RUN_CAP values, falls back to default", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "not-a-number";
    writeLog([]);
    const result = await checkBudget(tmpDir);
    expect(result.cap).toBe(100);
  });

  test("rejects negative LOOP_DAILY_RUN_CAP, falls back to default", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "-50";
    writeLog([]);
    const result = await checkBudget(tmpDir);
    expect(result.cap).toBe(100);
  });

  test("rejects zero LOOP_DAILY_RUN_CAP, falls back to default", async () => {
    process.env.LOOP_DAILY_RUN_CAP = "0";
    writeLog([]);
    const result = await checkBudget(tmpDir);
    expect(result.cap).toBe(100);
  });
});
