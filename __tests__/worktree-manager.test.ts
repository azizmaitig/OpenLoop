import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  backupTarget,
  prepareTarget,
  finalizeTarget,
  isGitTarget,
} from "../src/worktree-manager.js";
import type { TargetHandle, WorktreeManagerDeps } from "../src/worktree-manager.js";
import type { OpenCodeClient } from "../src/opencode-client.js";

function makeDeps(client: OpenCodeClient, opts: { log?: WorktreeManagerDeps["log"]; runGh?: WorktreeManagerDeps["runGh"] } = {}): WorktreeManagerDeps {
  return {
    client,
    runGh: opts.runGh,
    log: opts.log,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function setupFixture(): { baseDir: string; cleanup: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), "wtm-test-"));
  return { baseDir, cleanup: () => rmSync(baseDir, { recursive: true, force: true }) };
}

/** A stub opencode client whose createWorkspace returns a REAL git worktree (fabricated via git CLI). */
function stubClient(repoDir: string, worktreeDir: string): OpenCodeClient & { createdBranches: string[] } {
  const createdBranches: string[] = [];
  return {
    createdBranches,
    async createWorkspace(opts) {
      createdBranches.push(opts.branch);
      mkdirSync(worktreeDir, { recursive: true });
      const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });
      r("git worktree add -b " + opts.branch + " " + worktreeDir);
      return {
        id: "wrk_test",
        type: "worktree",
        name: "test-wt",
        branch: opts.branch,
        directory: worktreeDir,
      };
    },
    async deleteWorktree(directory) {
      const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });
      const res = r("git worktree remove --force " + directory);
      return res.exitCode === 0;
    },
    async listWorktrees() {
      return [];
    },
  } as OpenCodeClient;
}

// ---------------------------------------------------------------------------
// backupTarget — non-git target protection (T6)
// ---------------------------------------------------------------------------

