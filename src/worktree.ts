import { resolve } from 'node:path';
import { runCommand } from './shell.js';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Thin wrapper — delegates to runCommand and maps to SpawnResult shape. */
async function exec(command: string, cwd?: string): Promise<SpawnResult> {
  const result = await runCommand(command, { cwd });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/**
 * Create a git worktree at `../agent-loop-wt-<branch>` relative to cwd.
 *
 * @param branch - short branch name (sanitized for filesystem safety)
 * @param base   - branch/tag/commit to fork from (defaults to HEAD)
 * @returns absolute path to the created worktree
 */
export async function createWorktree(branch: string, base?: string): Promise<string> {
  const sanitized = branch.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/\.\./g, '');
  const worktreeDir = `../agent-loop-wt-${sanitized}`;
  const baseRef = base ?? 'HEAD';

  const { stderr, exitCode } = await exec(`git worktree add ${worktreeDir} ${baseRef}`);

  if (exitCode !== 0) {
    throw new Error(`createWorktree: ${stderr || `git exited ${exitCode}`}`);
  }

  return resolve(process.cwd(), worktreeDir);
}

/**
 * Run a command inside a git worktree directory.
 */
export async function runInWorktree(
  worktreePath: string,
  command: string,
): Promise<SpawnResult> {
  return exec(command, worktreePath);
}

/**
 * Remove a git worktree.
 *
 * Gracefully handles already-removed or non-existent paths.
 * Uses --force if the worktree has uncommitted changes.
 */
export async function discardWorktree(worktreePath: string): Promise<void> {
  const { stderr, exitCode } = await exec(`git worktree remove ${worktreePath}`);

  if (exitCode === 0) return;

  // Graceful: already removed or not a worktree
  if (
    stderr.includes('does not exist') ||
    stderr.includes('is not a working tree') ||
    stderr.includes('No such file')
  ) {
    return;
  }

  // Dirty worktree — force-remove
  if (stderr.includes('is dirty') || stderr.includes('contains modified')) {
    const { exitCode: forceExit, stderr: forceStderr } = await exec(
      `git worktree remove --force ${worktreePath}`,
    );
    if (forceExit !== 0) {
      throw new Error(`discardWorktree (force): ${forceStderr}`);
    }
    return;
  }

  throw new Error(`discardWorktree: ${stderr}`);
}

/**
 * Run a test command inside a worktree and return pass/fail.
 */
export async function verifyInWorktree(
  worktreePath: string,
  testCommand: string,
): Promise<boolean> {
  const { exitCode } = await exec(testCommand, worktreePath);
  return exitCode === 0;
}

/**
 * Prune stale git worktrees when the count exceeds maxWorktrees.
 *
 * Lists all worktrees via `git worktree list`, removes the oldest
 * non-HEAD worktrees until count <= maxWorktrees, then runs
 * `git worktree prune` to clean up stale admin entries.
 *
 * @returns paths of pruned worktrees and count of remaining ones.
 */
export async function pruneStaleWorktrees(maxWorktrees: number = 5): Promise<{ pruned: string[]; remaining: number }> {
  const { stdout } = await exec('git worktree list');
  const lines = stdout.split('\n').filter(Boolean);

  // Skip the first line (main working tree); subsequent lines are worktrees
  const worktrees = lines.slice(1).map(line => line.split(/\s+/)[0]).filter(Boolean);

  if (worktrees.length <= maxWorktrees) {
    return { pruned: [], remaining: worktrees.length };
  }

  const toRemove = worktrees.length - maxWorktrees;
  const pruned: string[] = [];

  for (let i = 0; i < toRemove && i < worktrees.length; i++) {
    try {
      await discardWorktree(worktrees[i]);
      pruned.push(worktrees[i]);
    } catch {
      // skip worktrees that can't be removed
    }
  }

  // Clean up stale administrative entries
  await exec('git worktree prune');

  return { pruned, remaining: worktrees.length - pruned.length };
}
