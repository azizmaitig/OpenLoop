#!/usr/bin/env bun
/**
 * daemon-runner.ts — daemon mode loop iteration extracted from loop.ts.
 *
 * Contains runDaemon() which runs loop iterations on an interval,
 * handling SIGINT/SIGTERM for graceful shutdown.
 */

import { resolve } from 'node:path';

import { StateMachine } from './state-machine.js';
import { createInitialState } from './state.js';
import { loadPlugins } from './plugins.js';
import { startApiServer } from './api.js';
import type { ApiHandlers } from './api.js';
import { executePhaseGroup } from './execute-phases.js';
import { writeBothStates, currentState } from './state-writer.js';
import type { LoopConfig } from './types.js';

/**
 * Run the loop in daemon mode — repeated iterations on an interval.
 *
 * Uses setInterval with config.daemon.intervalMs.
 * On each tick, runs all phases and transitions state.
 * State resets between iterations (phase results cleared).
 * Handles SIGINT/SIGTERM for graceful shutdown (no process.exit(1)).
 */
async function runDaemon(config: LoopConfig): Promise<void> {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  const sm = new StateMachine();
  let state = createInitialState(config);
  currentState.value = state;

  const intervalMs = config.daemon?.intervalMs ?? 60000;

  await writeBothStates(state);

  // Load plugins once (v2: no plugins → same daemon behavior)
  const plugins = await loadPlugins(config);

  // Start API server if configured
  if (config.daemon?.port) {
    const apiHandlers: ApiHandlers = {
      getState: () => state,
      startLoop: async () => { running = true; },
      stopLoop: async () => { running = false; },
      triggerIteration: async () => { await tick(); },
    };
    startApiServer(config.daemon.port, apiHandlers);
    console.log(`API server listening on port ${config.daemon.port}`);
  }

  console.log(`Daemon started (interval: ${intervalMs}ms)`);

  let running = true;
  const shutdown = () => {
    if (!running) return;
    running = false;
    state.currentState = 'done';
    writeBothStates(state).catch(() => {});
    console.log('Daemon stopped gracefully');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let iterationCount = 0;

  async function tick(): Promise<void> {
    if (!running) return;

    iterationCount++;
    state.iteration = iterationCount;
    state.currentState = 'init';
    state.phaseResults = {};
    state.errors = [];

    sm.transition('RUN');
    state.currentState = 'run';
    await writeBothStates(state);

    // ponytail: daemon ignores iteration count, always shows ∞
    const fakeConfig = { ...config, maxIterations: Infinity };
    const phaseResult = await executePhaseGroup(
      { config: fakeConfig, plugins, writeState: writeBothStates, onPhaseFailed: () => {}, logPath: resolve('loop-run-log.md') },
      state,
      state.iteration,
    );
    state = phaseResult.state;

    sm.transition('VERIFY');
    state.currentState = 'verify';
    await writeBothStates(state);

    // ponytail: always loop back — daemon ignores pass/fail, runs until SIGINT
    sm.transition('LOOP');
    state.currentState = 'init';
    state.phaseResults = {};
    await writeBothStates(state);

    console.log(`Daemon iteration ${iterationCount} complete`);
  }

  await tick();
  const intervalId = setInterval(tick, intervalMs);
  // ponytail: unref keeps process alive via the promise below, not the timer
  intervalId.unref();

  await new Promise<void>(() => {});
}

export { runDaemon };
