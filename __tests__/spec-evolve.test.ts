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
import { parseYaml } from "../src/yaml";
import { validatePlanSchema } from "../src/plan-schema";
import { checkPlanAgainstConstitution } from "../src/constitution";

/**
 * Issue 4 — L3 evolve plan `spec-evolve.yaml` (ADR-0019 Section 5).
 *
 * Hermetic contract test (no live `opencode` LLM call). Mirrors the L1/L2/L3
 * test pattern: we copy the real scripts into a temp `plans/` tree + temp loop
 * root so the `-LiteralPath`/`Split-Path $PSScriptRoot` resolution matches the
 * real repo, and stub `l3-should-evolve.ps1` output + the `evolve` LLM recorder.
 *
 * Local context (no module-level shared vars) so bun's parallel test execution
 * cannot race on a shared temp root.
 *
 * Acceptance covered:
 *   - [x] Plan parses via plan-executor's loader (validatePlanSchema + constitution).
 *   - [x] check-trigger idles cleanly (exit 0, no flag) when no pattern (IDLE).
 *   - [x] LLM step writes proposal + patch (recorder stub); never edits targets.
 *   - [x] verify-proposal fails loud if no proposal despite a triggered pattern.
 *   - [x] Scope B respected: verify-proposal rejects a patch touching src/ or spec-factory/.
 */

const PLAN = join(import.meta.dirname, "..", "plans", "spec-evolve.yaml");
const TRIGGER = join(import.meta.dirname, "..", "plans", "l3-should-evolve.ps1");
const CHECK = join(import.meta.dirname, "..", "plans", "l3-check-trigger.ps1");
const EVOLVE = join(import.meta.dirname, "..", "plans", "l3-evolve.ps1");
const VERIFY = join(import.meta.dirname, "..", "plans", "verify-proposal.ps1");

const WAKE_LOG = [
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:001, event:drafted, detail:a}`,
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:002, event:drafted, detail:b}`,
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:003, event:drafted, detail:c}`,
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:004, event:drafted, detail:d}`,
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:005, event:drafted, detail:e}`,
  `{ts:2026-07-20T01:00:00, loop:L2, spec_N:006, event:rejected, detail:x}`,
  `{ts:2026-07-20T01:00:00, loop:L2, spec_N:006, event:rejected, detail:x}`,
  `{ts:2026-07-20T01:00:00, loop:L2, spec_N:006, event:rejected, detail:x}`,
].join("\n") + "\n";

const IDLE_LOG = [
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:001, event:drafted, detail:a}`,
  `{ts:2026-07-20T01:00:00, loop:L1, spec_N:002, event:drafted, detail:b}`,
].join("\n") + "\n";

interface Ctx {
  root: string;
  plansDir: string;
  buildDir: string;
}

function setup(): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), "spec-evolve-"));
  const root = join(tmp, "repo");
  const plansDir = join(root, "plans");
  const buildDir = join(root, ".build", "spec-evolve");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  copyFileSync(TRIGGER, join(plansDir, "l3-should-evolve.ps1"));
  copyFileSync(CHECK, join(plansDir, "l3-check-trigger.ps1"));
  copyFileSync(EVOLVE, join(plansDir, "l3-evolve.ps1"));
  copyFileSync(VERIFY, join(plansDir, "verify-proposal.ps1"));
  return { root, plansDir, buildDir };
}

// Stub opencode in the temp root: a recorder that writes a proposal + patch
// (matching the evolve step's prompt contract). Always exits 0.
function writeOpencodeStub(ctx: Ctx, mode: "good" | "bad" | "empty"): string {
  const stub = join(ctx.root, "opencode.ps1");
  const goodProp = [
    "",
    "- date: 2026-07-20",
    "- trigger_pattern: 3x rejected spec 006",
    "- target_file: plans/l1-draft-increment.ps1",
    "- current -> proposed: tightened specify prompt",
    "- why: verifier keeps rejecting 006 on same root cause",
    "- confidence: 0.7",
    "",
  ].join("\r\n");
  const badProp = [
    "",
    "- date: 2026-07-20",
    "- trigger_pattern: 3x rejected spec 006",
    "- target_file: agent-loop/src/loop-runner.ts",
    "- current -> proposed: change loop logic",
    "- why: verifier keeps rejecting 006",
    "- confidence: 0.7",
    "",
  ].join("\r\n");
  const body = [
    "$argsJoined = $args -join ' '",
    "if ($argsJoined -match 'should-evolve.flag') { exit 0 }",
    "$build = Join-Path (Join-Path $PSScriptRoot '.build') 'spec-evolve'",
    "if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build -Force | Out-Null }",
    "if ('" + mode + "' -eq 'empty') { Set-Content -LiteralPath (Join-Path $build 'spec-evolve-proposals.md') -Value ''; Set-Content -LiteralPath (Join-Path $build 'spec-evolve.patch') -Value ''; exit 0 }",
    "if ('" + mode + "' -eq 'bad') { Set-Content -LiteralPath (Join-Path $build 'spec-evolve-proposals.md') -Value '" + badProp.replace(/\r\n/g, "`n") + "'; Set-Content -LiteralPath (Join-Path $build 'spec-evolve.patch') -Value '--- a/agent-loop/src/loop-runner.ts'; exit 0 }",
    "Set-Content -LiteralPath (Join-Path $build 'spec-evolve-proposals.md') -Value '" + goodProp.replace(/\r\n/g, "`n") + "'",
    "Set-Content -LiteralPath (Join-Path $build 'spec-evolve.patch') -Value '--- a/plans/l1-draft-increment.ps1'",
    "exit 0",
  ].join("\n");
  writeFileSync(stub, body, "utf8");
  return stub;
}

