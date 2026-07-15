/**
 * events.ts — shared event contract for the real-time dashboard.
 *
 * ── EVENT CONTRACT ──────────────────────────────────────────────────────────
 * Every event is a discriminated union on `type` with a `ts: string` (ISO timestamp).
 * All payloads are JSON-serializable (no functions, no Map/Set, no class instances).
 *
 * | type                | key fields                                                |
 * |---------------------|-----------------------------------------------------------|
 * | phase_start         | planName, iteration, phaseName, command, dependsOn?       |
 * | phase_complete      | planName, iteration, phaseName, status, durationMs, ...   |
 * | task_started        | taskId, command, kind ('shell'|'llm')                     |
 * | task_completed      | taskId, status, durationMs?, result?, error?              |
 * | task_failed         | taskId, error                                             |
 * | fsm_transition      | planName, iteration, from, to, event                      |
 * | iteration_start     | planName, iteration                                       |
 * | iteration_complete  | planName, iteration, outcome                              |
 * | state_change        | daemonStatus, loopState (existing — keep compatible)      |
 * | child_status_change | loopId, status (existing — keep compatible)               |
 *
 * Backend: construct via makeEvent() and pass to broadcast().
 * Frontend: switch on `type` and narrow the payload via the discriminated union.
 *
 * @module events
 */

import type {
  TaskStatus,
  OutcomeStatus,
  DaemonStatus,
  LoopState,
  ChildLoopStatus,
  ExecutionResult,
} from './types.js';

// ── Individual event payload interfaces ──────────────────────────────────────

export interface PhaseStartEvent {
  ts: string;
  planName: string;
  iteration: number;
  phaseName: string;
  command: string;
  dependsOn?: string[];
}

export interface PhaseCompleteEvent {
  ts: string;
  planName: string;
  iteration: number;
  phaseName: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  exitCode?: number;
  error?: string;
}

export interface TaskStartedEvent {
  ts: string;
  taskId: string;
  command: string;
  kind: 'shell' | 'llm';
}

export interface TaskCompletedEvent {
  ts: string;
  taskId: string;
  status: TaskStatus;
  durationMs?: number;
  result?: ExecutionResult;
  error?: string;
}

export interface TaskFailedEvent {
  ts: string;
  taskId: string;
  error: string;
}

export interface FsmTransitionEvent {
  ts: string;
  planName: string;
  iteration: number;
  from: string;
  to: string;
  event: string;
}

export interface IterationStartEvent {
  ts: string;
  planName: string;
  iteration: number;
}

export interface IterationCompleteEvent {
  ts: string;
  planName: string;
  iteration: number;
  outcome: OutcomeStatus;
}

/** Existing state_change — kept backward compatible. The runtime payload may
 *  include additional fields (children, queueLength, currentTask) that the
 *  WS client already handles; the typed contract guarantees at minimum the
 *  fields below. */
export interface StateChangeEvent {
  ts: string;
  daemonStatus: DaemonStatus;
  loopState: LoopState | null;
}

/** Existing child_status_change — kept backward compatible. */
export interface ChildStatusChangeEvent {
  ts: string;
  loopId: string;
  status: ChildLoopStatus;
}

// ── Discriminated union ──────────────────────────────────────────────────────

export type LoopEvent =
  | ({ type: 'phase_start' } & PhaseStartEvent)
  | ({ type: 'phase_complete' } & PhaseCompleteEvent)
  | ({ type: 'task_started' } & TaskStartedEvent)
  | ({ type: 'task_completed' } & TaskCompletedEvent)
  | ({ type: 'task_failed' } & TaskFailedEvent)
  | ({ type: 'fsm_transition' } & FsmTransitionEvent)
  | ({ type: 'iteration_start' } & IterationStartEvent)
  | ({ type: 'iteration_complete' } & IterationCompleteEvent)
  | ({ type: 'state_change' } & StateChangeEvent)
  | ({ type: 'child_status_change' } & ChildStatusChangeEvent);

/**
 * LoopEventMap — maps each event type to its payload (excluding `type` and `ts`).
 * Useful for lookups: `LoopEventMap['phase_start']` yields `{ planName, iteration, ... }`.
 */
export type LoopEventMap = {
  [K in LoopEvent['type']]: Omit<Extract<LoopEvent, { type: K }>, 'type' | 'ts'>;
};

// ── Construction helper ──────────────────────────────────────────────────────

/**
 * Construct a correctly-typed LoopEvent with an auto-stamped ISO timestamp.
 *
 * Usage:
 *   broadcast('phase_start', makeEvent('phase_start', {
 *     planName: 'daily-triage', iteration: 1, phaseName: 'scan', command: 'type STATE.md',
 *   }));
 *
 * The return type is narrowed to the variant matching `type`, so the payload
 * is type-checked and the result is ready to emit.
 */
export function makeEvent<T extends LoopEvent['type']>(
  type: T,
  payload: Omit<Extract<LoopEvent, { type: T }>, 'type' | 'ts'>,
): Extract<LoopEvent, { type: T }> {
  return { type, ts: new Date().toISOString(), ...payload } as Extract<LoopEvent, { type: T }>;
}
