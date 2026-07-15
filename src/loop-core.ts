/**
 * loop-core.ts — the single shared loop-body iteration.
 *
 * Extracted from loop-runner.ts `runLoop()` and daemon.ts `runIntervalTick()`
 * (Candidate 2). Both callers ran a ~30-LOC near-copy of this per-iteration
 * body; the duplicate collapsed once Candidate 1 routed transitions through
 * `applyTransition`.
 *
 * `runLoopBody` owns ONE iteration:
 *   reset working state → RUN → execute phases → VERIFY → decide event → apply it
 *
 * Callers own loop control and the decide-event policy, so the two shapes
 * collapse cleanly:
 *   - runLoop():        bounded for-loop, decideEvent = resolveTransition(...)
 *   - runIntervalTick(): setInterval driver, decideEvent = () => 'LOOP'
 *                        (daemon ignores pass/fail, runs until SIGINT)
 *
 * Behavior-preserving: identical transition sequence to the pre-extraction
 * bodies. Does not mutate the caller's `state` object (applyTransition returns
 * a new object); returns the latest state plus the decided event.
 */

import type { StateMachine } from './state-machine.js';
import { applyTransition } from './transition.js';
import { executePhaseGroup, type ExecutionDeps } from './execute-phases.js';
import { setCurrentState } from './state.js';
import type { Plugin } from './plugins.js';
import type { LoopConfig, LoopState, PlanYamlDoc } from './types.js';
import { makeEvent } from './events.js';

export interface LoopBodyDeps {
  sm: StateMachine;
  state: LoopState;
  config: LoopConfig;
  plugins: Plugin[];
  iteration: number;
  writeState: (state: LoopState) => Promise<void>;
  /**
   * Decide the next FSM event after VERIFY. Receives `allPassed` and the
   * post-VERIFY state (phaseResults available for judgment). The caller
   * supplies its own policy:
   *   - daemon:  () => 'LOOP'   (always loops, runs until SIGINT)
   *   - runLoop: resolveTransition(sm, config, state, i, allPassed)
   */
  decideEvent: (allPassed: boolean, state: LoopState) => string | Promise<string>;
  onPhaseFailed?: ExecutionDeps['onPhaseFailed'];
  planPath?: string;
  getPlanDoc?: () => PlanYamlDoc | null;
  logPath?: string;
  broadcast?: (type: string, data: unknown) => void;
  /** Optional: abort signal for early termination. Checked before and during phase execution. */
  signal?: AbortSignal;
  executePhaseGroup?: typeof executePhaseGroup;
}

export interface LoopBodyResult {
  state: LoopState;
  allPassed: boolean;
  event: string;
}

export async function runLoopBody(deps: LoopBodyDeps): Promise<LoopBodyResult> {
  const { sm, config, plugins, iteration, writeState, decideEvent } = deps;

  // Reset per-iteration working state. Mirrors the daemon tick reset; for
  // runLoop this is idempotent (the LOOP transition already clears
  // phaseResults and the FSM re-enters 'init' each iteration).
  let state: LoopState = {
    ...deps.state,
    iteration,
    currentState: 'init',
    phaseResults: {},
    errors: [],
  };

  // Track FSM transitions with before/after state
  const planName = config.taskName;

  const tr1_from = state.currentState;
  state = applyTransition('RUN', state, sm);
  const tr1_to = state.currentState;
  deps.broadcast?.('fsm_transition', makeEvent('fsm_transition', { planName, iteration, from: tr1_from, to: tr1_to, event: 'RUN' }));
  deps.broadcast?.('iteration_start', makeEvent('iteration_start', { planName, iteration }));
  await writeState(state);

  const runPhases = deps.executePhaseGroup ?? executePhaseGroup;
  const phaseResult = await runPhases(
    {
      config,
      plugins,
      writeState,
      onPhaseFailed: deps.onPhaseFailed ?? (() => {}),
      planPath: deps.planPath,
      getPlanDoc: deps.getPlanDoc,
      logPath: deps.logPath,
      broadcast: deps.broadcast,
      signal: deps.signal,
    },
    state,
    iteration,
  );
  const allPassed = phaseResult.allPassed;
  state = phaseResult.state;
  setCurrentState(state);

  const tr2_from = state.currentState;
  state = applyTransition('VERIFY', state, sm);
  const tr2_to = state.currentState;
  deps.broadcast?.('fsm_transition', makeEvent('fsm_transition', { planName, iteration, from: tr2_from, to: tr2_to, event: 'VERIFY' }));
  await writeState(state);

  const event = await decideEvent(allPassed, state);

  const tr3_from = state.currentState;
  state = applyTransition(event, state, sm);
  const tr3_to = state.currentState;
  deps.broadcast?.('fsm_transition', makeEvent('fsm_transition', { planName, iteration, from: tr3_from, to: tr3_to, event }));
  deps.broadcast?.('iteration_complete', makeEvent('iteration_complete', {
    planName,
    iteration,
    outcome: allPassed ? 'pass' : event === 'ABORT' ? 'error' : 'fail',
  }));
  await writeState(state);

  return { state, allPassed, event };
}
