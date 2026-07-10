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

  state = applyTransition('RUN', state, sm);
  await writeState(state);

  const phaseResult = await executePhaseGroup(
    {
      config,
      plugins,
      writeState,
      onPhaseFailed: deps.onPhaseFailed ?? (() => {}),
      planPath: deps.planPath,
      getPlanDoc: deps.getPlanDoc,
      logPath: deps.logPath,
    },
    state,
    iteration,
  );
  const allPassed = phaseResult.allPassed;
  state = phaseResult.state;
  setCurrentState(state);

  state = applyTransition('VERIFY', state, sm);
  await writeState(state);

  const event = await decideEvent(allPassed, state);
  state = applyTransition(event, state, sm);
  await writeState(state);

  return { state, allPassed, event };
}
