/**
 * loop-context.ts — shared loop initialization helper.
 *
 * Extracted from the duplicated setup pattern in loop-runner.ts (runLoop)
 * and daemon.ts (runIntervalTick). Both callers assembled the same objects:
 *   new StateMachine() → createInitialState() → setCurrentState() → loadPlugins()
 *
 * One helper replaces two copy-paste sites. Returns the context object
 * that both the bounded run loop and the daemon tick consume.
 */

import { StateMachine } from './state-machine.js';
import { createInitialState, setCurrentState } from './state.js';
import { loadPlugins } from './plugins.js';
import type { LoopConfig, LoopState } from './types.js';
import type { Plugin } from './plugins.js';
import type { StateMachine as StateMachineType } from './state-machine.js';

export interface LoopContext {
  sm: StateMachineType;
  state: LoopState;
  plugins: Plugin[];
}

/**
 * Create the common loop context shared by runLoop (bounded) and runTick (daemon).
 * Sets up the StateMachine, initial LoopState, and loads plugins.
 *
 * Callers are responsible for checkpoint resume, plan-driven phase loading,
 * and writing the initial state file — those are not part of the shared context.
 */
export async function createLoopContext(config: LoopConfig): Promise<LoopContext> {
  const sm = new StateMachine();
  const state = createInitialState(config);
  setCurrentState(state);
  const plugins = await loadPlugins(config);
  return { sm, state, plugins };
}
