import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * TDD seam tests for the L1 spec-creation wiring (ADR-0018).
 *
 * Assert the CONTRACT of the two helper scripts without running a real LLM:
 * a stub `opencode` recorder captures the argv each `opencode run` call hands it.
 * Verified: (1) draft idles with no idea file, (2) draft runs the speckit chain
 * as THREE separate `opencode run` calls with the right command + no --dir,
 * (3) missing CLI fails fast, (4) read-inbox peels the top idea line and leaves
 * the rest, (5) read-inbox idles on empty/missing inbox.
 *
 * The real `opencode run` execution is verified live in the /implement session;
 * here we only lock the shell-out shape so a refactor can't silently break it.
 */

const PLANS = join(import.meta.dir, "..", "plans");
const DRAFT = join(PLANS, "l1-draft-increment.ps1");
const READ = join(PLANS, "l1-read-inbox.ps1");

let tmpRoot: string;

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Recorder stub for opencode: APPENDS each invocation's argv (one line per call)
 * to calls.log and exits 0, so three `opencode run` calls yield three logged lines.
 */
function writeOpencodeStub(dir: string): string {
  const stub = join(dir, "opencode-stub.ps1");
  const body = [
    "$log = Join-Path $PSScriptRoot 'calls.log'",
    "$line = ($args | ForEach-Object { $_ }) -join ' '",
    "Add-Content -LiteralPath $log -Value $line",
    "# Simulate the speckit chain producing its evolve-N checkpoint artifact.",
    "if ($env:L1_TEST_SPECS -and -not (Test-Path -LiteralPath (Join-Path $env:L1_TEST_SPECS 'evolve-001.md'))) {",
    "  Set-Content -LiteralPath (Join-Path $env:L1_TEST_SPECS 'evolve-001.md') -Value 'spec'",
    "}",
    "exit 0",
  ].join("\n");
  writeFileSync(stub, body, "utf8");
  return stub;
}

function dirname(p: string): string {
  return join(p, "..");
}

function runDraft(opts: {
  idea?: string;
  opencodeStub: string;
  workspace: string;
  specs: string;
}): { status: number; calls?: string[] } {
  const specs = opts.specs;
  const ideasDir = join(specs, "ideas");
  mkdirSync(ideasDir, { recursive: true });
  const ideaFile = join(ideasDir, ".next-idea.txt");
  if (opts.idea !== undefined) writeFileSync(ideaFile, opts.idea, "utf8");
  else if (existsSync(ideaFile)) rmSync(ideaFile, { force: true });

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-File", DRAFT, "-Specs", specs, "-IdeaFile", ideaFile, "-Workspace", opts.workspace, "-Opencode", opts.opencodeStub],
    { encoding: "utf8", env: { ...process.env, L1_TEST_SPECS: specs } },
  );
  const callsLog = join(dirname(opts.opencodeStub), "calls.log");
  const calls = existsSync(callsLog)
    ? readFileSync(callsLog, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return { status: res.status ?? -1, calls };
}

function runRead(opts: { inboxLines?: string[]; specs: string }): { status: number; nextIdea?: string; remaining: string[] } {
  const specs = opts.specs;
  const ideasDir = join(specs, "ideas");
  mkdirSync(ideasDir, { recursive: true });
  const inbox = join(ideasDir, "inbox.md");
  const out = join(ideasDir, ".next-idea.txt");
  if (opts.inboxLines) writeFileSync(inbox, opts.inboxLines.join("\n"), "utf8");
  else if (existsSync(inbox)) rmSync(inbox, { force: true });

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-File", READ, "-Specs", specs, "-Out", out],
    { encoding: "utf8" },
  );
  const nextIdea = existsSync(out) ? readFileSync(out, "utf8").trim() : undefined;
  const remaining = existsSync(inbox) ? readFileSync(inbox, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0) : [];
  return { status: res.status ?? -1, nextIdea, remaining };
}

describe("L1 draft-increment contract (ADR-0018)", () => {
  test("idle when no .next-idea.txt: exits 0, opencode NOT invoked, no evolve-N", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-idle-"));
    const specs = join(tmpRoot, "specs");
    mkdirSync(specs, { recursive: true });
    const stub = writeOpencodeStub(tmpRoot);

    const { status, calls } = runDraft({ idea: undefined, opencodeStub: stub, workspace: tmpRoot, specs });

    expect(status).toBe(0);
    expect(calls).toBeUndefined();
    const evolve = readdirSync(specs).filter((f: string) => f.startsWith("evolve-"));
    expect(evolve.length).toBe(0);
  });

  test("with an idea: three separate opencode run calls (specify/plan/tasks), no --dir", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-draft-"));
    const specs = join(tmpRoot, "specs");
    mkdirSync(specs, { recursive: true });
    const stub = writeOpencodeStub(tmpRoot);
    const idea = "add a dark-mode toggle to the settings page";

    const { status, calls } = runDraft({ idea, opencodeStub: stub, workspace: tmpRoot, specs });

    expect(status).toBe(0);
    expect(calls).toBeDefined();
    // Exactly three invocations: run /speckit.specify <idea>, run /speckit.plan, run /speckit.tasks.
    expect(calls!.length).toBe(3);
    expect(calls![0]).toBe(`run /speckit.specify ${idea}`);
    expect(calls![1]).toBe("run /speckit.plan");
    expect(calls![2]).toBe("run /speckit.tasks");
    // --dir must NOT be passed (PLAN-WRITING-GUIDE P2: chokes on space paths).
    expect(calls!.some((c) => c.includes("--dir"))).toBe(false);
  });

  test("missing opencode CLI: fails fast with exit 1 (no silent no-op)", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-nocli-"));
    const specs = join(tmpRoot, "specs");
    mkdirSync(specs, { recursive: true });
    const ideaFile = join(specs, "ideas", ".next-idea.txt");
    mkdirSync(join(specs, "ideas"), { recursive: true });
    writeFileSync(ideaFile, "some idea", "utf8");

    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-File", DRAFT, "-Specs", specs, "-IdeaFile", ideaFile, "-Workspace", tmpRoot, "-Opencode", join(tmpRoot, "does-not-exist.exe")],
      { encoding: "utf8" },
    );
    expect(res.status ?? -1).toBe(1);
  });
});

describe("L1 read-inbox contract (ADR-0018)", () => {
  test("peels TOP idea line into .next-idea.txt, preserves the rest", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-inbox-"));
    const specs = join(tmpRoot, "specs");

    const { status, nextIdea, remaining } = runRead({
      specs,
      inboxLines: ["first idea", "second idea", "third idea"],
    });

    expect(status).toBe(0);
    expect(nextIdea).toBe("first idea");
    expect(remaining).toEqual(["second idea", "third idea"]);
  });

  test("idle on missing inbox: exits 0, no .next-idea.txt written", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-inbox-empty-"));
    const specs = join(tmpRoot, "specs");
    const out = join(specs, "ideas", ".next-idea.txt");

    const { status } = runRead({ specs });

    expect(status).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  test("idle on empty inbox: exits 0, no .next-idea.txt written", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "l1-inbox-blank-"));
    const specs = join(tmpRoot, "specs");
    const out = join(specs, "ideas", ".next-idea.txt");

    const { status } = runRead({ specs, inboxLines: ["", "  ", ""] });

    expect(status).toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});
