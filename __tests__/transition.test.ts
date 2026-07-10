import { describe, expect, test, beforeEach } from "bun:test";
import { applyTransition } from "../src/transition.js";
import { StateMachine } from "../src/state-machine.js";
import { getCurrentState, setCurrentState } from "../src/state.js";
import type { LoopState, PhaseResult } from "../src/types.js";

function mkPr(): PhaseResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    evidencePath: "x",
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    currentState: "init",
    iteration: 1,
    phaseResults: {},
    startTime: new Date(0).toISOString(),
    errors: [],
    ...overrides,
  };
}

describe("applyTransition", () => {
  beforeEach(() => setCurrentState(null));

  test("LOOP clears phaseResults and returns to init", () => {
    const sm = new StateMachine("verify");
    const s = makeState({ currentState: "verify", phaseResults: { scan: mkPr() } });
    const next = applyTransition("LOOP", s, sm);
    expect(next.currentState).toBe("init");
    expect(next.phaseResults).toEqual({});
    expect(sm.currentState).toBe("init");
  });

  test("VERIFY sets currentState and updates the global mirror", () => {
    const sm = new StateMachine("run");
    const s = makeState({ currentState: "run" });
    const next = applyTransition("VERIFY", s, sm);
    expect(next.currentState).toBe("verify");
    expect(getCurrentState()?.currentState).toBe("verify");
    expect(sm.currentState).toBe("verify");
  });

  test("non-LOOP event preserves phaseResults", () => {
    const sm = new StateMachine("run");
    const pr = mkPr();
    const s = makeState({ currentState: "run", phaseResults: { scan: pr } });
    const next = applyTransition("VERIFY", s, sm);
    expect(next.phaseResults).toEqual({ scan: pr });
  });

  test("invalid event for current state throws (owned by StateMachine)", () => {
    const sm = new StateMachine("init");
    const s = makeState({ currentState: "init" });
    expect(() => applyTransition("VERIFY", s, sm)).toThrow();
  });

  test("returns a new state object (does not mutate input)", () => {
    const sm = new StateMachine("run");
    const s = makeState({ currentState: "run" });
    const next = applyTransition("VERIFY", s, sm);
    expect(next).not.toBe(s);
    expect(s.currentState).toBe("run");
  });
});
