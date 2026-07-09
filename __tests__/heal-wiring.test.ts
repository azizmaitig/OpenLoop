import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { executePhaseGroup } from "../src/execute-phases.js";
import type { ExecutionDeps, PhaseGroupResult } from "../src/execute-phases.js";
import type { LoopConfig, LoopState, PhaseDef, PhaseResult } from "../src/types.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Heal wiring regression (ADR-0011) ─────────────────────────────────────────
//
// Exercises the executePhaseGroup heal seam end-to-end through the real shell
// runner. Heal commands use node one-liners (cross-platform, no cmd.exe quoting
// hazards) and a counter/marker file to assert how many heal attempts fired.

const dir = mkdtempSync(join(tmpdir(), "heal-wiring-"));
const COUNTER = join(dir, "counter.txt");
const MARKER = join(dir, "marker.txt");

function bumpCounter(): void {
  const n = existsSync(COUNTER) ? parseInt(readFileSync(COUNTER, "utf8"), 10) || 0 : 0;
  writeFileSync(COUNTER, String(n + 1));
}
function readCounter(): number {
  return existsSync(COUNTER) ? readFileSync(COUNTER, "utf8").split("\n").filter(Boolean).length : 0;
}

function makePhase(overrides?: Partial<PhaseDef>): PhaseDef {
  return {
    name: "code",
    command: "cmd.exe /c exit 1",
    expectedExitCode: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeConfig(phases: PhaseDef[]): LoopConfig {
  return { taskName: "test", maxIterations: 1, phaseTimeoutMs: 30000, phases };
}

function makeState(): LoopState {
  return { currentState: "init", iteration: 1, phaseResults: {}, startTime: new Date().toISOString(), errors: [] };
}

function makeDeps(overrides?: Partial<ExecutionDeps>): ExecutionDeps {
  return { config: makeConfig([makePhase()]), plugins: [], writeState: async () => {}, onPhaseFailed: () => {}, ...overrides };
}

describe("heal wiring (ADR-0011) — executePhaseGroup", () => {
  beforeEach(() => { if (existsSync(COUNTER)) rmSync(COUNTER); if (existsSync(MARKER)) rmSync(MARKER); });
  afterEach(() => { if (existsSync(COUNTER)) rmSync(COUNTER); if (existsSync(MARKER)) rmSync(MARKER); });

  test("heal-success: healCommand that makes the phase pass ends pass and skips failTerminal", async () => {
    const failed: string[] = [];
    // Heal writes the marker file; the phase command passes only once the marker
    // exists, so the healAndRetry re-run of the phase command succeeds.
    const phaseCmd = `node -e "process.exit(require('fs').existsSync('${MARKER}')?0:1)"`;
    const healCmd = `node -e "require('fs').writeFileSync('${MARKER}','1')"`;

    const deps = makeDeps({
      config: makeConfig([makePhase({ name: "code", command: phaseCmd, healCommand: healCmd, maxRetries: 1 })]),
      onPhaseFailed: (p: PhaseDef) => failed.push(p.name),
    });
    const state = makeState();

    const result: PhaseGroupResult = await executePhaseGroup(deps, state, 1);

    expect(result.state.phaseResults["code"]!.status).toBe("pass");
    expect(failed).toEqual([]); // heal bypassed failTerminal
  });

  test("heal-exhaust: healCommand never makes the phase pass ends fail after maxRetries attempts", async () => {
    const failed: string[] = [];
    // heal appends one line to COUNTER then exits 1 (never heals); phase always fails.
    const healCmd = `echo heal >> ${COUNTER} & exit /b 1`;

    const deps = makeDeps({
      config: makeConfig([makePhase({ name: "code", command: "cmd.exe /c exit 1", healCommand: healCmd, maxRetries: 3 })]),
      onPhaseFailed: (p: PhaseDef) => failed.push(p.name),
    });
    const state = makeState();

    const result: PhaseGroupResult = await executePhaseGroup(deps, state, 1);

    expect(result.state.phaseResults["code"]!.status).toBe("fail");
    expect(failed).toEqual(["code"]);
    expect(readCounter()).toBe(3); // heal ran exactly maxRetries times
  });

  test("no-heal: a failing phase WITHOUT healCommand fails immediately, no heal attempts", async () => {
    const failed: string[] = [];
    const deps = makeDeps({
      config: makeConfig([makePhase({ name: "code", command: "cmd.exe /c exit 1" })]),
      onPhaseFailed: (p: PhaseDef) => failed.push(p.name),
    });
    const state = makeState();

    const result: PhaseGroupResult = await executePhaseGroup(deps, state, 1);

    expect(result.state.phaseResults["code"]!.status).toBe("fail");
    expect(failed).toEqual(["code"]);
    expect(existsSync(COUNTER)).toBe(false); // heal seam never triggered
  });
});
