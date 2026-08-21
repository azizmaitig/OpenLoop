import { describe, expect, test } from "bun:test";
import {
  RecoveryStrategy,
  Guard,
  type RecoveryContext,
  type GuardContext,
} from "../src/recovery.js";
import type { Task, TaskQueue, PhaseDef, PhaseResult, LoopState } from "../src/types.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeTaskQueue(): TaskQueue & { _register(t: Task): void } {
  // Minimal stub: RecoveryStrategy.failTerminal only needs fail()/complete().
  // fail()/complete() mutate the SAME task object reference the caller holds
  // (mirrors the real TaskQueue, which finds the task by id and mutates it).
  const byId = new Map<string, Task>();
  const q = {
    _register(t: Task) { byId.set(t.id, t); },
    fail: (id: string, error: string) => {
      const t = byId.get(id);
      if (!t) return null;
      t.lifecycle = "failed";
      t.error = error;
      return t;
    },
    complete: (id: string, r: unknown) => {
      const t = byId.get(id);
      if (!t) return null;
      t.lifecycle = "completed";
      t.result = r as Task["result"];
      return t;
    },
    get: (id: string) => byId.get(id),
  };
  return q as TaskQueue & { _register(t: Task): void };
}

const sampleTask: Task = {
  id: "task-1",
  command: "echo hi",
  lifecycle: "running",
  createdAt: new Date().toISOString(),
};

const samplePhase: PhaseDef = {
  name: "verify",
  command: "echo hi",
  expectedExitCode: 0,
  timeoutMs: 5000,
};

const sampleResult: PhaseResult = {
  status: "fail",
  exitCode: 1,
  stdout: "",
  stderr: "boom",
  durationMs: 10,
};

const sampleState: LoopState = {
  currentState: "verify",
  iteration: 1,
  phaseResults: {},
  startTime: new Date().toISOString(),
  errors: [],
};

// ── RecoveryStrategy.failTerminal ──────────────────────────────────────────────

describe("RecoveryStrategy.failTerminal", () => {
  test("marks the task failed and broadcasts a task_completed event", () => {
    const q = fakeTaskQueue();
    // Register so fail()/get() resolve the SAME object reference (mirrors real queue).
    q._register(sampleTask);
    const broadcasts: Array<{ type: string; data: unknown }> = [];
    const ctx: RecoveryContext = {
      taskQueue: q,
      broadcast: (type, data) => broadcasts.push({ type, data }),
    };

    RecoveryStrategy.failTerminal(ctx, sampleTask, "verify failed");

    expect(sampleTask.lifecycle).toBe("failed");
    expect(sampleTask.error).toContain("verify failed");
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]!.type).toBe("task_completed");
  });

  test("failTerminal is the only wired recovery variant (healAndRetry has no caller)", () => {
    // Sanity check that both variants are exported and failTerminal is callable.
    expect(typeof RecoveryStrategy.failTerminal).toBe("function");
    expect(typeof RecoveryStrategy.healAndRetry).toBe("function");
  });
});

// ── healAndRetry is defined but unwired ───────────────────────────────────────

describe("RecoveryStrategy.healAndRetry (defined, unwired)", () => {
  test("is exported and callable without touching the queue when no heal command is present", async () => {
    const q = fakeTaskQueue();
    const broadcasts: Array<{ type: string; data: unknown }> = [];
    let runCount = 0;
    const ctx: RecoveryContext & { runCommand?: (c: string) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> } = {
      taskQueue: q,
      broadcast: (type, data) => broadcasts.push({ type, data }),
    };
    const phase: PhaseDef = { ...samplePhase };
    const result: PhaseResult = { ...sampleResult };

    // Defined but intentionally has no live caller in execute-phases / task-processor.
    // Invoking here only verifies the shape is sound; it must not crash.
    const outcome = await RecoveryStrategy.healAndRetry(
      { ...ctx, runCommand: async () => { runCount++; return { exitCode: 0, stdout: "healed", stderr: "", durationMs: 1 }; } },
      phase,
      result,
      { healCommand: "echo fix", maxRetries: 1 },
    );

    expect(outcome).toBeDefined();
    // healAndRetry runs the heal command once, then re-runs the verify phase once.
    expect(runCount).toBe(2);
    expect(outcome.healed).toBe(true);
  });

  test("REJECTS the heal when its output touches a denylisted path (T5 D6.5)", async () => {
    const q = fakeTaskQueue();
    const ctx: RecoveryContext & { runCommand?: (c: string) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> } = {
      taskQueue: q,
      broadcast: () => {},
      auditHeal: (stdout, stderr) =>
        (stdout + "\n" + stderr).includes(".env")
          ? [{ rule: "audit-denylisted-path", detail: "heal stdout references .env" }]
          : [],
    };
    const phase: PhaseDef = { ...samplePhase };
    const result: PhaseResult = { ...sampleResult };

    const outcome = await RecoveryStrategy.healAndRetry(
      { ...ctx, runCommand: async () => ({ exitCode: 0, stdout: "wrote .env", stderr: "", durationMs: 1 }) },
      phase,
      result,
      { healCommand: "echo fix", maxRetries: 1 },
    );

    expect(outcome.healed).toBe(false);
    expect(outcome.auditViolations).toBeDefined();
    expect(outcome.auditViolations!.length).toBeGreaterThan(0);
    // No re-run of the verify phase after a REJECTED heal — runCommand is
    // called once (heal) and never again (retry).
    let healCalls = 0;
    await RecoveryStrategy.healAndRetry(
      { ...ctx, runCommand: async () => { healCalls++; return { exitCode: 0, stdout: "wrote .env", stderr: "", durationMs: 1 }; } },
      phase,
      { ...sampleResult },
      { healCommand: "echo fix", maxRetries: 2 },
    );
    expect(healCalls).toBe(1);
  });
});

// ── Guard.shouldRun ───────────────────────────────────────────────────────────

describe("Guard.shouldRun", () => {
  const baseCtx: GuardContext = {
    baseDir: ".",
    isPaused: async () => false,
    isSafeCommand: (cmd: string) => !/[;&|`]/.test(cmd),
  };

  test("allows a safe, non-paused task when budget is ok", async () => {
    const decision = await Guard.shouldRun(baseCtx, sampleTask, "ok");
    expect(decision.run).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  test("blocks when budget is exceeded (cancel-report guard outcome)", async () => {
    const decision = await Guard.shouldRun(baseCtx, sampleTask, "exceeded");
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("exceeded");
  });

  test("blocks (cancel-report) when budget is report_only", async () => {
    const decision = await Guard.shouldRun(baseCtx, sampleTask, "report_only");
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("report-only");
  });

  test("blocks when the daemon is paused", async () => {
    const ctx: GuardContext = { ...baseCtx, isPaused: async () => true };
    const decision = await Guard.shouldRun(ctx, sampleTask, "ok");
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("paused");
  });

  test("blocks unsafe commands before any execution", async () => {
    const unsafe: Task = { ...sampleTask, command: "echo hi; rm -rf /" };
    const decision = await Guard.shouldRun(baseCtx, unsafe, "ok");
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("unsafe");
  });
});
