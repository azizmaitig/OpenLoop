import type { StateMachineState } from './types.js';

// ponytail: Record<State, Record<Event, State>> — flat lookup, no OOP pattern overhead, add when branching logic needed
const TRANSITIONS: Record<StateMachineState, Record<string, StateMachineState>> = {
  init: { RUN: 'run', ABORT: 'done' },
  run: { VERIFY: 'verify', ABORT: 'done' },
  verify: { COMPLETE: 'done', LOOP: 'init', FAILED: 'done', ABORT: 'done' },
  done: {},
};

const ALL_EVENTS = ['RUN', 'VERIFY', 'COMPLETE', 'LOOP', 'FAILED', 'ABORT'] as const;
export type StateMachineEvent = (typeof ALL_EVENTS)[number];

export class StateMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateMachineError';
  }
}

export class StateMachine {
  public currentState: StateMachineState;

  constructor(initialState: StateMachineState = 'init') {
    this.currentState = initialState;
  }

  transition(event: string): StateMachineState {
    const row = TRANSITIONS[this.currentState];
    const next = row[event];

    if (next === undefined) {
      throw new StateMachineError(
        `Invalid transition: event "${event}" is not allowed from state "${this.currentState}"`,
      );
    }

    this.currentState = next;
    return this.currentState;
  }

  allowedEvents(): string[] {
    return Object.keys(TRANSITIONS[this.currentState]);
  }

  isTerminal(): boolean {
    return this.currentState === 'done';
  }
}
