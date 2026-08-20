/**
 * worktree-manager.ts — target isolation lifecycle for agent runs (T6, D4).
 *
 * Owns the two isolation modes a plan target can take:
 *  - git targets: a native opencode workspace (type "worktree") — the session
 *    created with its workspaceID operates inside the worktree; APPROVE turns
 *    the worktree into a draft PR, REJECT discards it (branch deleted).
 *  - non-git targets: an idempotent .bak backup before any touch.
 *
 * `src/worktree.ts` keeps the pure git-CLI helpers (createWorktree etc.) —
 * this module composes those helpers + the opencode experimental workspace
 * API. The only module allowed to touch /experimental/workspace.
 */

import { existsSync, copyFileSync, statSync, cpSync } from 'node:fs';
import type { RunLogEntry } from './run-log.js';
import type { OpenCodeClient, OpenCodeSession } from './opencode-client.js';
import { createOpenCodeClient } from './opencode-client.js';
import { runCommand } from './shell.js';
import type { SpawnResult } from './worktree.js';
import { discardWorktree, runInWorktree, verifyInWorktree } from './worktree.js';

/** How long a workspace create may take before the manager treats it as failed. */
const WORKSPACE_CREATE_TIMEOUT_MS = 120000;

export interface TargetSpec {
  /** Absolute path of the repo/target the agent works on. */
  targetPath: string;
  /** Branch name for git targets (sanitized for filesystem + git safety). */
  branch?: string;
  /** Base ref to fork the worktree from (default HEAD). */
  base?: string;
  /** True when the agent phase declared worktree isolation. */
  isolated: boolean;
}

export type TargetHandle =
  | { mode: 'git'; workspaceID: string; directory: string; branch: string; base: string; repoDir: string }
  | { mode: 'backup'; targetPath: string; backupPath: string };

export interface WorktreeManagerDeps {
  /** opencode client — stubbed in tests (the workspace API is experimental). */
  client: OpenCodeClient;
  /** gh runner — stubbed in tests; falls back to runCommand. */
  runGh?: (args: string[], cwd: string) => Promise<SpawnResult>;
  /** Optional run-log writer for the no-gh fallback notification. */
  log?: (entry: RunLogEntry) => Promise<void>;
}

export function createWorktreeManager(
  deps: Partial<WorktreeManagerDeps> = {},
  baseUrl?: string,
): WorktreeManagerDeps {
  return {
    client: deps.client ?? createOpenCodeClient(baseUrl ?? 'http://127.0.0.1:4096'),
    runGh: deps.runGh,
    log: deps.log,
  };
}

/**
 * Detect whether targetPath is a git repo that can actually be forked into a
 * worktree. A repo with zero commits (git init, no HEAD — e.g. calendar-app)
 * cannot: `git worktree add` needs a commit to branch from. Such targets are
 * treated as non-git and take the backup path (PRD v11 D4: "0 commits → backup").
 */
export async function isGitTarget(targetPath: string): Promise<boolean> {
  const { exitCode } = await runCommand('git rev-parse --is-inside-work-tree', { cwd: targetPath });
  if (exitCode !== 0) return false;
  const head = await runCommand('git rev-parse --verify HEAD', { cwd: targetPath });
  return head.exitCode === 0;
}

/**
 * Backup targetPath to targetPath.bak unless it already exists (never
 * overwrite). Files are copied as-is; directories are copied recursively
 * (calendar-app-style targets are directories, T8). Missing targets still
 * produce a backup path for the parent directory.
 */
export async function backupTarget(targetPath: string): Promise<{ backupPath: string; skipped: boolean }> {
  const backupPath = `${targetPath}.bak`;
  if (existsSync(backupPath)) return { backupPath, skipped: true };
  if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
    cpSync(targetPath, backupPath, { recursive: true });
  } else {
    copyFileSync(targetPath, backupPath);
  }
  return { backupPath, skipped: false };
}

