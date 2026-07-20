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
 * Issue 2 — L1 must log each draft run to loop-run-log.md (ADR-0019 §3/§4).
 *
 * l1-draft-increment.ps1 appends a shared-format line to <repo-root>/loop-run-log.md:
 *   - on draft (speckit chain succeeded + evolve-N guard passed):
 *       {ts, loop:L1, spec_N:<N>, event:drafted, detail:<idea>}
 *   - on idle (no .next-idea.txt / empty idea):
 *       {ts, loop:L1, spec_N:-, event:idle}
 *   - on speckit failure (chain exited non-zero):
 *       {ts, loop:L1, spec_N:-, event:failed, detail:<exit>}
 *
 * The script resolves the log as `../loop-run-log.md` relative to its own
 * directory (plans/), so we copy it into a temp `plans/` tree and point the
 * log at a temp root — hermetic, no pollution of the real run log. The
 * `spec_N` MUST correlate with the evolve-N the chain just wrote (or `-`
 * when idle/failed).
 */

let tmpRoot: string;
let plansDir: string;
let specsDir: string;
let workspaceDir: string;
let logPath: string;

function setup(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "l1-run-log-"));
  // Repo layout MUST mirror the real one: plans/ lives INSIDE the repo root,
  // so the script's `../loop-run-log.md` resolves to <repo>/loop-run-log.md.
  const repoRoot = join(tmpRoot, "repo");
  plansDir = join(repoRoot, "plans");
  specsDir = join(tmpRoot, "specs");
  workspaceDir = join(tmpRoot, "workspace");
  logPath = join(repoRoot, "loop-run-log.md");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "..", "plans", "l1-draft-increment.ps1"),
    join(plansDir, "l1-draft-increment.ps1"),
  );
  return join(plansDir, "l1-draft-increment.ps1");
}

/**
 * Write an opencode stub that records argv to calls.log AND (per L1_TEST_SPECS)
 * writes an evolve-001.md checkpoint into the specs workspace so the script's
 * artifact guard passes and `drafted` is logged with spec_N:001.
 *
 * @param exitCode - the stub's exit code (0 = success, non-zero = speckit failure)
 */
function writeOpencodeStub(dir: string, exitCode = 0): string {
  const stub = join(dir, "opencode-stub.ps1");
  const body = [
    "$log = Join-Path $PSScriptRoot 'calls.log'",
    "$line = ($args | ForEach-Object { $_ }) -join ' '",
    "Add-Content -LiteralPath $log -Value $line",
    "if ($env:L1_TEST_SPECS -and -not (Test-Path -LiteralPath (Join-Path $env:L1_TEST_SPECS 'evolve-001.md'))) {",
    "  Set-Content -LiteralPath (Join-Path $env:L1_TEST_SPECS 'evolve-001.md') -Value 'specs/001-l3-evolve/'",
    "}",
    `exit ${exitCode}`,
  ].join("\n");
  writeFileSync(stub, body, "utf8");
  return stub;
}

function draftScript(): string {
  return join(plansDir, "l1-draft-increment.ps1");
}

function ideaFile(): string {
  return join(specsDir, "ideas", ".next-idea.txt");
}

function runDraft(opts: { idea?: string; opencodeStub: string; exit?: number }): { code: number; out: string } {
  const ideaPath = ideaFile();
  const ideasDir = join(specsDir, "ideas");
  mkdirSync(ideasDir, { recursive: true });
  if (opts.idea !== undefined) writeFileSync(ideaPath, opts.idea, "utf8");
  else if (existsSync(ideaPath)) rmSync(ideaPath, { force: true });

  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      draftScript(),
      "-Specs",
      specsDir,
      "-IdeaFile",
      ideaPath,
      "-Workspace",
      workspaceDir,
      "-Opencode",
      opts.opencodeStub,
    ],
    { encoding: "utf8", env: { ...process.env, L1_TEST_SPECS: specsDir } },
  );
  return { code: res.status ?? -1, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

describe("Issue 2 — L1 logs each draft run to loop-run-log.md", () => {
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("drafted appends a 'drafted' line correlated by N (001)", () => {
    const script = setup();
    const stub = writeOpencodeStub(plansDir, 0);

    const res = runDraft({ idea: "add a dark-mode toggle to settings", opencodeStub: stub });
    expect(res.code).toBe(0);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("loop:L1");
    expect(log).toContain("spec_N:001");
    expect(log).toContain("event:drafted");
    expect(log).toContain("add a dark-mode toggle to settings");
    // No idle/failed line on a successful draft.
    expect(log).not.toContain("event:idle");
    expect(log).not.toContain("event:failed");
  });

  test("idle (no .next-idea.txt) appends an 'idle' line with spec_N:-", () => {
    const script = setup();
    const stub = writeOpencodeStub(plansDir, 0);
    // Do NOT write an idea file -> L1 idles.

    const res = runDraft({ idea: undefined, opencodeStub: stub });
    expect(res.code).toBe(0);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("loop:L1");
    expect(log).toContain("spec_N:-");
    expect(log).toContain("event:idle");
    expect(log).not.toContain("event:drafted");
    expect(log).not.toContain("event:failed");
    // Idle must be append-only: the stub must NOT have run the chain.
    expect(existsSync(join(plansDir, "calls.log"))).toBe(false);
  });

  test("failed appends a 'failed' line with spec_N:- and exit detail", () => {
    const script = setup();
    const stub = writeOpencodeStub(plansDir, 7);

    const res = runDraft({ idea: "broken idea", opencodeStub: stub });
    expect(res.code).not.toBe(0);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("loop:L1");
    expect(log).toContain("spec_N:-");
    expect(log).toContain("event:failed");
    expect(log).toContain("detail:speckit.specify exit 7");
    expect(log).not.toContain("event:drafted");
    expect(log).not.toContain("event:idle");
  });

  test("log line shape matches the shared parser contract {ts, loop, spec_N, event, detail?}", () => {
    const script = setup();
    const stub = writeOpencodeStub(plansDir, 0);

    runDraft({ idea: "correlate me", opencodeStub: stub });
    const log = readFileSync(logPath, "utf8").trim();
    // Must parse as the documented comma-separated key:value form.
    const m = log.match(/^\{ts:[^,]+, loop:L1, spec_N:\d+, event:drafted, detail:.+\}$/);
    expect(m).not.toBeNull();
  });
});