function setFlag(ctx: Ctx) {
  writeFileSync(join(ctx.buildDir, "should-evolve.flag"), "2026-07-20T03:17:00", "utf8");
}

// Run check-trigger exactly like the fixed plan command (script-file form).
function runCheckTrigger(ctx: Ctx, logLines: string): { code: number; out: string; flag: boolean } {
  const logPath = join(ctx.root, "loop-run-log.md");
  writeFileSync(logPath, logLines, "utf8");
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(ctx.plansDir, "l3-check-trigger.ps1"),
    ],
    { encoding: "utf8" },
  );
  return {
    code: res.status ?? -1,
    out: ((res.stdout ?? "") + (res.stderr ?? "")).trim(),
    flag: existsSync(join(ctx.buildDir, "should-evolve.flag")),
  };
}

function runVerify(ctx: Ctx): { code: number; out: string } {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ctx.plansDir, "verify-proposal.ps1"), "-Root", ctx.root],
    { encoding: "utf8" },
  );
  return { code: res.status ?? -1, out: ((res.stdout ?? "") + (res.stderr ?? "")).trim() };
}

describe("Issue 4 — spec-evolve.yaml (L3 evolve plan)", () => {
  let ctx: Ctx;
  afterEach(() => {
    if (ctx && existsSync(ctx.root)) rmSync(ctx.root, { recursive: true, force: true });
  });

  test("plan parses via plan-executor loader (validate + constitution)", () => {
    const doc = parseYaml(readFileSync(PLAN, "utf8")) as any;
    const schemaErrors = validatePlanSchema(doc);
    expect(schemaErrors).toEqual([]);
    const violations = checkPlanAgainstConstitution(doc);
    expect(violations).toEqual([]);
    expect(doc.tasks[0].id).toBe("read-state");
    expect(doc.tasks[doc.tasks.length - 1].id).toBe("verify-proposal");
  });

  test("check-trigger idles cleanly (IDLE, no flag, exit 0) when no pattern", () => {
    ctx = setup();
    const res = runCheckTrigger(ctx, IDLE_LOG);
    expect(res.code).toBe(0);
    expect(res.out).toContain("IDLE");
    expect(res.flag).toBe(false);
  });

  test("check-trigger sets flag on WAKE (pattern + min-runs)", () => {
    ctx = setup();
    const res = runCheckTrigger(ctx, WAKE_LOG);
    expect(res.code).toBe(0);
    expect(res.out).toContain("WAKE");
    expect(res.flag).toBe(true);
  });

  test("verify-proposal idles (exit 0) when trigger idled (no flag)", () => {
    ctx = setup();
    const res = runVerify(ctx);
    expect(res.code).toBe(0);
    expect(res.out).toContain("idled");
  });

  test("verify-proposal FAILS LOUD (non-zero) when flag present but proposal missing", () => {
    ctx = setup();
    setFlag(ctx);
    const res = runVerify(ctx);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("FAIL");
  });

  test("verify-proposal FAILS LOUD (non-zero) when proposal empty despite flag", () => {
    ctx = setup();
    setFlag(ctx);
    const stub = writeOpencodeStub(ctx, "empty");
    spawnSync("powershell.exe", ["-NoProfile", "-File", stub], { encoding: "utf8" });
    const res = runVerify(ctx);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("FAIL");
  });

  test("verify-proposal FAILS LOUD (non-zero) on Scope B violation (patch touches src/)", () => {
    ctx = setup();
    setFlag(ctx);
    const stub = writeOpencodeStub(ctx, "bad");
    spawnSync("powershell.exe", ["-NoProfile", "-File", stub], { encoding: "utf8" });
    const res = runVerify(ctx);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("Scope B");
  });

  test("verify-proposal PASSES (exit 0) for well-formed proposal + patch, scope B respected", () => {
    ctx = setup();
    setFlag(ctx);
    const stub = writeOpencodeStub(ctx, "good");
    spawnSync("powershell.exe", ["-NoProfile", "-File", stub], { encoding: "utf8" });
    const res = runVerify(ctx);
    expect(res.code).toBe(0);
    expect(res.out).toContain("PASS");
  });

  // ── Issue 5 — `git apply --check` assertion (hermetic temp git repo) ──
  // Build a REAL git repo so `git apply --check` is exercised without touching the
  // real agent-loop tree. The "good" patch is a genuine `git diff` against a tracked
  // file; the "bad" patch is context-corrupted so --check must reject it.
  function setupGit(): Ctx {
    const tmp = mkdtempSync(join(tmpdir(), "spec-evolve-git-"));
    const root = join(tmp, "repo");
    const plansDir = join(root, "plans");
    const buildDir = join(root, ".build", "spec-evolve");
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(buildDir, { recursive: true });
    copyFileSync(TRIGGER, join(plansDir, "l3-should-evolve.ps1"));
    copyFileSync(VERIFY, join(plansDir, "verify-proposal.ps1"));

    const target = join(root, "plans", "l1-draft-increment.ps1");
    writeFileSync(target, "line1\r\nline2\r\nline3\r\n", "utf8");

    const git = (args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@local"]);
    git(["config", "user.name", "test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    return { root, plansDir, buildDir };
  }

  function writeGoodProposalAndPatch(ctx: Ctx) {
    const targetRel = "plans/l1-draft-increment.ps1";
    const targetAbs = join(ctx.root, targetRel);
    writeFileSync(targetAbs, "line1\r\nline2-edited\r\nline3\r\n", "utf8");
    const diff = spawnSync("git", ["-C", ctx.root, "diff", "--", targetRel], {
      encoding: "utf8",
    }).stdout;
    // Restore the tree to committed state so the patch applies cleanly under
    // `git apply --check` (the patch turns HEAD -> edited; tree must be clean).
    spawnSync("git", ["-C", ctx.root, "checkout", "--", targetRel], {
      encoding: "utf8",
    });
    writeFileSync(
      join(ctx.buildDir, "spec-evolve-proposals.md"),
      [
        "- date: 2026-07-20",
        "- trigger_pattern: 3x rejected spec 006",
        "- target_file: plans/l1-draft-increment.ps1",
        "- current -> proposed: tightened specify prompt",
        "- why: verifier keeps rejecting 006 on same root cause",
        "- confidence: 0.7",
        "",
      ].join("\r\n"),
      "utf8",
    );
    writeFileSync(join(ctx.buildDir, "spec-evolve.patch"), diff, "utf8");
  }

  function writeCorruptedPatch(ctx: Ctx) {
    writeFileSync(
      join(ctx.buildDir, "spec-evolve-proposals.md"),
      [
        "- date: 2026-07-20",
        "- trigger_pattern: 3x rejected spec 006",
        "- target_file: plans/l1-draft-increment.ps1",
        "- current -> proposed: tightened specify prompt",
        "- why: verifier keeps rejecting 006",
        "- confidence: 0.7",
        "",
      ].join("\r\n"),
      "utf8",
    );
    // Corrupted: modifies the real tracked file but with context that does NOT
    // match its current content -> git apply --check must reject it.
    writeFileSync(
      join(ctx.buildDir, "spec-evolve.patch"),
      [
        "diff --git a/plans/l1-draft-increment.ps1 b/plans/l1-draft-increment.ps1",
        "--- a/plans/l1-draft-increment.ps1",
        "+++ b/plans/l1-draft-increment.ps1",
        "@@ -1,3 +1,3 @@",
        " this-line-does-not-exist-in-the-tree",
        "-line2",
        "+line2-edited",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  test("verify-proposal PASSES (exit 0) when patch applies cleanly via git apply --check", () => {
    ctx = setupGit();
    setFlag(ctx);
    writeGoodProposalAndPatch(ctx);
    const res = runVerify(ctx);
    expect(res.code).toBe(0);
    expect(res.out).toContain("PASS");
    expect(res.out).toContain("applies cleanly");
  });

  test("verify-proposal FAILS LOUD (non-zero) when patch does not apply (git apply --check rejects)", () => {
    ctx = setupGit();
    setFlag(ctx);
    writeCorruptedPatch(ctx);
    const res = runVerify(ctx);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("FAIL");
    expect(res.out).toContain("does not apply");
  });
});
