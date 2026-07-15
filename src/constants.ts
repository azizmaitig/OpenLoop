import { resolve } from 'node:path';

/**
 * Canonical output directory for loop runtime state (STATE.md, checkpoints,
 * evidence). Every module that writes/reads loop state must import this so a
 * path change happens in exactly one place. Resolved against cwd at load time,
 * matching the daemon's `resolve(process.cwd(), ...)` convention.
 */
export const OUTPUT_DIR = resolve('_agent-loop-output');

/** Project version — single source of truth, must match package.json. */
export const VERSION = '8.0.0';
