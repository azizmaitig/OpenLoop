/**
 * daemon-tick.ts — standalone daemon tick extracted from daemon.ts.
 *
 * The tick is a perpetual loop (run until SIGINT) that executes all phases
 * on a configurable interval. It uses the same runLoopBody that the bounded
 * run loop uses, but with an always-LOOP decideEvent policy (daemon ignores
 * pass/fail, runs until interrupted).
 *
 * Previously a method on the Daemon class (Daemon.runIntervalTick), it had
 * no coupling to the HTTP/WS server, queue processing, or any other Daemon
 * responsibility. Extracting it as a standalone function makes it testable
 * without instantiating a full Daemon, and eliminates the daemon.ts setup
 * pattern that was copy-pasted from loop-runner.ts.
 *
 * Signal handling: saves existing SIGINT/SIGTERM listeners, installs its
 * own shutdown handler (applyTransition ABORT + writeBothStates), and
 * runs until the process is interrupted.
 */

import { resolve } from 'node:path';
import { applyTransition } from './transition.js';
import { writeBothStates } from './state.js';
import { runLoopBody } from './loop-core.js';
import { createLoopContext } from './loop-context.js';
import type { LoopConfig } from './types.js';

/**
 * Run the daemon tick loop on the given config.
 * Creates StateMachine, state, and plugins via createLoopContext, then
 * runs runLoopBody in a setInterval at config.daemon.intervalMs (default 60s).
 * Always loops (decideEvent = () => 'LOOP') — the daemon never self-terminates.
 * Installs SIGINT/SIGTERM handlers that applyTransition ABORT on signal.
 */
export async function runTick(config: LoopConfig, broadcast?: (type: string, data: unknown) => void): Promise<void> {
  const { sm, state: initialState, plugins } = await createLoopContext(config);
  let state = initialState;

  const intervalMs = config.daemon?.intervalMs ?? 60000;

  await writeBothStates(state);

  console.log(`Daemon tick started (interval: ${intervalMs}ms)`);

  let iterationCount = 0;
  let running = true;

  const shutdown = () => {
    if (!running) return;
    running = false;
    state = applyTransition('ABORT', state, sm);
    writeBothStates(state).catch(() => {});
  };

  // Save and install signal handlers
  const prevSigInt = process.listeners('SIGINT').slice();
  const prevSigTerm = process.listeners('SIGTERM').slice();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Shared per-iteration body. Daemon policy: always LOOP (ignores pass/fail,
  // runs until SIGINT); iteration count shown as ∞.
  let tickInProgress = false;
  const runTickBody = async (): Promise<void> => {
    if (!running) return;
    if (tickInProgress) return; // skip overlapping tick; sm is shared across all iterations
    tickInProgress = true;
    try {
      iterationCount++;
    const boundedConfig = { ...config, maxIterations: Infinity };
    const result = await runLoopBody({
      sm,
      state,
      config: boundedConfig,
      plugins,
      iteration: iterationCount,
      writeState: writeBothStates,
      onPhaseFailed: () => {},
      logPath: resolve('loop-run-log.md'),
      broadcast,
      decideEvent: () => 'LOOP',
    });
      state = result.state;
      console.log(`Daemon iteration ${iterationCount} complete`);
    } finally {
      tickInProgress = false;
    }
  };

  // First tick, then interval
  await runTickBody();
  const intervalId = setInterval(runTickBody, intervalMs);
  intervalId.unref();

  // Block until SIGINT/SIGTERM
  await new Promise<void>(() => {});
}
