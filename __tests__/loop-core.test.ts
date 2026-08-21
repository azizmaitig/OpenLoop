import { describe, expect, test, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync as exists } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { runLoopBody } = await import("../src/loop-core.js");
const { StateMachine } = await import("../src/state-machine.js");
const { createInitialState } = await import("../src/state.js");

import type { LoopState } from "../src/types.js";
import type { OpenCodeClient } from "../src/opencode-client.js";
import type { WorktreeManagerDeps } from "../src/worktree-manager.js";

function fakeExecutePhaseGroup(_deps: unknown, state: any, _iteration: number) {
  return Promise.resolve({
    allPassed: true,
    state: { ...state, phaseResults: { demo: { status: "pass" } } },
  });
}

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

function createTempRepo(baseDir: string): string {
  const repoDir = join(baseDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });
  r("git init");
  r("git config user.email test@test.com");
  r("git config user.name Test");
  writeFileSync(join(repoDir, "README.md"), "# Test Repo");
  r("git add -A");
  r("git commit -m initial");
  return repoDir;
}

function stubClient(repoDir: string, worktreeDir: string): OpenCodeClient {
  return {
    async createWorkspace(opts) {
      mkdirSync(worktreeDir, { recursive: true });
      const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });
      r("git worktree add -b " + opts.branch + " " + worktreeDir);
      return { id: "wrk_test", type: "worktree", name: "test-wt", branch: opts.branch, directory: worktreeDir };
    },
    async deleteWorktree(directory) {
      const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });
      return r("git worktree remove --force " + directory).exitCode === 0;
    },
    async listWorktrees() {
      return [];
    },
  } as OpenCodeClient;
}

function makeWtDeps(client: OpenCodeClient): WorktreeManagerDeps {
  return { client };
}

describe("runLoopBody (shared loop core)", () => {
  test("with a targetSpec + worktreeManager: prepares the target, threads it into ExecutionDeps, finalizes on allPassed", async () => {
    const f = { baseDir: mkdtempSync(join(tmpdir(), "lc-wt-")) };
    try {
      const repoDir = createTempRepo(f.baseDir);
      const worktreeDir = join(f.baseDir, "wt");
      const client = stubClient(repoDir, worktreeDir);
      let sawTarget = false;

      const fake = async (deps: any, state: LoopState, _iteration: number) => {
        sawTarget = deps.target !== undefined;
        return {
          allPassed: true,
          state: { ...state, phaseResults: { demo: { status: "pass" } } },
        };
      };

      const sm = new StateMachine();
      const result = await runLoopBody({
        sm,
        state: makeState(),
        config: baseConfig(),
        plugins: [],
        iteration: 1,
        writeState: async () => {},
        decideEvent: async () => "LOOP",
        executePhaseGroup: fake,
        targetSpec: { targetPath: repoDir, isolated: true, branch: "agent/lc-test" },
        worktreeManager: makeWtDeps(client),
      });

      expect(sawTarget).toBe(true);
      expect(exists(worktreeDir)).toBe(false); // finalize APPROVE discarded the worktree
      expect(result.event).toBe("LOOP");
    } finally {
      rmSync(f.baseDir, { recursive: true, force: true });
    }
  });

  test("with a targetSpec + throwing executePhaseGroup: discards the target (leak guard)", async () => {
    const f = { baseDir: mkdtempSync(join(tmpdir(), "lc-wt-")) };
    try {
      const repoDir = createTempRepo(f.baseDir);
      const worktreeDir = join(f.baseDir, "wt");
      const client = stubClient(repoDir, worktreeDir);

      const fake = async () => { throw new Error("boom"); };

      const sm = new StateMachine();
      await expect(
        runLoopBody({
          sm,
          state: makeState(),
          config: baseConfig(),
          plugins: [],
          iteration: 1,
          writeState: async () => {},
          decideEvent: async () => "LOOP",
          executePhaseGroup: fake,
          targetSpec: { targetPath: repoDir, isolated: true, branch: "agent/lc-leak" },
          worktreeManager: makeWtDeps(client),
        }),
      ).rejects.toThrow("boom");
      expect(exists(worktreeDir)).toBe(false); // discarded on throw
    } finally {
      rmSync(f.baseDir, { recursive: true, force: true });
    }
  });

  test("without a targetSpec: behaves exactly as before (no target threading)", async () => {
    const sm = new StateMachine();
    let sawTarget = false;
    const fake = async (deps: any, state: LoopState, _iteration: number) => {
      sawTarget = deps.target !== undefined;
      return {
        allPassed: true,
        state: { ...state, phaseResults: { demo: { status: "pass" } } },
      };
    };
    const result = await runLoopBody({
      sm,
      state: makeState(),
      config: baseConfig(),
      plugins: [],
      iteration: 1,
      writeState: async () => {},
      decideEvent: async () => "LOOP",
      executePhaseGroup: fake,
    });
    expect(sawTarget).toBe(false);
    expect(result.event).toBe("LOOP");
  });

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
      executePhaseGroup: fakeExecutePhaseGroup,
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
      executePhaseGroup: fakeExecutePhaseGroup,
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
        executePhaseGroup: fakeExecutePhaseGroup,
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
      executePhaseGroup: fakeExecutePhaseGroup,
    });

    expect(seen).not.toBeNull();
  });
});
