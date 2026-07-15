import type { LoopState, LoopConfig, PhaseResult } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { parseFrontmatter, dumpFrontmatter } from './yaml.js';

const STATE_VERSION = 1;

function serializeYamlFrontmatter(state: LoopState): string {
  return dumpFrontmatter({
    version: STATE_VERSION,
    currentState: state.currentState,
    iteration: state.iteration,
    startTime: state.startTime,
    phaseResults: state.phaseResults,
    errors: state.errors,
  });
}

function parseYamlFrontmatter(content: string): LoopState | null {
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  if (!parsed) return null;

  const currentState = parsed.currentState as LoopState['currentState'];
  const iteration = parsed.iteration as number;
  if (!currentState || typeof iteration !== 'number') return null;

  return {
    currentState,
    iteration,
    phaseResults: (parsed.phaseResults ?? {}) as Record<string, PhaseResult>,
    startTime: (parsed.startTime as string) ?? '',
    errors: (parsed.errors ?? []) as string[],
  };
}

export async function readState(path: string): Promise<LoopState | null> {
  let content: string;
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) return null;
    content = await file.text();
  } catch {
    return null;
  }

  // Try YAML frontmatter first (.md files)
  const fromYaml = parseYamlFrontmatter(content);
  if (fromYaml) return fromYaml;

  // Fallback: plain JSON
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.currentState === 'string' && typeof parsed.iteration === 'number') {
      return {
        currentState: parsed.currentState,
        iteration: parsed.iteration,
        phaseResults: parsed.phaseResults ?? {},
        startTime: parsed.startTime ?? '',
        errors: parsed.errors ?? [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeState(path: string, state: LoopState): Promise<void> {
  const content = serializeYamlFrontmatter(state);
  await Bun.write(path, content);
}

export function createInitialState(config: LoopConfig): LoopState {
  return {
    currentState: 'init',
    iteration: 0,
    phaseResults: {},
    startTime: new Date().toISOString(),
    errors: [],
  };
}

export function updatePhaseResult(
  state: LoopState,
  phaseName: string,
  result: PhaseResult,
): LoopState {
  return {
    ...state,
    phaseResults: {
      ...state.phaseResults,
      [phaseName]: result,
    },
  };
}

export interface StateMdFrontmatter {
  last_run: string;
  active_children: number;
  high_priority: number;
  watch_items: number;
  task_count: number;
  current_state: string;
  iteration: number;
  paused?: boolean;
}

export async function updateStateMd(
  path: string,
  fm: StateMdFrontmatter,
): Promise<void> {
  let body = '';
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8');
    const match = content.match(/^---[\s\S]*?---\n?(.*)$/s);
    body = match ? match[1] : content;
  }

  const frontmatter = dumpFrontmatter(fm as unknown as Record<string, unknown>);
  const output = body.trim()
    ? `${frontmatter}\n\n${body}`
    : frontmatter + '\n';

  await Bun.write(path, output);
}

export async function readPauseState(path: string): Promise<boolean> {
  try {
    const fm = parseFrontmatter<{ paused?: boolean }>(await Bun.file(path).text());
    return fm?.paused === true;
  } catch {
    return false;
  }
}

// ── JSON state persistence (folded from state-writer.ts) ─────────────────────

import { resolve } from 'node:path';
import { OUTPUT_DIR } from './constants.js';



// ── Current state ref (replaces object-wrapper pattern) ────────────────────

let _currentState: LoopState | null = null;

export function getCurrentState(): LoopState | null {
  return _currentState;
}

export function setCurrentState(state: LoopState | null): void {
  _currentState = state;
}

// ── JSON state persistence ──────────────────────────────────────────────────

export async function writeBothStates(state: LoopState): Promise<void> {
  try {
    await writeState(resolve(OUTPUT_DIR, 'STATE.md'), state);
  } catch (err) {
    console.error('[state] Failed to write STATE.md:', err);
  }
}

export { OUTPUT_DIR };
