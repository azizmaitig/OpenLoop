import type { StateMachine } from "./state-machine.js";
import type { LoopState } from "./types.js";
import { setCurrentState } from "./state.js";

/**
 * Sole owner of the FSM transition effect.
 *
 * Advances the state machine, mirrors the resulting state into `LoopState`,
 * clears `phaseResults` on LOOP (a new iteration discards prior phase output),
 * and updates the global current-state mirror. The caller decides the *event*
 * (e.g. via `resolveTransition`); this only *applies* it.
 *
 * Throws `StateMachineError` (via `sm.transition`) when the event is invalid
 * for the current state — this is the desired fail-loud contract.
 *
 * Pure except for the global mirror write in `setCurrentState`.
 */
export function applyTransition(
  event: string,
  state: LoopState,
  sm: StateMachine,
): LoopState {
  const next = sm.transition(event); // mutates sm.currentState; throws on invalid event
  const updated: LoopState = {
    ...state,
    currentState: next,
    phaseResults: event === "LOOP" ? {} : state.phaseResults,
  };
  setCurrentState(updated);
  return updated;
}
