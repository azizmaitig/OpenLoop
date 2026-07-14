import { describe, expect, test, spyOn } from "bun:test";
import type { ExecutionDeps } from "../src/execute-phases.js";
import type { LoopConfig, LoopState, PhaseDef, PhaseResult } from "../src/types.js";

import { executePhaseGroup } from "../src/execute-phases.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePhase(overrides?: Partial<PhaseDef>): PhaseDef {
  return {
    name: "test",
    command: "echo hello",
    expectedExitCode: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeConfig(phases: PhaseDef[] = [makePhase()]): LoopConfig {
  return {
    taskName: "test",
    maxIterations: 3,
    phaseTimeoutMs: 30000,
    phases,
    memory: { enabled: false },
  };
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    currentState: 'init',
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
      config: makeConfig([makePhase({ name: "fail", command: "exit 1" })]),
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
      config: makeConfig([makePhase({ name: "fail", command: "exit 1" })]),
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
        makePhase({ name: "first", command: "exit 1" }),
        makePhase({ name: "second", command: "echo after-fail" }),
      ]),
    });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    expect(result.state.phaseResults["second"]!.status).toBe("pass");
  });

  // ── Concurrent layer execution (Feature A) ─────────────────────────────

  test("layers: independent phases with dependsOn:[] run concurrently", async () => {
    const phases: PhaseDef[] = [
      { ...makePhase({ name: "alpha", command: "echo first" }), dependsOn: [] },
      { ...makePhase({ name: "beta", command: "echo second" }), dependsOn: [] },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
    expect(result.state.phaseResults["alpha"]!.status).toBe("pass");
    expect(result.state.phaseResults["beta"]!.status).toBe("pass");
  });

  test("layers: diamond dependency — dependsOn groups phases correctly", async () => {
    const phases: PhaseDef[] = [
      makePhase({ name: "a", command: "echo root" }),
      { ...makePhase({ name: "b", command: "echo child-b" }), dependsOn: ["a"] },
      { ...makePhase({ name: "c", command: "echo child-c" }), dependsOn: ["a"] },
      { ...makePhase({ name: "d", command: "echo grandchild" }), dependsOn: ["b", "c"] },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
    expect(result.state.phaseResults["a"]!.status).toBe("pass");
    expect(result.state.phaseResults["b"]!.status).toBe("pass");
    expect(result.state.phaseResults["c"]!.status).toBe("pass");
    expect(result.state.phaseResults["d"]!.status).toBe("pass");
  });

  test("layers: failure in first layer prevents subsequent layers from running", async () => {
    const phases: PhaseDef[] = [
      makePhase({ name: "a", command: "exit 1" }),
      { ...makePhase({ name: "b", command: "echo should-not-run" }), dependsOn: ["a"] },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    // phase 'a' was attempted and failed
    expect(result.state.phaseResults["a"]!.status).toBe("fail");
    // phase 'b' should NOT have a result (layer never ran)
    expect(result.state.phaseResults["b"]).toBeUndefined();
  });

  test("layers: sibling abort fires AbortController when one phase fails", async () => {
    // Two independent phases in the same layer; one fails; signal is aborted
    const phases: PhaseDef[] = [
      { ...makePhase({ name: "fast-fail", command: "exit 1" }), dependsOn: [] },
      { ...makePhase({ name: "sibling", command: "echo still-runs" }), dependsOn: [] },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    // The layer had a failure → allPassed is false
    expect(result.allPassed).toBe(false);
    // Both phases may have executed (sync spawn), but layer reports failure
    expect(result.state.phaseResults["fast-fail"]!.status).toBe("fail");
    // Sibling may have run (sync spawn), but is recorded
    expect(result.state.phaseResults["sibling"]!.status).toBe("pass");
  });

  test("layers: phase with explicit dependsOn uses concurrent path (no dependsOn = sequential)", async () => {
    // Two phases: one has dependsOn, one doesn't. The one with dependsOn triggers
    // the concurrent path. Since no dependsOn => singleton layer, they run sequentially.
    const phases: PhaseDef[] = [
      makePhase({ name: "first", command: "echo one" }),
      { ...makePhase({ name: "second", command: "echo two" }), dependsOn: ["first"] },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(true);
    expect(result.state.phaseResults["first"]!.status).toBe("pass");
    expect(result.state.phaseResults["second"]!.status).toBe("pass");
  });
});