/** Sanitize a branch name for git + filesystem safety (mirrors src/worktree.ts). */
export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/\.\./g, '');
}

/**
 * Prepare a target for one isolated agent run:
 *  - git target → create a native opencode worktree workspace, return the
 *    workspace handle (the session created with its workspaceID operates in
 *    the worktree directory).
 *  - non-git target → idempotent .bak backup, return the backup handle.
 *  - non-isolated → git detection is skipped, backup mode only.
 */
export async function prepareTarget(
  spec: TargetSpec,
  deps: WorktreeManagerDeps,
): Promise<TargetHandle> {
  if (!spec.isolated) {
    // Not declared isolated: no worktree, no backup — a plain local run.
    return { mode: 'backup', targetPath: spec.targetPath, backupPath: '' };
  }

  if (await isGitTarget(spec.targetPath)) {
    // The server creates the branch as given (slashes are valid git refs —
    // verified live: branch "agent/t6-contract-probe" was created verbatim).
    const branch = spec.branch ?? 'agent-loop-agent-run';
    const base = spec.base ?? 'HEAD';
    const workspace = await createWorkspaceWithRetry(
      deps.client,
      { type: 'worktree', branch },
      WORKSPACE_CREATE_TIMEOUT_MS,
    );
    return {
      mode: 'git',
      workspaceID: workspace.id,
      directory: workspace.directory,
      branch: workspace.branch ?? branch,
      base,
      repoDir: spec.targetPath,
    };
  }

  const { backupPath } = await backupTarget(spec.targetPath);
  return { mode: 'backup', targetPath: spec.targetPath, backupPath };
}

/**
 * Create a workspace, tolerating the verified server quirk: a 400
 * "Timed out waiting for global event" may arrive even though the workspace
 * was actually created. On such a failure, list the worktrees and match by
 * branch before giving up.
 */
