import { describe, expect, test, afterAll } from "bun:test";
import { evaluatePhase } from "../src/evaluate.js";
import type { PhaseDef, PhaseResult } from "../src/types.js";

// Mock globalThis.fetch so callLLM uses our controlled responses instead of
// real network calls.  NOTE: do NOT use mock.module here — it is global
// across ALL test files in bun and would poison llm.test.ts.
const originalFetch = globalThis.fetch;

// Set env vars that evaluatePhase reads for the direct LLM path.
// These just need to be non-empty — callLLM is real but fetch is mocked.
const savedApiKey = Bun.env.LLM_API_KEY;
const savedModel = Bun.env.LLM_MODEL;

Bun.env.LLM_API_KEY = "sk-test-key";
Bun.env.LLM_MODEL = "gpt-4o";

afterAll(() => {
  if (savedApiKey === undefined) delete Bun.env.LLM_API_KEY;
  else Bun.env.LLM_API_KEY = savedApiKey;
  if (savedModel === undefined) delete Bun.env.LLM_MODEL;
  else Bun.env.LLM_MODEL = savedModel;
});

describe("evaluatePhase - direct LLM path", () => {
  test("returns Judgment from LLM response when phase has provider", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"passed": true, "reason": "LLM confirmed", "confidence": 0.95}' } }],
        }),
        { status: 200 },
      );

    try {
      const phase: PhaseDef = {
        name: "llm-eval",
        command: "echo hello",
        expectedExitCode: 0,
        timeoutMs: 1000,
        llm: { provider: "openai", prompt: "Evaluate this" },
      };
      const result: PhaseResult = {
        status: "pass",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        durationMs: 10,
        evidencePath: "",
      };
      const judgment = await evaluatePhase(phase, result);
      expect(judgment.passed).toBe(true);
      expect(judgment.reason).toBe("LLM confirmed");
      expect(judgment.confidence).toBe(0.95);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to exit code judgment when callLLM throws", async () => {
    globalThis.fetch = async () => new Response("Server error", { status: 500 });

    try {
      const phase: PhaseDef = {
        name: "llm-fail",
        command: "echo hello",
        expectedExitCode: 0,
        timeoutMs: 1000,
        llm: { provider: "openai", prompt: "Evaluate this" },
      };
      const result: PhaseResult = {
        status: "pass",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        durationMs: 10,
        evidencePath: "",
      };
      const judgment = await evaluatePhase(phase, result);
      expect(judgment.passed).toBe(true);
      expect(judgment.reason).toBe("exit code (LLM fallback)");
      expect(judgment.confidence).toBe(1.0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("MCP path falls back to exit code when binary missing (regression)", async () => {
    const phase: PhaseDef = {
      name: "mcp-eval",
      command: "echo hello",
      expectedExitCode: 0,
      timeoutMs: 1000,
      llm: { mcpServer: "nonexistent-mcp-binary", tool: "evaluate", prompt: "{}" },
    };
    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await evaluatePhase(phase, result);
    // MCP call fails (binary doesn't exist) -> falls back to exit code judgment
    expect(judgment.passed).toBe(true);
    expect(judgment.reason).toBe("exit code (LLM fallback)");
    expect(judgment.confidence).toBe(1.0);
  });
});

describe("evaluatePhase - exit code fallback", () => {
  test("returns passed when exit code matches expected", async () => {
    const phase: PhaseDef = {
      name: "test",
      command: "",
      expectedExitCode: 0,
      timeoutMs: 1000,
    };
    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await evaluatePhase(phase, result);
    expect(judgment.passed).toBe(true);
    expect(judgment.reason).toBe("exit code");
    expect(judgment.confidence).toBe(1.0);
  });

  test("returns failed when exit code mismatches", async () => {
    const phase: PhaseDef = {
      name: "test",
      command: "",
      expectedExitCode: 0,
      timeoutMs: 1000,
    };
    const result: PhaseResult = {
      status: "fail",
      exitCode: 1,
      stdout: "",
      stderr: "error",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await evaluatePhase(phase, result);
    expect(judgment.passed).toBe(false);
  });

  test("handles non-zero expected exit code", async () => {
    const phase: PhaseDef = {
      name: "test",
      command: "",
      expectedExitCode: 1,
      timeoutMs: 1000,
    };
    const result: PhaseResult = {
      status: "pass",
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 10,
      evidencePath: "",
    };
    const judgment = await evaluatePhase(phase, result);
    expect(judgment.passed).toBe(true);
    expect(judgment.reason).toBe("exit code");
  });

  test("returns valid Judgment shape", async () => {
    const phase: PhaseDef = {
      name: "test",
      command: "",
      expectedExitCode: 0,
      timeoutMs: 1000,
    };
    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      evidencePath: "",
    };
    const judgment = await evaluatePhase(phase, result);
    expect(judgment).toHaveProperty("passed");
    expect(judgment).toHaveProperty("reason");
    expect(judgment).toHaveProperty("confidence");
    expect(typeof judgment.passed).toBe("boolean");
    expect(typeof judgment.reason).toBe("string");
    expect(typeof judgment.confidence).toBe("number");
  });
});
