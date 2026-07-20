import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Issue 3 — L3 combo-trigger `l3-should-evolve.ps1` (ADR-0019 §3/§4).
 *
 * Pure-PowerShell pre-check that wakes the LLM propose step (Issue 4) ONLY
 * when BOTH hold:
 *   (a) PATTERN: >= K consecutive rejected (same spec_N) OR idle OR stalled
 *       specs (rejected/failed with no built since),
 *   (b) MIN-RUNS: >= N L1 runs since the last evolved-proposal marker.
 *
 * Otherwise it idles (prints "IDLE", no log line, exit 0) -- mirrors
 * L1's idle contract, never a false failure.
 *
 * Hermetic: we copy the script into a temp `plans/` tree and write the
 * log at the repo root so `../loop-run-log.md` resolves. We feed CRAFTED
 * log lines and assert the trigger decision (stdout WAKE/IDLE).
 */

let tmpRoot: string;
let plansDir: string;
let logPath: string;

const K = 3; // default rejection/idle/stalled threshold
const N = 5; // default min L1 runs

function setup(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "l3-should-evolve-"));
  const repoRoot = join(tmpRoot, "repo");
  plansDir = join(repoRoot, "plans");
  logPath = join(repoRoot, "loop-run-log.md");
  mkdirSync(plansDir, { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "..", "plans", "l3-should-evolve.ps1"),
    join(plansDir, "l3-should-evolve.ps1"),
  );
  return join(plansDir, "l3-should-evolve.ps1");
}

function writeLog(lines: string[]) {
  writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
}

function run(script: string, k = K, n = N): { code: number; out: string; proposalCount: number } {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-File", script, "-Log", logPath, "-K", String(k), "-N", String(n)],
    { encoding: "utf8" },
  );
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  const proposalCount = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split(/\r?\n/).filter((l) => l.includes("event:evolved-proposal")).length
    : 0;
  return { code: res.status ?? -1, out: out.trim(), proposalCount };
}

const l1 = (n: string, ev: string, detail = "") =>
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:${n}, event:${ev}${detail ? ", detail:" + detail : ""}}`;
const l2 = (n: string, ev: string, detail = "") =>
  `{ts:2026-07-20T01:00:00, loop:L2, spec_N:${n}, event:${ev}${detail ? ", detail:" + detail : ""}}`;
const proposal = () => `{ts:2026-07-20T01:00:00, loop:L3, spec_N:-, event:evolved-proposal}`;

describe("Issue 3 — L3 combo-trigger wakes only when pattern AND min-runs", () => {
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("both hold: 3 consecutive rejected same spec_N + >=5 L1 runs -> WAKE + 1 marker", () => {
    const script = setup();
    const lines = [
      l1("001", "drafted", "idea a"),
      l1("002", "drafted", "idea b"),
      l1("003", "drafted", "idea c"),
      l1("004", "drafted", "idea d"),
      l1("005", "drafted", "idea e"), // 5 L1 runs
      l2("006", "rejected", "verify failed on 006"),
      l2("006", "rejected", "verify failed on 006"),
      l2("006", "rejected", "verify failed on 006"), // 3x same spec_N rejected
    ];
    writeLog(lines);
    const res = run(script);
    expect(res.code).toBe(0);
    expect(res.out).toBe("WAKE");
    expect(res.proposalCount).toBe(1);
  });

  test("pattern absent: only 2 consecutive rejected -> IDLE (no false wake)", () => {
    const script = setup();
    const lines = [
      l1("001", "drafted", "a"),
      l1("002", "drafted", "b"),
      l1("003", "drafted", "c"),
      l1("004", "drafted", "d"),
      l1("005", "drafted", "e"), // 5 L1 runs, but no pattern
      l2("006", "rejected", "once"),
      l2("006", "rejected", "twice"), // only 2 consecutive
    ];
    writeLog(lines);
    const res = run(script);
    expect(res.code).toBe(0);
    expect(res.out).toBe("IDLE");
    expect(res.proposalCount).toBe(0);
  });

  test("min-runs not met: pattern present but <5 L1 runs -> IDLE", () => {
    const script = setup();
    const lines = [
      l1("001", "drafted", "a"),
      l1("002", "drafted", "b"),
      l2("003", "rejected", "x"),
      l2("003", "rejected", "x"),
      l2("003", "rejected", "x"), // 3x rejected, but only 2 L1 runs
    ];
    writeLog(lines);
    const res = run(script);
    expect(res.code).toBe(0);
    expect(res.out).toBe("IDLE");
    expect(res.proposalCount).toBe(0);
  });

  test("idle-streak pattern: 3 consecutive L1 idle + enough L1 runs -> WAKE", () => {
    const script = setup();
    const lines = [
      l1("001", "drafted", "a"),
      l1("002", "idle"),
      l1("003", "idle"),
      l1("004", "idle"), // 3 consecutive idle (stalled / pacing)
      l1("005", "drafted", "b"), // 5th L1 run
    ];
    writeLog(lines);
    const res = run(script);
    expect(res.code).toBe(0);
    expect(res.out).toBe("WAKE");
    expect(res.proposalCount).toBe(1);
  });

  test("stalled-spec fallback: rejected specs with no built, 3x consecutive -> WAKE", () => {
    const script = setup();
    const lines = [
      l1("001", "drafted", "a"),
      l1("002", "drafted", "b"),
      l1("003", "drafted", "c"),
      l1("004", "drafted", "d"),
      l1("005", "drafted", "e"), // 5 L1 runs
      l2("101", "rejected", "no built for 101"),
      l2("102", "rejected", "no built for 102"),
      l2("103", "rejected", "no built for 103"), // 3 stalled specs, no built intervening
    ];
    writeLog(lines);
    const res = run(script);
    expect(res.code).toBe(0);
    expect(res.out).toBe("WAKE");
    expect(res.proposalCount).toBe(1);
  });

  test("min-runs resets after an evolved-proposal marker", () => {
    const script = setup();
    // A proposal happened; only 2 L1 runs SINCE -> min-runs not met.
    const lines = [
      l1("001", "drafted", "a"),
      l1("002", "drafted", "b"),
      l1("003", "drafted", "c"),
      l2("004", "rejected", "x"),
      l2("004", "rejected", "x"),
      l2("004", "rejected", "x"), // pattern present (before marker)
      proposal(), // reset point
      l1("005", "drafted", "after"),
      l1("006", "drafted", "after2"), // only 2 L1 runs since marker
      l2("007", "rejected", "y"),
      l2("007", "rejected", "y"),
      l2("007", "rejected", "y"), // another 3x rejected AFTER marker
    ];
    writeLog(lines);
    const res = run(script);
    // min-runs counts from the marker: only 2 L1 runs (005, 006) -> IDLE,
    // and the script must NOT append a new marker (input already had 1).
    expect(res.out).toBe("IDLE");
    expect(res.proposalCount).toBe(1);
  });

  test("empty / missing log -> IDLE (safe default, no crash)", () => {
    const script = setup();
    // No log file written at all.
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-File", script, "-Log", logPath, "-K", String(K), "-N", String(N)],
      { encoding: "utf8" },
    );
    expect(res.status ?? -1).toBe(0);
    expect(((res.stdout ?? "") + (res.stderr ?? "")).trim()).toBe("IDLE");
  });
});
