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
 * Issue 1 — L2 must log its build outcome to loop-run-log.md (ADR-0019 §3/§4).
 *
 * l2-executor.ps1 appends a shared-format line to <repo-root>/loop-run-log.md:
 *   - on success (stamp-built):  {ts, loop:L2, spec_N:<N>, event:built}
 *   - on verifier reject (verify, marker missing):
 *                             {ts, loop:L2, spec_N:<N>, event:rejected, detail:...}
 *
 * The script resolves the log as `../loop-run-log.md` relative to its own
 * directory (plans/), so we copy it into a temp `plans/` tree and point the log
 * at a temp root — hermetic, no pollution of the real run log.
 */

let tmpRoot: string;
let plansDir: string;
let specsDir: string;
let protoDir: string;
let logPath: string;

function setup(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "l2-run-log-"));
  // Repo layout MUST mirror the real one: plans/ lives INSIDE the repo root,
  // so the script's `../loop-run-log.md` resolves to <repo>/loop-run-log.md.
  const repoRoot = join(tmpRoot, "repo");
  plansDir = join(repoRoot, "plans");
  specsDir = join(tmpRoot, "specs");
  protoDir = join(tmpRoot, "proto");
  logPath = join(repoRoot, "loop-run-log.md");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(protoDir, { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "..", "plans", "l2-executor.ps1"),
    join(plansDir, "l2-executor.ps1"),
  );
  return join(plansDir, "l2-executor.ps1");
}

function writeEvolve(n: string) {
  const ev = join(specsDir, `evolve-${n}.md`);
  writeFileSync(ev, `specs/${n}-watchdir-trigger/\n`);
}

function writeLease(n: string) {
  writeFileSync(join(specsDir, "current-increment.txt"), `${n}|${protoDir}\\wt-${n}|role=L2-executor|ttl=3600`);
}

function runStage(script: string, stage: string, n: string): { code: number; out: string } {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      script,
      "-Stage",
      stage,
      "-Specs",
      specsDir,
      "-ProtoRoot",
      protoDir,
      "-N",
      n,
    ],
    { encoding: "utf8" },
  );
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("Issue 1 — L2 logs build outcome to loop-run-log.md", () => {
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("stamp-built appends a 'built' line correlated by N", () => {
    const script = setup();
    writeEvolve("003");
    writeLease("003");
    mkdirSync(join(protoDir, "wt-003"), { recursive: true });

    const res = runStage(script, "stamp-built", "003");
    expect(res.code).toBe(0);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("loop:L2");
    expect(log).toContain("spec_N:003");
    expect(log).toContain("event:built");
    // No rejection line on success.
    expect(log).not.toContain("event:rejected");
  });

  test("verify rejects (missing IMPLEMENTED.md) appends a 'rejected' line and fails", () => {
    const script = setup();
    writeEvolve("004");
    writeLease("004");
    // worktree exists but WITHOUT IMPLEMENTED.md -> verifier gate rejects
    mkdirSync(join(protoDir, "wt-004"), { recursive: true });

    const res = runStage(script, "verify", "004");
    expect(res.code).not.toBe(0);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("loop:L2");
    expect(log).toContain("spec_N:004");
    expect(log).toContain("event:rejected");
  });

  test("log line shape matches the shared parser contract {ts, loop, spec_N, event, detail?}", () => {
    const script = setup();
    writeEvolve("005");
    writeLease("005");
    mkdirSync(join(protoDir, "wt-005"), { recursive: true });
    runStage(script, "stamp-built", "005");
    const log = readFileSync(logPath, "utf8").trim();
    // Must parse as the documented comma-separated key:value form.
    const m = log.match(/^\{ts:[^,]+, loop:L2, spec_N:\d+, event:built\}$/);
    expect(m).not.toBeNull();
  });
});
