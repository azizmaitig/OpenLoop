import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendRunLog,
  readRunLog,
  countRunsLast24h,
} from "../src/run-log.js";
import type { RunLogEntry } from "../src/run-log.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-loop-runlog-"));
}

function entry(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    run_id: "r1",
    pattern: "test",
    runs_count: 1,
    outcome: "pass",
    timestamp: new Date().toISOString(),
    duration_ms: 100,
    ...overrides,
  };
}

describe("appendRunLog", () => {
  test("creates file with header when file does not exist", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const e = entry({ run_id: "new-file-test" });
    await appendRunLog(p, e);

    const file = Bun.file(p);
    expect(await file.exists()).toBe(true);
    const content = await file.text();
    expect(content).toContain("# Loop Run Log");
    expect(content).toContain("<!-- Loop appends below this line -->");
    expect(content).toContain(JSON.stringify(e));

    await rm(dir, { recursive: true, force: true });
  });

  test("appends entries in order and after the marker", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const e1 = entry({ run_id: "first" });
    const e2 = entry({ run_id: "second" });

    await appendRunLog(p, e1);
    await appendRunLog(p, e2);

    // Verify via readRunLog (skips template example JSON)
    const entries = await readRunLog(p);
    expect(entries).toHaveLength(2);
    expect(entries[0].run_id).toBe("first");
    expect(entries[1].run_id).toBe("second");

    // Verify entries appear after the marker
    const content = await Bun.file(p).text();
    const markerIdx = content.indexOf("<!-- Loop appends below this line -->");
    expect(markerIdx).not.toBe(-1);
    const afterMarker = content.slice(markerIdx);
    expect(afterMarker.indexOf("first")).toBeGreaterThan(0);
    expect(afterMarker.indexOf("second")).toBeGreaterThan(
      afterMarker.indexOf("first"),
    );

    await rm(dir, { recursive: true, force: true });
  });

  test("appends 3 entries and reads them back", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    await appendRunLog(p, entry({ run_id: "a" }));
    await appendRunLog(p, entry({ run_id: "b" }));
    await appendRunLog(p, entry({ run_id: "c" }));

    const entries = await readRunLog(p);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.run_id)).toEqual(["a", "b", "c"]);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("readRunLog", () => {
  test("returns [] for non-existent file", async () => {
    const entries = await readRunLog("/tmp/nonexistent-run-log.md");
    expect(entries).toEqual([]);
  });

  test("returns all entries when no hoursBack filter", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    await appendRunLog(p, entry({ run_id: "a", timestamp: "2026-07-01T00:00:00.000Z" }));
    await appendRunLog(p, entry({ run_id: "b", timestamp: "2026-07-02T00:00:00.000Z" }));
    await appendRunLog(p, entry({ run_id: "c", timestamp: "2026-07-03T00:00:00.000Z" }));

    const result = await readRunLog(p);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.run_id)).toEqual(["a", "b", "c"]);

    await rm(dir, { recursive: true, force: true });
  });

  test("filters entries within hoursBack window", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const now = Date.now();
    const oldTs = new Date(now - 48 * 3_600_000).toISOString(); // 48h ago
    const recentTs = new Date(now - 2 * 3_600_000).toISOString();  // 2h ago

    await appendRunLog(p, entry({ run_id: "old", timestamp: oldTs }));
    await appendRunLog(p, entry({ run_id: "recent", timestamp: recentTs }));

    // 24h window — should only include the recent one
    const result = await readRunLog(p, 24);
    expect(result).toHaveLength(1);
    expect(result[0].run_id).toBe("recent");

    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] when all entries are outside the window", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const oldTs = new Date(Date.now() - 72 * 3_600_000).toISOString();
    await appendRunLog(p, entry({ run_id: "old", timestamp: oldTs }));

    const result = await readRunLog(p, 24);
    expect(result).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  test("skips non-JSON and malformed lines", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    // Write a file with mixed content (header + valid + garbage)
    const header = `# Loop Run Log — Test

<!-- Loop appends below this line -->
${JSON.stringify(entry({ run_id: "valid-1" }))}
this is not json
${JSON.stringify(entry({ run_id: "valid-2" }))}
  {not valid either
`;
    await Bun.write(p, header);

    const result = await readRunLog(p);
    expect(result).toHaveLength(2);
    expect(result[0].run_id).toBe("valid-1");
    expect(result[1].run_id).toBe("valid-2");

    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] for empty file", async () => {
    const dir = await tempDir();
    const p = join(dir, "empty.md");
    await Bun.write(p, "");
    const result = await readRunLog(p);
    expect(result).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("countRunsLast24h", () => {
  test("returns 0 for non-existent file", async () => {
    const count = await countRunsLast24h("/tmp/nonexistent-run-log.md");
    expect(count).toBe(0);
  });

  test("sums runs_count from entries within last 24h", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const now = Date.now();
    const recentTs = new Date(now - 1_000).toISOString();
    const oldTs = new Date(now - 48 * 3_600_000).toISOString();

    await appendRunLog(p, entry({ run_id: "r1", runs_count: 3, timestamp: recentTs }));
    await appendRunLog(p, entry({ run_id: "r2", runs_count: 5, timestamp: recentTs }));
    await appendRunLog(p, entry({ run_id: "r3", runs_count: 2, timestamp: oldTs }));

    const count = await countRunsLast24h(p);
    expect(count).toBe(8); // 3 + 5, not including the old entry with 2

    await rm(dir, { recursive: true, force: true });
  });

  test("returns 0 when no entries in last 24h", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const oldTs = new Date(Date.now() - 72 * 3_600_000).toISOString();
    await appendRunLog(p, entry({ run_id: "old", runs_count: 10, timestamp: oldTs }));

    const count = await countRunsLast24h(p);
    expect(count).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("handles entries with runs_count = 0", async () => {
    const dir = await tempDir();
    const p = join(dir, "loop-run-log.md");

    const now = new Date().toISOString();
    await appendRunLog(p, entry({ run_id: "zero", runs_count: 0, timestamp: now }));
    await appendRunLog(p, entry({ run_id: "five", runs_count: 5, timestamp: now }));

    const count = await countRunsLast24h(p);
    expect(count).toBe(5);

    await rm(dir, { recursive: true, force: true });
  });
});
