import { describe, expect, test, mock } from "bun:test";

// Mock executePhaseGroup so the test exercises ONLY the shared loop body
// (the RUN → VERIFY → event transition sequence) without spawning real shell
// commands. The mock simulates successful phase execution by attaching a
// phaseResult, mirroring what executePhaseGroup does after running phases.
mock.module("../src/execute-phases.js", () => ({
  executePhaseGroup: async (_deps: unknown, state: any, _iteration: number) => ({
    allPassed: true,
    state: { ...state, phaseResults: { demo: { status: "pass" } } },
  }),
}));

const { runLoopBody } = await import("../src/loop-core.js");
const { StateMachine } = await import("../src/state-machine.js");
const { createInitialState } = await import("../src/state.js");

import type { LoopState } from "../src/types.js";

function makeState(): LoopState {
  return {
    currentState: "init",
    iteration: 0,
    phaseResults: {},
    startTime: new Date(0).toISOString(),
    errors: [],
  };
}

function baseConfig(overrides: Partial<LoopState> = {}): any {
  return {
    taskName: "t",
    phases: [],
    maxIterations: Infinity,
    phaseTimeoutMs: 1000,
    ...overrides,
  };
}

describe("runLoopBody (shared loop core)", () => {
  test("one iteration drives RUN → VERIFY → LOOP and clears phaseResults", async () => {
    const sm = new StateMachine();
    const writes: LoopState[] = [];
    const onPhaseFailed = mock();

    const result = await runLoopBody({
      sm,
      state: makeState(),
      config: baseConfig(),
      plugins: [],
      iteration: 1,
      writeState: async (s) => { writes.push(s); },
      onPhaseFailed,
      decideEvent: () => "LOOP",
    });

    // 3 state writes: after RUN, after VERIFY, after the decided event.
    expect(writes).toHaveLength(3);
    expect(writes.map((s) => s.currentState)).toEqual(["run", "verify", "init"]);
    expect(result.event).toBe("LOOP");
    expect(result.state.currentState).toBe("init");
    expect(result.state.phaseResults).toEqual({}); // LOOP clears execution output
    expect(result.state.iteration).toBe(1);
    expect(result.allPassed).toBe(true);
    expect(onPhaseFailed).not.toHaveBeenCalled();
  });

  test("COMPLETE path preserves phaseResults and lands in done", async () => {
    const sm = new StateMachine();
    const writes: LoopState[] = [];

    const result = await runLoopBody({
      sm,
      state: makeState(),
      config: baseConfig({ maxIterations: 3 }),
      plugins: [],
      iteration: 3,
      writeState: async (s) => { writes.push(s); },
      decideEvent: () => "COMPLETE",
    });

    expect(writes.map((s) => s.currentState)).toEqual(["run", "verify", "done"]);
    expect(result.event).toBe("COMPLETE");
    expect(result.state.currentState).toBe("done");
    // Non-LOOP event keeps the execution output (mirrors applyTransition contract)
    expect(result.state.phaseResults).toEqual({ demo: { status: "pass" } });
  });

  test.each([
    {
      name: "daemon (always LOOP)",
      decideEvent: () => "LOOP" as const,
      expect: { event: "LOOP", final: "init" },
    },
    {
      name: "runLoop (COMPLETE on final iteration)",
      decideEvent: (_passed: boolean, _s: LoopState) => "COMPLETE" as const,
      expect: { event: "COMPLETE", final: "done" },
    },
  ])(
    "table-driven: $name routes through the shared core with the correct transition",
    async ({ decideEvent, expect: expected }) => {
      // The two callers (daemon / runLoop) drive the SAME runLoopBody; only their
      // decideEvent policy differs. The core must serve both correctly, and the
      // per-iteration shape (RUN → VERIFY → event) is identical for every caller.
      const sm = new StateMachine();
      const writes: string[] = [];

      const res = await runLoopBody({
        sm,
        state: makeState(),
        config: baseConfig({ maxIterations: 1 }),
        plugins: [],
        iteration: 1,
        writeState: async (s) => { writes.push(s.currentState); },
        decideEvent,
      });

      expect(writes.slice(0, 2)).toEqual(["run", "verify"]);
      expect(res.event).toBe(expected.event);
      expect(res.state.currentState).toBe(expected.final);
    },
  );

  test("decideEvent receives post-VERIFY state (phaseResults available)", async () => {
    const sm = new StateMachine();
    let seen: LoopState | null = null;
    const decideEvent = (allPassed: boolean, s: LoopState) => {
      seen = s;
      expect(allPassed).toBe(true);
      expect(s.phaseResults).toEqual({ demo: { status: "pass" } });
      return "LOOP";
    };

    await runLoopBody({
      sm,
      state: makeState(),
      config: baseConfig(),
      plugins: [],
      iteration: 1,
      writeState: async () => {},
      decideEvent,
    });

    expect(seen).not.toBeNull();
  });
});