describe("backupTarget", () => {
  test("creates <target>.bak before any touch (idempotent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wtm-backup-"));
    try {
      const target = join(dir, "target.txt");
      writeFileSync(target, "original");

      const first = await backupTarget(target);
      expect(first.skipped).toBe(false);
      expect(first.backupPath).toBe(`${target}.bak`);
      expect(existsSync(`${target}.bak`)).toBe(true);
      expect(readFileSync(`${target}.bak`, "utf8")).toBe("original");

      // Simulate the agent modifying the target, then a second run backs up again.
      writeFileSync(target, "modified by agent");
      const second = await backupTarget(target);
      expect(second.skipped).toBe(true);
      // The .bak is never overwritten — it holds the pristine original.
      expect(readFileSync(`${target}.bak`, "utf8")).toBe("original");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles missing target by creating the parent dir backup path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wtm-backup-missing-"));
    try {
      const target = join(dir, "sub", "file.txt");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(target, "v1");
      const result = await backupTarget(target);
      expect(result.skipped).toBe(false);
      expect(existsSync(result.backupPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// prepareTarget — git vs non-git detection
// ---------------------------------------------------------------------------

describe("prepareTarget", () => {
  test("git target creates a native workspace and returns a git handle", async () => {
    const f = setupFixture();
    try {
      const repoDir = createTempRepo(f.baseDir);
      const worktreeDir = join(f.baseDir, "wt");
      const client = stubClient(repoDir, worktreeDir);
      const deps = makeDeps(client);

      const handle = await prepareTarget(
        { targetPath: repoDir, branch: "agent/t6-test", base: "HEAD", isolated: true },
        deps,
      );

      expect(handle.mode).toBe("git");
      if (handle.mode === "git") {
        expect(handle.workspaceID).toBe("wrk_test");
        expect(handle.directory).toBe(worktreeDir);
        expect(handle.branch).toBe("agent/t6-test");
        expect(existsSync(join(worktreeDir, "README.md"))).toBe(true);
      }
    } finally {
      f.cleanup();
    }
  });

  test("non-git target creates an idempotent .bak backup", async () => {
    const f = setupFixture();
    try {
      const target = join(f.baseDir, "target.txt");
      writeFileSync(target, "original");
      const client = stubClient(f.baseDir, join(f.baseDir, "wt"));
      const deps = makeDeps(client);

      const handle = await prepareTarget(
        { targetPath: target, branch: "agent/x", isolated: true },
        deps,
      );

      expect(handle.mode).toBe("backup");
      if (handle.mode === "backup") {
        expect(handle.backupPath).toBe(`${target}.bak`);
        expect(readFileSync(handle.backupPath, "utf8")).toBe("original");
      }
    } finally {
      f.cleanup();
    }
  });

  test("non-isolated target returns a backup-mode handle without touching anything", async () => {
    const f = setupFixture();
    try {
      const target = join(f.baseDir, "target.txt");
      writeFileSync(target, "original");
      const client = stubClient(f.baseDir, join(f.baseDir, "wt"));
      const deps = makeDeps(client);

      const handle = await prepareTarget(
        { targetPath: target, branch: "agent/x", isolated: false },
        deps,
      );

      expect(handle.mode).toBe("backup");
      expect(handle.backupPath).toBe("");
      expect(existsSync(`${target}.bak`)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("isGitTarget detects a non-git directory", async () => {
    const f = setupFixture();
    try {
      expect(await isGitTarget(f.baseDir)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// finalizeTarget — APPROVE / REJECT lifecycle
// ---------------------------------------------------------------------------

describe("finalizeTarget", () => {
  test("APPROVE commits the worktree branch, pushes, opens a draft PR, discards the worktree", async () => {
    const f = setupFixture();
    try {
      const repoDir = createTempRepo(f.baseDir);
      // Bare remote so `git push -u origin <branch>` succeeds.
      const bareDir = join(f.baseDir, "remote.git");
      mkdirSync(bareDir, { recursive: true });
      Bun.spawnSync(["git", "init", "--bare", bareDir]);
      Bun.spawnSync(["git", "remote", "add", "origin", bareDir], { cwd: repoDir });

      const worktreeDir = join(f.baseDir, "wt");
      const client = stubClient(repoDir, worktreeDir);
      const deps = makeDeps(client, {
        runGh: async (args, cwd) => {
          expect(cwd).toBe(worktreeDir);
          expect(args.join(" ")).toContain("pr create --draft");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      const handle = await prepareTarget(
        { targetPath: repoDir, branch: "agent/t6-approve", base: "HEAD", isolated: true },
        deps,
      );

      // Agent makes a change in the worktree.
      writeFileSync(join(worktreeDir, "agent-change.txt"), "change");
      // Verify in the worktree passes.
      const verify = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktreeDir });
      expect(verify.stdout.toString()).toContain("agent-change.txt");

      await finalizeTarget(handle, { approved: true }, deps);

      // The worktree is discarded after APPROVE.
      expect(existsSync(worktreeDir)).toBe(false);
      // The branch exists in the repo (committed, pushed) — NOT deleted.
      const branches = Bun.spawnSync(["git", "branch", "--list", "agent/t6-approve"], { cwd: repoDir });
      expect(branches.stdout.toString()).toContain("agent/t6-approve");
      // The pushed branch exists in the remote.
      const remoteBranches = Bun.spawnSync(["git", "branch", "--list"], { cwd: bareDir });
      expect(remoteBranches.stdout.toString()).toContain("agent/t6-approve");
    } finally {
      f.cleanup();
    }
  });

  test("REJECT discards the worktree and deletes the branch", async () => {
    const f = setupFixture();
    try {
      const repoDir = createTempRepo(f.baseDir);
      const worktreeDir = join(f.baseDir, "wt");
      const client = stubClient(repoDir, worktreeDir);
      const deps = makeDeps(client);

      const handle = await prepareTarget(
        { targetPath: repoDir, branch: "agent/t6-reject", base: "HEAD", isolated: true },
        deps,
      );

      // Agent leaves a dirty worktree (uncommitted change).
      writeFileSync(join(worktreeDir, "agent-change.txt"), "change");

      await finalizeTarget(handle, { approved: false }, deps);

      expect(existsSync(worktreeDir)).toBe(false);
      const branches = Bun.spawnSync(["git", "branch", "--list", "agent/t6-reject"], { cwd: repoDir });
      expect(branches.stdout.toString()).toBe("");
    } finally {
      f.cleanup();
    }
  });

  test("backup handle finalize is a no-op", async () => {
    const f = setupFixture();
    try {
      const target = join(f.baseDir, "target.txt");
      writeFileSync(target, "original");
      const client = stubClient(f.baseDir, join(f.baseDir, "wt"));
      const deps = makeDeps(client);
      const handle = await prepareTarget(
        { targetPath: target, branch: "agent/x", isolated: true },
        deps,
      );
      await expect(finalizeTarget(handle, { approved: false }, deps)).resolves.toBeUndefined();
      // The .bak survives for the human.
      expect(existsSync(`${target}.bak`)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});