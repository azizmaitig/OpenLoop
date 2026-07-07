import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createMakerCheckerPlugin } from "../src/maker-checker-plugin.js";
import type { PhaseDef, PhaseResult, LoopState } from "../src/types.js";

// NOTE: do NOT use mock.module here — it is global across ALL test files in
// bun and would poison llm.test.ts.  Instead mock globalThis.fetch to
// control what callLLM returns.

// Control variable — set before tests that need a custom LLM response.
let llmResponseJson = '{"passed": true, "reason": "all good"}';

const originalFetch = globalThis.fetch;

function makePhase(name: string, overrides?: Partial<PhaseDef>): PhaseDef {
  return {
    name,
    command: `echo ${name}`,
    expectedExitCode: 0,
    timeoutMs: 1000,
    ...overrides,
  };
}

function makeResult(overrides?: Partial<PhaseResult>): PhaseResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 10,
    evidencePath: "",
    ...overrides,
  };
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    currentState: "run",
    iteration: 1,
    phaseResults: {},
    startTime: new Date().toISOString(),
    errors: [],
    ...overrides,
  };
}

describe("createMakerCheckerPlugin", () => {
  test("disabled: hooks are no-ops", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: false });
    const state = makeState();

    await plugin.onPhaseEnd!(makePhase("maker"), makeResult(), state);
    expect(state.phaseResults["checker"]).toBeUndefined();
    expect(state.errors).toEqual([]);
  });

  test("enabled: maker completion schedules checker in phaseResults", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true });
    const state = makeState();
    const makerResult = makeResult({ status: "pass", stdout: "data processed" });

    await plugin.onPhaseEnd!(makePhase("maker"), makerResult, state);

    expect(state.phaseResults["checker"]).toBeDefined();
    expect(state.phaseResults["checker"].stdout).toBe("data processed");
  });

  test("enabled: maker failure does not schedule checker", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true });
    const state = makeState();

    await plugin.onPhaseEnd!(makePhase("maker"), makeResult({ status: "fail" }), state);

    expect(state.phaseResults["checker"]).toBeUndefined();
  });

  test("enabled: checker pass does not trigger retry", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true });
    const state = makeState();
    const checkerResult = makeResult({
      status: "pass",
      judgment: { passed: true, reason: "Output correct", confidence: 0.95 },
    });

    await plugin.onPhaseEnd!(makePhase("checker"), checkerResult, state);

    const retryErrors = state.errors.filter((e) => e.includes("retry"));
    expect(retryErrors).toEqual([]);
  });

  test("enabled: checker fail triggers retry", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true, maxCheckerRetries: 2 });
    const state = makeState();
    const checkerResult = makeResult({
      status: "fail",
      judgment: { passed: false, reason: "Output incorrect", confidence: 0.8 },
    });

    await plugin.onPhaseEnd!(makePhase("checker"), checkerResult, state);

    expect(state.errors.some((e) => e.includes("retry") && e.includes("maker"))).toBe(true);
  });

  test("enabled: max retries exhausted marks phase FAILED", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true, maxCheckerRetries: 0 });
    const state = makeState();
    const checkerResult = makeResult({
      status: "fail",
      judgment: { passed: false, reason: "Still wrong", confidence: 0.9 },
    });

    await plugin.onPhaseEnd!(makePhase("checker"), checkerResult, state);

    expect(state.errors.some((e) => e.includes("FAILED"))).toBe(true);
  });

  test("enabled: retry count resets after a pass", async () => {
    const plugin = createMakerCheckerPlugin({ enabled: true, maxCheckerRetries: 2 });
    const state = makeState();

    // First checker fail
    const failResult = makeResult({
      status: "fail",
      judgment: { passed: false, reason: "Wrong", confidence: 0.8 },
    });
    await plugin.onPhaseEnd!(makePhase("checker"), failResult, state);
    expect(state.errors.filter((e) => e.includes("retry")).length).toBe(1);

    // Maker re-runs, then checker passes
    const passResult = makeResult({
      status: "pass",
      judgment: { passed: true, reason: "Fixed", confidence: 0.95 },
    });
    await plugin.onPhaseEnd!(makePhase("checker"), passResult, state);

    // No new retry errors — the pass doesn't add one
    expect(state.errors.filter((e) => e.includes("retry")).length).toBe(1);
  });

  test("plugin has all required hooks", () => {
    const plugin = createMakerCheckerPlugin({ enabled: true });

    expect(plugin.name).toBe("maker-checker");
    expect(typeof plugin.onPhaseEnd).toBe("function");
    expect(typeof plugin.onPhaseStart).toBe("function");
    expect(typeof plugin.onError).toBe("function");
    expect(typeof plugin.beforeLoop).toBe("function");
    expect(typeof plugin.afterLoop).toBe("function");
  });
});

describe("createMakerCheckerPlugin - AI verification path", () => {
  // Set env vars so envLlmConfig() returns a valid config
  const savedProvider = Bun.env.LLM_PROVIDER;
  const savedKey = Bun.env.LLM_API_KEY;
  const savedModel = Bun.env.LLM_MODEL;

  beforeAll(() => {
    Bun.env.LLM_PROVIDER = "openai";
    Bun.env.LLM_API_KEY = "sk-test";
    Bun.env.LLM_MODEL = "gpt-4o";
  });

  afterAll(() => {
    Bun.env.LLM_PROVIDER = savedProvider;
    if (savedKey === undefined) delete Bun.env.LLM_API_KEY;
    else Bun.env.LLM_API_KEY = savedKey;
    if (savedModel === undefined) delete Bun.env.LLM_MODEL;
    else Bun.env.LLM_MODEL = savedModel;
  });

  test("maker passes -> AI approves -> checker judgment.passed is true", async () => {
    llmResponseJson = '{"passed": true, "reason": "looks good"}';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: llmResponseJson } }],
        }),
        { status: 200 },
      );

    try {
      const plugin = createMakerCheckerPlugin({ enabled: true });
      const state = makeState();

      await plugin.onPhaseEnd!(makePhase("maker"), makeResult({ stdout: "output ok" }), state);

      const checker = state.phaseResults["checker"];
      expect(checker).toBeDefined();
      expect(checker.judgment).toBeDefined();
      expect(checker.judgment!.passed).toBe(true);
      expect(checker.judgment!.reason).toBe("looks good");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maker passes -> AI rejects -> checker judgment.passed is false", async () => {
    llmResponseJson = '{"passed": false, "reason": "output incorrect"}';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: llmResponseJson } }],
        }),
        { status: 200 },
      );

    try {
      const plugin = createMakerCheckerPlugin({ enabled: true });
      const state = makeState();

      await plugin.onPhaseEnd!(makePhase("maker"), makeResult({ stdout: "bad output" }), state);

      const checker = state.phaseResults["checker"];
      expect(checker).toBeDefined();
      expect(checker.judgment).toBeDefined();
      expect(checker.judgment!.passed).toBe(false);
      expect(checker.judgment!.reason).toBe("output incorrect");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maker passes -> AI throws -> falls back to judgment undefined", async () => {
    // Return invalid JSON from the LLM so JSON.parse inside runAiVerification
    // throws, which is caught and returns undefined.
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "not valid json" } }],
        }),
        { status: 200 },
      );

    try {
      const plugin = createMakerCheckerPlugin({ enabled: true });
      const state = makeState();

      await plugin.onPhaseEnd!(makePhase("maker"), makeResult({ stdout: "bad output" }), state);

      const checker = state.phaseResults["checker"];
      expect(checker).toBeDefined();
      expect(checker.judgment).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
