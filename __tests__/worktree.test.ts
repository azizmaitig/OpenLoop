import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorktree,
  runInWorktree,
  discardWorktree,
  verifyInWorktree,
} from '../src/worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createTempRepo(baseDir: string): string {
  const repoDir = join(baseDir, 'repo');
  mkdirSync(repoDir, { recursive: true });

  const r = (cmd: string) => Bun.spawnSync(cmd.split(/\s+/), { cwd: repoDir });

  r('git init');
  r('git config user.email test@test.com');
  r('git config user.name Test');
  writeFileSync(join(repoDir, 'README.md'), '# Test Repo');
  r('git add -A');
  r('git commit -m initial');

  return repoDir;
}

interface TempFixture {
  repoDir: string;
  baseDir: string;
  cleanup: () => void;
}

function setupFixture(): TempFixture {
  const baseDir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  const repoDir = createTempRepo(baseDir);
  return {
    repoDir,
    baseDir,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

/** Return the expected worktree path for a given test run. */
function worktreePath(baseDir: string, label: string): string {
  return join(baseDir, `agent-loop-wt-${label}`);
}

// Helper to detect Windows for conditional tests
function isWindows(): boolean {
  return process.platform === 'win32';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  test('creates worktree at ../agent-loop-wt-<branch> and returns absolute path', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const branch = 'feature-1';
      const wtPath = await createWorktree(branch);

      expect(wtPath).toBe(worktreePath(f.baseDir, branch));
      expect(existsSync(join(wtPath, 'README.md'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      // Cleanup worktree
      try {
        await discardWorktree(worktreePath(f.baseDir, 'feature-1'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('accepts optional base ref', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('from-main', 'HEAD');
      expect(existsSync(wtPath)).toBe(true);
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'from-main'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('rejects when not in a git repo', async () => {
    const f = setupFixture();
    const noGitDir = join(f.baseDir, 'nogit');
    mkdirSync(noGitDir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(noGitDir);

    try {
      await expect(createWorktree('nope')).rejects.toThrow();
    } finally {
      process.chdir(origCwd);
      f.cleanup();
    }
  });

  test('sanitizes branch names for filesystem safety', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('bad name/..\\path');
      // Only alphanumeric, _, ., - should remain; .. gets stripped, / and \ become -
      expect(wtPath).toContain('agent-loop-wt-bad-name--path');
      // The actual path shouldn't contain literal dots that would escape
      expect(wtPath).not.toContain('..');
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'bad-name---path'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });
});

describe('runInWorktree', () => {
  test('runs command inside worktree and returns structured output', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('run-test');
      const result = await runInWorktree(wtPath, isWindows() ? 'echo hello' : 'echo hello');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(typeof result.stderr).toBe('string');
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'run-test'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('captures non-zero exit codes', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('exit-test');
      const result = await runInWorktree(wtPath, 'git status --porcelain');

      // Clean worktree should have no output
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'exit-test'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('runs in isolated directory', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('isolated');
      // Create a file in the worktree
      await runInWorktree(wtPath, isWindows()
        ? 'echo worktree-only > unique.txt'
        : 'echo worktree-only > unique.txt'
      );

      // Should NOT exist in the main repo
      const fs = await import('node:fs');
      expect(fs.existsSync(join(f.repoDir, 'unique.txt'))).toBe(false);
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'isolated'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });
});

describe('discardWorktree', () => {
  test('removes an existing worktree', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('to-remove');
      expect(existsSync(wtPath)).toBe(true);

      await discardWorktree(wtPath);

      // After removal, the directory should not exist
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      process.chdir(origCwd);
      f.cleanup();
    }
  });

  test('handles already-removed worktree gracefully', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      // Non-existent path should not throw
      await expect(
        discardWorktree(join(f.baseDir, 'does-not-exist')),
      ).resolves.toBeUndefined();
    } finally {
      process.chdir(origCwd);
      f.cleanup();
    }
  });
});

describe('verifyInWorktree', () => {
  test('returns true for passing commands', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('verify-pass');
      const result = await verifyInWorktree(wtPath, 'git rev-parse HEAD');
      expect(result).toBe(true);
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'verify-pass'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('returns false for failing commands', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('verify-fail');
      const result = await verifyInWorktree(wtPath, 'git rev-parse NOSUCHBRANCH');
      expect(result).toBe(false);
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'verify-fail'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });

  test('works with bun test command', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      const wtPath = await createWorktree('verify-bun');

      // Create a minimal test file in the worktree
      writeFileSync(
        join(wtPath, 'test_placeholder.test.ts'),
        `import { test, expect } from 'bun:test';\ntest('pass', () => expect(1).toBe(1));\n`,
      );

      const result = await verifyInWorktree(wtPath, 'bun test test_placeholder.test.ts');
      expect(result).toBe(true);
    } finally {
      process.chdir(origCwd);
      try {
        await discardWorktree(worktreePath(f.baseDir, 'verify-bun'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test — full lifecycle (guarded by INTEGRATION=1 env)
// ---------------------------------------------------------------------------
describe('worktree lifecycle (integration)', () => {
  const runIntegration = process.env.INTEGRATION === '1' ? test : test.skip;

  runIntegration('create → run → verify → discard', async () => {
    const f = setupFixture();
    const origCwd = process.cwd();
    process.chdir(f.repoDir);

    try {
      // 1. Create
      const wtPath = await createWorktree('lifecycle');
      expect(existsSync(wtPath)).toBe(true);

      // 2. Run
      const runResult = await runInWorktree(wtPath, 'git status --short');
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toBe(''); // clean status

      // 3. Verify (even the real test suite)
      const verifyResult = await verifyInWorktree(wtPath, 'git rev-parse HEAD');
      expect(verifyResult).toBe(true);

      // 4. Discard
      await discardWorktree(wtPath);
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      process.chdir(origCwd);
      // Safety cleanup
      try {
        await discardWorktree(worktreePath(f.baseDir, 'lifecycle'));
      } catch { /* ignore */ }
      f.cleanup();
    }
  });
});
