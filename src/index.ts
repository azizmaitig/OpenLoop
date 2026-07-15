export type { StateMachineState, PhaseDef, LoopConfig, PhaseResult, LoopState, LoopResult, Judgment, PlanYamlTask, PlanYamlDoc, PlanContext, DaemonStatus, ChildLoopDef, ChildLoopState, ChildLoopSummary, LoopsConfig, ChildLoopStatus } from './types.js';
export { DEFAULT_CONFIG, mergeConfig } from './config.js';
export { readState, writeState, createInitialState, updatePhaseResult, updateStateMd } from './state.js';
export type { StateMdFrontmatter } from './state.js';
export { initProject } from './init.js';
export type { InitResult } from './init.js';
export { StateMachine, StateMachineError } from './state-machine.js';
export type { StateMachineEvent } from './state-machine.js';
export { executeWithTimeout, PhaseTimeoutError } from './safety.js';
export { executeMcpPhase } from './mcp.js';
export { evaluatePhase } from './evaluate.js';
export { loadPlugins, executeHooks, executeBeforeLoop, executeAfterLoop } from './plugins.js';
export type { Plugin, HookContext } from './plugins.js';
export { Daemon } from './daemon.js';
export { TaskQueue } from './task-queue.js';
export { saveTaskHistory, readTaskHistory, listTaskHistory } from './history.js';
export { createMakerCheckerPlugin } from './maker-checker-plugin.js';
export type { MakerCheckerConfig } from './maker-checker-plugin.js';
export { LoopOrchestrator } from './orchestrator.js';
export type { OrchestratorConfig } from './orchestrator.js';
export { remainingRuns } from './budget.js';

// ── Event contract (real-time dashboard DAG) ────────────────────────────────
export { makeEvent } from './events.js';
export type {
  LoopEvent,
  LoopEventMap,
  PhaseStartEvent,
  PhaseCompleteEvent,
  TaskStartedEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  FsmTransitionEvent,
  IterationStartEvent,
  IterationCompleteEvent,
  StateChangeEvent,
  ChildStatusChangeEvent,
} from './events.js';
