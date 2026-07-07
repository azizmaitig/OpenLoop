import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readState,
  writeState,
  createInitialState,
  updatePhaseResult,
  updateStateMd,
} from "../src/state.js";
import type { LoopConfig, PhaseResult, StateMdFrontmatter } from "../src/state.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-loop-state-"));
}

describe("readState", () => {
  test("returns null for non-existent file", async () => {
    const state = await readState("/tmp/nonexistent-file-12345.state");
    expect(state).toBeNull();
  });

  test("returns null for empty file", async () => {
    const dir = await tempDir();
    const p = join(dir, "empty.md");
    await Bun.write(p, "");
    const state = await readState(p);
    expect(state).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null for invalid content", async () => {
    const dir = await tempDir();
    const p = join(dir, "invalid.md");
    await Bun.write(p, "not yaml\nor json");
    const state = await readState(p);
    expect(state).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("writeState + readState round-trip", () => {
  test("round-trips a basic state", async () => {
    const dir = await tempDir();
    const p = join(dir, "state.md");

    const original = createInitialState({
      taskName: "test",
      phases: [],
      maxIterations: 3,
      phaseTimeoutMs: 60000,
    });
    original.iteration = 1;

    await writeState(p, original);
    const loaded = await readState(p);

    expect(loaded).not.toBeNull();
    expect(loaded!.currentState).toBe("init");
    expect(loaded!.iteration).toBe(1);
    expect(loaded!.errors).toEqual([]);
    expect(loaded!.phaseResults).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips phaseResults", async () => {
    const dir = await tempDir();
    const p = join(dir, "with-phases.md");

    const result: PhaseResult = {
      status: "pass",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 123,
      evidencePath: "/tmp/evidence.json",
    };

    const original = createInitialState({
      taskName: "test",
      phases: [],
      maxIterations: 3,
      phaseTimeoutMs: 60000,
    });
    const withResult = updatePhaseResult(original, "run", result);
    await writeState(p, withResult);

    const loaded = await readState(p);
    expect(loaded).not.toBeNull();
    expect(loaded!.phaseResults["run"]).toBeDefined();
    expect(loaded!.phaseResults["run"].status).toBe("pass");
    expect(loaded!.phaseResults["run"].exitCode).toBe(0);
    expect(loaded!.phaseResults["run"].stdout).toBe("hello");
    expect(loaded!.phaseResults["run"].stderr).toBe("");
    expect(loaded!.phaseResults["run"].durationMs).toBe(123);
    expect(loaded!.phaseResults["run"].evidencePath).toBe("/tmp/evidence.json");

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips errors array", async () => {
    const dir = await tempDir();
    const p = join(dir, "errors.md");

    const state = createInitialState({
      taskName: "test",
      phases: [],
      maxIterations: 3,
      phaseTimeoutMs: 60000,
    });
    state.errors = ["something went wrong", "another issue"];
    await writeState(p, state);

    const loaded = await readState(p);
    expect(loaded).not.toBeNull();
    expect(loaded!.errors).toEqual(["something went wrong", "another issue"]);

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips startTime", async () => {
    const dir = await tempDir();
    const p = join(dir, "time.md");

    const state = createInitialState({
      taskName: "test",
      phases: [],
      maxIterations: 3,
      phaseTimeoutMs: 60000,
    });
    state.startTime = "2026-07-02T10:00:00.000Z";
    await writeState(p, state);

    const loaded = await readState(p);
    expect(loaded).not.toBeNull();
    expect(loaded!.startTime).toBe("2026-07-02T10:00:00.000Z");

    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips multiple phase results", async () => {
    const dir = await tempDir();
    const p = join(dir, "multi.md");

    const state = createInitialState({
      taskName: "test",
      phases: [],
      maxIterations: 3,
      phaseTimeoutMs: 60000,
    });

    const runResult: PhaseResult = {
      status: "pass", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100, evidencePath: "/e1",
    };
    const verifyResult: PhaseResult = {
      status: "fail", exitCode: 1, stdout: "", stderr: "err", durationMs: 200, evidencePath: "/e2",
    };

    const withRun = updatePhaseResult(state, "run", runResult);
    const withBoth = updatePhaseResult(withRun, "verify", verifyResult);
    await writeState(p, withBoth);

    const loaded = await readState(p);
    expect(loaded).not.toBeNull();
    expect(loaded!.phaseResults["run"].status).toBe("pass");
    expect(loaded!.phaseResults["verify"].status).toBe("fail");
    expect(loaded!.phaseResults["verify"].exitCode).toBe(1);
    expect(loaded!.phaseResults["verify"].stderr).toBe("err");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("createInitialState", () => {
  const config: LoopConfig = {
    taskName: "my-task",
    phases: [],
    maxIterations: 5,
    phaseTimeoutMs: 30000,
  };

  test("has default currentState = 'init'", () => {
    const state = createInitialState(config);
    expect(state.currentState).toBe("init");
  });

  test("has iteration = 0", () => {
    const state = createInitialState(config);
    expect(state.iteration).toBe(0);
  });

  test("has empty phaseResults", () => {
    const state = createInitialState(config);
    expect(state.phaseResults).toEqual({});
  });

  test("has empty errors", () => {
    const state = createInitialState(config);
    expect(state.errors).toEqual([]);
  });

  test("startTime is a valid ISO string", () => {
    const state = createInitialState(config);
    const parsed = new Date(state.startTime);
    expect(parsed.toISOString()).toBe(state.startTime);
  });
});

describe("updatePhaseResult", () => {
  test("returns a new object (immutable)", () => {
    const config: LoopConfig = {
      taskName: "test", phases: [], maxIterations: 3, phaseTimeoutMs: 60000,
    };
    const state = createInitialState(config);
    const result: PhaseResult = {
      status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 0, evidencePath: "",
    };
    const updated = updatePhaseResult(state, "run", result);

    expect(updated).not.toBe(state);
    expect(state.phaseResults).toEqual({});
    expect(updated.phaseResults["run"]).toBe(result);
  });

  test("preserves existing phase results", () => {
    const config: LoopConfig = {
      taskName: "test", phases: [], maxIterations: 3, phaseTimeoutMs: 60000,
    };
    const state = createInitialState(config);

    const r1: PhaseResult = {
      status: "pass", exitCode: 0, stdout: "a", stderr: "", durationMs: 10, evidencePath: "",
    };
    const r2: PhaseResult = {
      status: "fail", exitCode: 1, stdout: "", stderr: "b", durationMs: 20, evidencePath: "",
    };

    const s1 = updatePhaseResult(state, "phase1", r1);
    const s2 = updatePhaseResult(s1, "phase2", r2);

    expect(s2.phaseResults["phase1"]).toBe(r1);
    expect(s2.phaseResults["phase2"]).toBe(r2);
  });

  test("overwrites existing phase result for same key", () => {
    const config: LoopConfig = {
      taskName: "test", phases: [], maxIterations: 3, phaseTimeoutMs: 60000,
    };
    const state = createInitialState(config);

    const first: PhaseResult = {
      status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 10, evidencePath: "",
    };
    const second: PhaseResult = {
      status: "error", exitCode: 2, stdout: "", stderr: "", durationMs: 20, evidencePath: "",
    };

    const s1 = updatePhaseResult(state, "build", first);
    const s2 = updatePhaseResult(s1, "build", second);

    expect(s2.phaseResults["build"].status).toBe("error");
    expect(s2.phaseResults["build"].durationMs).toBe(20);
    expect(Object.keys(s2.phaseResults).length).toBe(1);
  });
});

describe("updateStateMd", () => {
  const fm: StateMdFrontmatter = {
    last_run: "2026-07-05T12:00:00.000Z",
    current_state: "running",
    iteration: 5,
    active_children: 2,
    high_priority: 1,
    watch_items: 3,
    task_count: 42,
  };

  test("creates STATE.md with frontmatter when file doesn't exist", async () => {
    const dir = await tempDir();
    const p = join(dir, "STATE.md");
    await updateStateMd(p, fm);

    const content = await readFile(p, "utf-8");
    expect(content).toContain("last_run:");
    expect(content).toContain("2026-07-05T12:00:00.000Z");
    expect(content).toContain("current_state: running");
    expect(content).toContain("iteration: 5");
    expect(content).toContain("active_children: 2");
    expect(content).toContain("task_count: 42");

    await rm(dir, { recursive: true, force: true });
  });

  test("preserves body text after frontmatter", async () => {
    const dir = await tempDir();
    const p = join(dir, "STATE.md");

    // Write initial content with body
    await Bun.write(p, `---
last_run: never
current_state: idle
iteration: 0
active_children: 0
high_priority: 0
watch_items: 0
task_count: 0
---

# My Project

## Notes
Human written content here.
`);

    // Update frontmatter
    await updateStateMd(p, fm);

    const content = await readFile(p, "utf-8");
    // New frontmatter values
    expect(content).toContain("last_run:");
    expect(content).toContain("2026-07-05T12:00:00.000Z");
    expect(content).toContain("iteration: 5");
    // Body preserved
    expect(content).toContain("# My Project");
    expect(content).toContain("Human written content here.");

    await rm(dir, { recursive: true, force: true });
  });

  test("preserves body when file has no frontmatter (treats whole content as body)", async () => {
    const dir = await tempDir();
    const p = join(dir, "STATE.md");

    await Bun.write(p, "# Bare State\n\nNo frontmatter at all.");

    await updateStateMd(p, fm);

    const content = await readFile(p, "utf-8");
    expect(content).toContain("last_run:");
    expect(content).toContain("# Bare State");
    expect(content).toContain("No frontmatter at all.");

    await rm(dir, { recursive: true, force: true });
  });

  test("does not throw when called on non-existent path", async () => {
    const dir = await tempDir();
    const p = join(dir, "STATE.md");

    await expect(updateStateMd(p, fm)).resolves.toBeUndefined();
    const content = await readFile(p, "utf-8");
    expect(content.length).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });
});
