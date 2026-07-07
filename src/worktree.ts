import { resolve } from 'node:path';
import { platform } from 'node:os';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function isWindows(): boolean {
  return platform() === 'win32';
}

function buildArgs(command: string): string[] {
  return isWindows() ? ['cmd.exe', '/c', command] : ['/bin/sh', '-c', command];
}

async function exec(command: string, cwd?: string): Promise<SpawnResult> {
  const proc = Bun.spawn(buildArgs(command), {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });

  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
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
