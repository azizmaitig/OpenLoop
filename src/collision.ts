import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter, dumpFrontmatter } from './yaml.js';

/**
 * Static priority ranking. Higher number = higher priority.
 * CI Sweeper can claim any target; Daily Triage yields to all.
 */
const PRIORITY_TABLE: Record<string, number> = {
  'CI Sweeper': 100,
  'PR Babysitter': 80,
  'Dependency Sweeper': 60,
  'Post-Merge': 40,
  'Daily Triage': 20,
};

/** Known two-letter acronyms that should stay uppercase in pattern names. */
const ACRONYMS = new Set(['ci', 'pr']);

/**
 * Result of a collision check.
 * - `'skip'`: a higher-priority pattern already holds the target — do not act.
 * - `'proceed'`: no conflict — safe to act.
 */
export type CollisionResult = 'skip' | 'proceed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a friendly pattern name from a state filename.
 *
 * @example
 *   'ci-sweeper-state.md'  → 'CI Sweeper'
 *   'pr-babysitter-state.md' → 'PR Babysitter'
 */
function patternFromFilename(filename: string): string {
  const base = filename.replace(/-state\.md$/i, '');
  return base
    .split('-')
    .map((w) =>
      ACRONYMS.has(w.toLowerCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

/**
 * Look up the numeric priority for a loop/pattern name. Unknown names get 0.
 */
export function getPriority(name: string): number {
  return PRIORITY_TABLE[name] ?? 0;
}

/**
 * Compare two loop names by priority. Returns a sort-compatible value:
 *   negative  → a has higher priority than b
 *   zero      → equal priority
 *   positive  → b has higher priority than a
 */
export function comparePriority(a: string, b: string): number {
  return getPriority(b) - getPriority(a);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all `*-state.md` files in `baseDir` and return their parsed
 * YAML frontmatter keyed by filename.
 *
 * Files that don't exist, can't be read, or lack valid frontmatter are
 * silently skipped.
 */
export async function readAllStateFiles(
  baseDir: string,
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('-state.md')) continue;
    const fp = join(baseDir, entry);
    try {
      const content = await readFile(fp, 'utf-8');
      const parsed = parseFrontmatter(content);
      if (parsed) result[entry] = parsed;
    } catch {
      // skip unreadable / unparseable files
    }
  }

  return result;
}

/**
 * Check whether `target` is already claimed by a higher-priority pattern.
 *
 *   - No conflicting claim  → `'proceed'`
 *   - Same pattern (self-claim) → `'proceed'`
 *   - Higher-priority pattern holds it → `'skip'`
 */
export async function checkCollision(
  baseDir: string,
  patternName: string,
  target: string,
): Promise<CollisionResult> {
  const states = await readAllStateFiles(baseDir);
  const callerPriority = PRIORITY_TABLE[patternName] ?? 0;

  for (const [filename, state] of Object.entries(states)) {
    const actingOn = state.acting_on;
    if (!actingOn || actingOn !== target) continue;

    const otherPattern = patternFromFilename(filename);
    const otherPriority = PRIORITY_TABLE[otherPattern] ?? 0;

    // Self-claim is always allowed
    if (otherPattern === patternName) return 'proceed';
    // Higher priority blocks
    if (otherPriority > callerPriority) return 'skip';
  }

  return 'proceed';
}

/**
 * Claim (or release) a target for a pattern by setting the `acting_on`
 * field in the pattern's state file.
 *
 * When `target` is `null` the `acting_on` field is removed (release).
 *
 * If the file doesn't exist or lacks frontmatter the call is a no-op.
 */
export async function claimTarget(
  baseDir: string,
  stateFilePath: string,
  target: string | null,
): Promise<void> {
  const fullPath = join(baseDir, stateFilePath);

  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    return; // file missing / unreadable → no-op
  }

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return; // no frontmatter → no-op

  const body = content.slice(match[0].length);
  const parsed = parseFrontmatter(content)!; // match succeeded, so parse won't be null

  if (target === null) {
    delete parsed.acting_on;
  } else {
    parsed.acting_on = target;
  }

  const frontmatter = dumpFrontmatter(parsed);
  await writeFile(fullPath, frontmatter + body, 'utf-8');
}
