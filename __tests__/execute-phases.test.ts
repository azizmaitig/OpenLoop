import { describe, expect, test } from "bun:test";
import { executePhaseGroup } from "../src/execute-phases.js";
import type { ExecutionDeps } from "../src/execute-phases.js";
import type { LoopConfig, LoopState, PhaseDef, PhaseResult } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePhase(overrides?: Partial<PhaseDef>): PhaseDef {
  return {
    name: "test",
    command: "echo hello",
    timeoutMs: 5000,
    evalPrompt: "",
    evalModel: "",
    ...overrides,
  };
}

function makeConfig(phases: PhaseDef[] = [makePhase()]): LoopConfig {
  return {
    planPath: "",
    maxIterations: 3,
    mode: "single-run",
    phases,
  };
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    currentState: 'idle',
    iteration: 1,
    phaseResults: {},
    startTime: new Date().toISOString(),
    errors: [],
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ExecutionDeps>): ExecutionDeps {
  return {
    config: makeConfig(),
    plugins: [],
    writeState: async () => {},
    onPhaseFailed: () => {},
    ...overrides,
  };
}

// ── executePhaseGroup ─────────────────────────────────────────────────────────

describe("executePhaseGroup", () => {
  test("passes a simple echo command", async () => {
    const deps = makeDeps();
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
    expect(result.state.phaseResults["test"]).toBeDefined();
    expect(result.state.phaseResults["test"]!.status).toBe("pass");
  });

  test("reports failure for a failing command", async () => {
    const deps = makeDeps({
      config: makeConfig([makePhase({ name: "fail", command: "cmd.exe /c exit 1" })]),
    });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    expect(result.state.phaseResults["fail"]!.status).toBe("fail");
  });

  test("handles empty phases list", async () => {
    const deps = makeDeps({ config: makeConfig([]) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
  });

  test("executes all phases in order", async () => {
    const phases: PhaseDef[] = [
      makePhase({ name: "alpha", command: "echo first" }),
      makePhase({ name: "beta", command: "echo second" }),
      makePhase({ name: "gamma", command: "echo third" }),
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
    expect(result.state.phaseResults["alpha"]!.status).toBe("pass");
    expect(result.state.phaseResults["beta"]!.status).toBe("pass");
    expect(result.state.phaseResults["gamma"]!.status).toBe("pass");
  });

  test("calls onPhaseFailed when a phase fails", async () => {
    const failed: string[] = [];
    const deps = makeDeps({
      config: makeConfig([makePhase({ name: "fail", command: "cmd.exe /c exit 1" })]),
      onPhaseFailed: (phase: PhaseDef, _result: PhaseResult) => { failed.push(phase.name); },
    });
    const state = makeState();

    await executePhaseGroup(deps, state, 1);

    expect(failed).toEqual(["fail"]);
  });

  test("calls writeState after each phase", async () => {
    const writes: number[] = [];
    const deps = makeDeps({
      config: makeConfig([
        makePhase({ name: "a", command: "echo one" }),
        makePhase({ name: "b", command: "echo two" }),
      ]),
      writeState: async () => { writes.push(writes.length + 1); },
    });
    const state = makeState();

    await executePhaseGroup(deps, state, 1);

    expect(writes.length).toBe(2);
  });

  test("runs all phases even after a failure (no short-circuit)", async () => {
    const deps = makeDeps({
      config: makeConfig([
        makePhase({ name: "first", command: "cmd.exe /c exit 1" }),
        makePhase({ name: "second", command: "echo after-fail" }),
      ]),
    });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    expect(result.state.phaseResults["second"]!.status).toBe("pass");
  });
});
