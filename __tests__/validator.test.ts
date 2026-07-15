import { describe, expect, test, afterAll } from "bun:test";
import { validatePhase } from "../src/validator.js";
import { executePhaseGroup } from "../src/execute-phases.js";
import type { PhaseDef, PhaseResult, LoopConfig, LoopState, ExecutionDeps } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

// Save original env for restore
const savedApiKey = Bun.env.LLM_API_KEY;
const savedModel = Bun.env.LLM_MODEL;
const savedProvider = Bun.env.LLM_PROVIDER;

// Set env so buildLlmConfig returns a config for validation paths
function setEnv() {
  Bun.env.LLM_API_KEY = "sk-test-key";
  Bun.env.LLM_MODEL = "gpt-4o";
  Bun.env.LLM_PROVIDER = "openai";
}

function clearEnv() {
  delete Bun.env.LLM_API_KEY;
  delete Bun.env.LLM_MODEL;
  delete Bun.env.LLM_PROVIDER;
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (savedApiKey === undefined) delete Bun.env.LLM_API_KEY;
  else Bun.env.LLM_API_KEY = savedApiKey;
  if (savedModel === undefined) delete Bun.env.LLM_MODEL;
  else Bun.env.LLM_MODEL = savedModel;
  if (savedProvider === undefined) delete Bun.env.LLM_PROVIDER;
  else Bun.env.LLM_PROVIDER = savedProvider;
});

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
    currentState: "init",
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

// ── validatePhase ─────────────────────────────────────────────────────────────

describe("validatePhase", () => {
  test("returns passed:true Judgment when LLM confirms output meets criteria", async () => {
    setEnv();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"passed": true, "reason": "Output meets criteria", "confidence": 0.95}' } }],
        }),
        { status: 200 },
      );

    try {
      const phase: PhaseDef = makePhase({
        name: "validated",
        validator: { criteria: "Must contain hello" },
      });
      const result: PhaseResult = {
        status: "pass",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        durationMs: 10,
        evidencePath: "",
      };
      const judgment = await validatePhase(phase, result);
      expect(judgment).toBeDefined();
      expect(judgment!.passed).toBe(true);
      expect(judgment!.reason).toBe("Output meets criteria");
      expect(judgment!.confidence).toBe(0.95);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns passed:false Judgment when LLM rejects output", async () => {
    setEnv();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"passed": false, "reason": "Output missing required text", "confidence": 0.85}' } }],
        }),
        { status: 200 },
      );

    try {
      const phase: PhaseDef = makePhase({
        name: "validated",
        validator: { criteria: "Must contain goodbye" },
      });
      const result: PhaseResult = {
        status: "pass",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        durationMs: 10,
        evidencePath: "",
      };
      const judgment = await validatePhase(phase, result);
      expect(judgment).toBeDefined();
      expect(judgment!.passed).toBe(false);
      expect(judgment!.reason).toBe("Output missing required text");
      expect(judgment!.confidence).toBe(0.85);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns undefined when LLM API returns error", async () => {
    setEnv();
    globalThis.fetch = async () => new Response("Server error", { status: 500 });

    try {
      const phase: PhaseDef = makePhase({
        name: "validated",
        validator: { criteria: "Must contain hello" },
      });
      const result: PhaseResult = {
        status: "pass",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        durationMs: 10,
        evidencePath: "",
      };
      const judgment = await validatePhase(phase, result);
      expect(judgment).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("validatePhase fail-open", () => {
  test("returns undefined when no LLM configured (env vars unset)", async () => {
    clearEnv();
    const phase: PhaseDef = makePhase({
      name: "no-llm",
      validator: { criteria: "Must contain hello" },
    });
    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await validatePhase(phase, result);
    expect(judgment).toBeUndefined();
  });

  test("returns undefined when phase has no validator", async () => {
    setEnv();
    const phase: PhaseDef = makePhase({ name: "no-validator" });
    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await validatePhase(phase, result);
    expect(judgment).toBeUndefined();
  });
});

// ── runValidatorGate (via executePhaseGroup) ──────────────────────────────────

describe("runValidatorGate retry behavior", () => {
  test("records validation with retriesUsed=1 and passed:false (fail-open) when validation consistently fails", async () => {
    setEnv();
    // Mock fetch to ALWAYS return failing judgment
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"passed": false, "reason": "Output does not meet rubric", "confidence": 0.9}' } }],
        }),
        { status: 200 },
      );

    try {
      const phase = makePhase({
        name: "gate-test",
        command: "echo hi",
        // No llm field — exit-code eval only; validator handles LLM
        validator: { criteria: "Must say hello world", maxRetries: 1 },
      });

      const config = makeConfig([phase]);
      const state = makeState();
      const deps = makeDeps({ config });

      const result = await executePhaseGroup(deps, state, 1);

      const pr = result.state.phaseResults["gate-test"];
      expect(pr).toBeDefined();
      expect(pr!.status).toBe("pass"); // fail-open: phase still passes
      expect(pr!.validation).toBeDefined();
      expect(pr!.validation!.passed).toBe(false);
      expect(pr!.validation!.retriesUsed).toBe(1); // Conductor caps at 1
      expect(pr!.validation!.reason).toBe("Output does not meet rubric");
      expect(pr!.validation!.confidence).toBe(0.9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes validation on first attempt — retriesUsed=0", async () => {
    setEnv();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"passed": true, "reason": "Output matches rubric", "confidence": 1.0}' } }],
        }),
        { status: 200 },
      );

    try {
      const phase = makePhase({
        name: "pass-first",
        command: "echo hello world",
        validator: { criteria: "Must say hello world" },
      });

      const config = makeConfig([phase]);
      const state = makeState();
      const deps = makeDeps({ config });

      const result = await executePhaseGroup(deps, state, 1);

      const pr = result.state.phaseResults["pass-first"];
      expect(pr).toBeDefined();
      expect(pr!.validation).toBeDefined();
      expect(pr!.validation!.passed).toBe(true);
      expect(pr!.validation!.retriesUsed).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
