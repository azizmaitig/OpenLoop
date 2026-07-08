#!/usr/bin/env bun
/**
 * state-writer.ts — state persistence helpers extracted from loop.ts.
 *
 * Provides writeBothStates (STATE.md + state.json), writeJsonState, and
 * a mutable currentState ref shared by the entry-point crash handlers.
 */

import { resolve } from 'node:path';
import { writeState } from './state.js';
import type { LoopState } from './types.js';

// ponytail: hardcoded path, make configurable when multi-project support needed
const OUTPUT_DIR = resolve('_agent-loop-output');

async function writeJsonState(filePath: string, state: LoopState): Promise<void> {
  await Bun.write(filePath, JSON.stringify(state, null, 2) + '\n');
}

async function writeBothStates(state: LoopState): Promise<void> {
  await Promise.all([
    writeState(resolve(OUTPUT_DIR, 'STATE.md'), state),
    writeJsonState(resolve(OUTPUT_DIR, 'state.json'), state),
  ]);
}

/**
 * Mutable ref to the current loop state, set by runLoop/runDaemon and
 * read by the crash / SIGINT handlers in loop.ts.  Using an object
 * wrapper so the ref can be assigned from another module.
 */
const currentState: { value: LoopState | null } = { value: null };

export { OUTPUT_DIR, writeJsonState, writeBothStates, currentState };
