import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readAllStateFiles,
  checkCollision,
  claimTarget,
} from '../src/collision.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'agent-loop-collision-'));
}

/** Write a state file with the given frontmatter fields merged. */
async function writeStateFile(
  dir: string,
  filename: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const lines = ['---', 'version: 1', 'currentState: init', 'iteration: 0'];
  if (extra.acting_on !== undefined) {
    lines.push(`acting_on: "${extra.acting_on}"`);
  }
  lines.push('---');
  await writeFile(join(dir, filename), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// readAllStateFiles
// ---------------------------------------------------------------------------

describe('readAllStateFiles', () => {
  test('returns empty object when dir has no state files', async () => {
    const dir = await tempDir();
    const result = await readAllStateFiles(dir);
    expect(result).toEqual({});
    await rm(dir, { recursive: true, force: true });
  });

  test('parses a single state file with acting_on', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', { acting_on: 'PR #42' });

    const result = await readAllStateFiles(dir);
    expect(Object.keys(result).length).toBe(1);
    expect(result['ci-sweeper-state.md'].acting_on).toBe('PR #42');
    expect(result['ci-sweeper-state.md'].version).toBe(1);
    expect(result['ci-sweeper-state.md'].currentState).toBe('init');

    await rm(dir, { recursive: true, force: true });
  });

  test('parses multiple state files', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', { acting_on: 'PR #1' });
    await writeStateFile(dir, 'pr-babysitter-state.md', { acting_on: 'PR #2' });
    await writeStateFile(dir, 'daily-triage-state.md', {});

    const result = await readAllStateFiles(dir);
    expect(Object.keys(result).length).toBe(3);
    expect(result['ci-sweeper-state.md'].acting_on).toBe('PR #1');
    expect(result['pr-babysitter-state.md'].acting_on).toBe('PR #2');
    // File with no acting_on should still be present
    expect(result['daily-triage-state.md'].acting_on).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test('skips files without valid frontmatter', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'broken-state.md'), 'not yaml\nat all');
    await writeFile(
      join(dir, 'good-state.md'),
      '---\ncurrentState: run\niteration: 1\n---\n',
    );

    const result = await readAllStateFiles(dir);
    expect(Object.keys(result).length).toBe(1);
    expect(result['good-state.md']).toBeDefined();
    expect(result['broken-state.md']).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test('handles missing directory gracefully', async () => {
    const result = await readAllStateFiles('/tmp/nonexistent-collision-dir-12345');
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// checkCollision
// ---------------------------------------------------------------------------

describe('checkCollision', () => {
  test('returns proceed when no state files exist', async () => {
    const dir = await tempDir();
    const result = await checkCollision(dir, 'PR Babysitter', 'PR #42');
    expect(result).toBe('proceed');
    await rm(dir, { recursive: true, force: true });
  });

  test('returns proceed when no one has claimed the target', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', {});

    const result = await checkCollision(dir, 'Daily Triage', 'PR #42');
    expect(result).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });

  test('returns skip when higher-priority pattern holds the target', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', { acting_on: 'PR #42' });

    const result = await checkCollision(dir, 'Daily Triage', 'PR #42');
    expect(result).toBe('skip');

    await rm(dir, { recursive: true, force: true });
  });

  test('returns proceed when same pattern holds the target (self-claim)', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'pr-babysitter-state.md', { acting_on: 'PR #42' });

    const result = await checkCollision(dir, 'PR Babysitter', 'PR #42');
    expect(result).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });

  test('returns proceed when lower-priority pattern holds the target', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'daily-triage-state.md', { acting_on: 'PR #42' });

    // CI Sweeper is higher priority than Daily Triage — should proceed
    const result = await checkCollision(dir, 'CI Sweeper', 'PR #42');
    expect(result).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });

  test('ignores claims on a different target', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', { acting_on: 'PR #1' });

    const result = await checkCollision(dir, 'Daily Triage', 'PR #42');
    expect(result).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// claimTarget
// ---------------------------------------------------------------------------

describe('claimTarget', () => {
  test('sets acting_on in the state file', async () => {
    const dir = await tempDir();
    const filepath = 'pr-babysitter-state.md';
    const content = '---\nversion: 1\ncurrentState: init\niteration: 0\n---\n';
    await writeFile(join(dir, filepath), content);

    await claimTarget(dir, filepath, 'PR #42');

    const raw = await readFile(join(dir, filepath), 'utf-8');
    expect(raw).toMatch(/acting_on:\s*['"]?PR #42['"]?/);
    expect(raw).toContain('version: 1');
    expect(raw).toContain('currentState: init');

    await rm(dir, { recursive: true, force: true });
  });

  test('null target clears acting_on from the state file', async () => {
    const dir = await tempDir();
    const filepath = 'ci-sweeper-state.md';
    const content =
      '---\nversion: 1\ncurrentState: run\niteration: 3\nacting_on: "PR #99"\n---\n';
    await writeFile(join(dir, filepath), content);

    await claimTarget(dir, filepath, null);

    const raw = await readFile(join(dir, filepath), 'utf-8');
    expect(raw).not.toContain('acting_on');
    expect(raw).toContain('version: 1');
    expect(raw).toContain('currentState: run');

    await rm(dir, { recursive: true, force: true });
  });

  test('no-op when file does not exist', async () => {
    const dir = await tempDir();
    // Should not throw
    await expect(
      claimTarget(dir, 'nonexistent-state.md', 'PR #42'),
    ).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  test('no-op when file lacks frontmatter', async () => {
    const dir = await tempDir();
    const filepath = 'no-fm-state.md';
    await writeFile(join(dir, filepath), 'just plain text');

    await expect(
      claimTarget(dir, filepath, 'PR #42'),
    ).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Integration: claim then check
// ---------------------------------------------------------------------------

describe('claimTarget + checkCollision integration', () => {
  test('after claiming, own pattern sees proceed, lower sees skip', async () => {
    const dir = await tempDir();
    await writeStateFile(dir, 'ci-sweeper-state.md', { acting_on: 'PR #1' });

    // CI Sweeper (100) has claimed the target — Daily Triage (20) should skip
    expect(await checkCollision(dir, 'Daily Triage', 'PR #1')).toBe('skip');

    // CI Sweeper can self-claim
    expect(await checkCollision(dir, 'CI Sweeper', 'PR #1')).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });

  test('after releasing, all patterns see proceed', async () => {
    const dir = await tempDir();
    const filepath = 'pr-babysitter-state.md';
    await writeStateFile(dir, filepath, { acting_on: 'PR #42' });

    // Release
    await claimTarget(dir, filepath, null);

    // Now anyone can claim
    expect(await checkCollision(dir, 'Daily Triage', 'PR #42')).toBe('proceed');
    expect(await checkCollision(dir, 'PR Babysitter', 'PR #42')).toBe('proceed');

    await rm(dir, { recursive: true, force: true });
  });
});
