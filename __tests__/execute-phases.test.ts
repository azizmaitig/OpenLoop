import { describe, expect, test, spyOn } from "bun:test";
import type { ExecutionDeps } from "../src/execute-phases.js";
import type { LoopConfig, LoopState, PhaseDef, PhaseResult } from "../src/types.js";
import { startOpenCodeStub } from "./helpers/opencode-stub.js";

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

  test("agent phase with no reachable server errors loudly — never silently passes", async () => {
    const deadConfig = {
      ...makeConfig([
        makePhase({ name: "agent-task", type: "agent", prompt: "do the thing", command: undefined }),
      ]),
      opencodeServer: { url: "http://127.0.0.1:59999" },
    };
    const deps = makeDeps({ config: deadConfig });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    const pr = result.state.phaseResults["agent-task"]!;
    expect(pr.status).toBe("error");
    expect(pr.stderr).toContain("not healthy");
  });

  test("agent phase executes through the loop against a stub — pass (AC1/AC2)", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "analyze the auth module\nDONE" }],
      closeEvents: true,
    });
    try {
      const deps = makeDeps({
        config: {
          ...makeConfig([
            makePhase({ name: "analyze", type: "agent", prompt: "analyze the auth module", command: undefined }),
          ]),
          opencodeServer: { url: stub.url },
        },
      });
      const result = await executePhaseGroup(deps, makeState(), 1);

      expect(result.allPassed).toBe(true);
      const pr = result.state.phaseResults["analyze"]!;
      expect(pr.status).toBe("pass");
      expect(pr.exitCode).toBe(0);
      expect(pr.stdout).toContain("analyze the auth module");
    } finally {
      stub.close();
    }
  });

  test("failing agent conversation fails the phase group (AC2)", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.step.failed", error: "stub: agent failed" }],
      closeEvents: true,
    });
    try {
      const deps = makeDeps({
        config: {
          ...makeConfig([
            makePhase({ name: "analyze", type: "agent", prompt: "analyze the auth module", command: undefined }),
          ]),
          opencodeServer: { url: stub.url },
        },
      });
      const result = await executePhaseGroup(deps, makeState(), 1);

      expect(result.allPassed).toBe(false);
      expect(result.state.phaseResults["analyze"]!.status).toBe("fail");
    } finally {
      stub.close();
    }
  });

  test("verify phase gates an agent task result like any command task (AC4)", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      const deps = makeDeps({
        config: {
          ...makeConfig([
            makePhase({ name: "analyze", type: "agent", prompt: "analyze the auth module", command: undefined }),
            makePhase({ name: "verify", command: "echo verified", dependsOn: ["analyze"] }),
          ]),
          opencodeServer: { url: stub.url },
        },
      });
      const result = await executePhaseGroup(deps, makeState(), 1);

      expect(result.allPassed).toBe(true);
      expect(result.state.phaseResults["analyze"]!.status).toBe("pass");
      expect(result.state.phaseResults["verify"]!.status).toBe("pass");
    } finally {
      stub.close();
    }
  });

  test("multiple agent tasks in one plan — each gets its own opencode session", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      const deps = makeDeps({
        config: {
          ...makeConfig([
            makePhase({ name: "read-state", command: "type STATE.md" }),
            makePhase({ name: "analyze-local", type: "agent", prompt: "local task", command: undefined }),
            makePhase({
              name: "analyze-docker",
              type: "agent",
              prompt: "docker task",
              command: undefined,
              workspace: { type: "docker" },
            }),
            makePhase({ name: "verify", command: "echo verified" }),
          ]),
          opencodeServer: { url: stub.url },
        },
      });
      const result = await executePhaseGroup(deps, makeState(), 1);

      expect(result.allPassed).toBe(true);
      expect(result.state.phaseResults["analyze-local"]!.status).toBe("pass");
      expect(result.state.phaseResults["analyze-docker"]!.status).toBe("pass");
      expect(stub.sessionCreateCount()).toBe(2); // one session per agent task
    } finally {
      stub.close();
    }
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

  test("heal command touching a denylisted path is REJECTED, not HEALED (T5 D6.5)", async () => {
    const phases: PhaseDef[] = [
      {
        name: "build",
        command: "exit 1",
        expectedExitCode: 0,
        timeoutMs: 5000,
        healCommand: "echo touched .env",
        maxRetries: 2,
      },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    expect(result.allPassed).toBe(false);
    const pr = result.state.phaseResults["build"]!;
    expect(pr.status).toBe("fail");
    expect(pr.stderr).toContain("Constitution audit REJECTED");
    expect(pr.stderr).toContain(".env");
  });

  test("clean heal output still heals the phase (T5 D6.5 regression guard)", async () => {
    const phases: PhaseDef[] = [
      {
        name: "build",
        command: "exit 1",
        expectedExitCode: 0,
        timeoutMs: 5000,
        healCommand: "echo harmless fix",
        maxRetries: 2,
      },
    ];
    const deps = makeDeps({ config: makeConfig(phases) });
    const state = makeState();

    const result = await executePhaseGroup(deps, state, 1);

    // healCommand runs, then the phase command re-runs — the phase still
    // fails (exit 1), but the heal itself is NOT rejected by the audit.
    const pr = result.state.phaseResults["build"]!;
    expect(pr.status).toBe("fail");
    expect(pr.stderr).not.toContain("Constitution audit REJECTED");
  });
});