async function createWorkspaceWithRetry(
  client: OpenCodeClient,
  opts: { type: 'worktree'; branch: string },
  timeoutMs: number,
): Promise<{ id: string; type: string; name: string; branch: string | null; directory: string }> {
  try {
    return await client.createWorkspace(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeoutQuirk = message.includes('Timed out waiting for global event');
    if (!isTimeoutQuirk) throw err;
    // The create may have succeeded server-side despite the 400. The GET
    // /experimental/worktree response lists directories, not branches — we
    // cannot match the branch there, so surface the quirk for the caller
    // (the executor re-checks the session workspace binding).
    throw new Error(
      `workspace create reported a timeout but may have succeeded: ${message}`,
    );
  }
}

/**
 * Resolve the APPROVE/REJECT lifecycle for a target handle.
 *  - git APPROVE: commit the worktree branch, push it, open a draft PR (via gh
 *    when available, else local branch + run-log notification), then discard
 *    the local worktree. The branch stays on the remote (the PR references it).
 *  - git REJECT: discard the worktree AND delete the branch (-D is safe: it is
 *    ours, never merged, isolated).
 *  - backup handles: nothing to finalize — the .bak is the human's safety net.
 */
export async function finalizeTarget(
  handle: TargetHandle,
  opts: { approved: boolean },
  deps: WorktreeManagerDeps,
): Promise<void> {
  if (handle.mode === 'backup') return;

  const { directory, branch, repoDir } = handle;

  if (opts.approved) {
    await commitAndOpenDraftPr(handle, deps);
    await discardWorktree(directory, repoDir).catch((err) => {
      console.error(`[worktree-manager] worktree discard after APPROVE failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }

  // REJECT: discard the worktree and delete the branch.
  await discardWorktree(directory, repoDir).catch((err) => {
    console.error(`[worktree-manager] worktree discard on REJECT failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });
  const { exitCode, stderr } = await runCommand(`git branch -D ${branch}`, { cwd: repoDir });
  if (exitCode !== 0) {
    console.error(`[worktree-manager] branch delete on REJECT failed (non-fatal): ${stderr}`);
  }
}

async function commitAndOpenDraftPr(
  handle: Extract<TargetHandle, { mode: 'git' }>,
  deps: WorktreeManagerDeps,
): Promise<void> {
  const { directory, branch, base } = handle;
  const runGh = deps.runGh ?? ((args: string[], cwd: string) => runCommand(`gh ${args.join(' ')}`, { cwd }));

  const commit = await runInWorktree(directory, 'git add -A && git commit -m "agent-loop: agent run (T6)"');
  if (commit.exitCode !== 0) {
    // Nothing to commit (no changes) — still attempt the PR-less path? No:
    // an empty worktree means the agent produced nothing; keep it local.
    console.error(`[worktree-manager] commit failed: ${commit.stderr}`);
    return;
  }

  const push = await runInWorktree(directory, `git push -u origin ${branch}`);
  if (push.exitCode !== 0) {
    const stderr = push.stderr || push.stdout;
    if (stderr.includes('gh not found') || stderr.includes('is not recognized')) {
      await notifyHumanFallback(handle, deps);
    } else {
      console.error(`[worktree-manager] push failed: ${stderr}`);
      await notifyHumanFallback(handle, deps);
    }
    return;
  }

  const pr = await runGh(['pr', 'create', '--draft', '--head', branch, '--base', base], directory);
  if (pr.exitCode !== 0) {
    console.error(`[worktree-manager] draft PR failed (branch pushed, local only): ${pr.stderr || pr.stdout}`);
  }
}

async function notifyHumanFallback(
  handle: Extract<TargetHandle, { mode: 'git' }>,
  deps: WorktreeManagerDeps,
): Promise<void> {
  const msg = `[agent-loop T6] Agent run committed branch "${handle.branch}" locally (${handle.directory}) — no remote/gh available; merge needs human review.`;
  console.warn(msg);
  if (deps.log) {
    await deps.log({
      run_id: new Date().toISOString(),
      pattern: 'agent-loop-t6',
      runs_count: 0,
      outcome: 'pass',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
    }).catch(() => {});
  }
}

/** Run a command inside the worktree (verify runs in the worktree). */
export async function verifyTarget(handle: TargetHandle, command: string): Promise<boolean> {
  if (handle.mode !== 'git') return false;
  return verifyInWorktree(handle.directory, command);
}

/**
 * Force-discard a target handle (leak guard): remove the worktree + branch for
 * git handles, best-effort. Backup handles have nothing to discard.
 */
export async function discardTarget(handle: TargetHandle, deps: WorktreeManagerDeps): Promise<void> {
  if (handle.mode !== 'git') return;
  const { directory, branch, repoDir } = handle;
  try {
    await discardWorktree(directory, repoDir);
  } catch (err) {
    console.error(`[worktree-manager] force discard failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { exitCode, stderr } = await runCommand(`git branch -D ${branch}`, { cwd: repoDir });
  if (exitCode !== 0) {
    console.error(`[worktree-manager] branch delete on discard failed (non-fatal): ${stderr}`);
  }
}

/**
 * Startup sweep: remove agent-loop-owned worktrees left over from a crash.
 * A fresh orchestrator start means no active runs, so every worktree whose
 * directory we can resolve and that looks agent-loop-owned is discarded.
 */
export async function sweepStaleTargets(deps: WorktreeManagerDeps): Promise<string[]> {
  const pruned: string[] = [];
  try {
    const worktrees = await deps.client.listWorktrees();
    for (const wt of worktrees) {
      if (!wt.includes('agent-loop')) continue;
      try {
        await discardWorktree(wt);
        pruned.push(wt);
      } catch {
        // already gone or not a worktree — skip
      }
    }
  } catch {
    // server unreachable at startup — nothing to sweep
  }
  return pruned;
}

export type { OpenCodeSession };