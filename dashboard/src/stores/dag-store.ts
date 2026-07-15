// stores/dag-store.ts — zustand store that reconstructs a DAG from the live
// event stream. Every event handler is idempotent: replaying the same event
// twice yields the same graph (upsert by node ID).
//
// EXTENDED: replay mode (checkpoint replay), deep-link state, pause state.

import { create } from 'zustand';
import type {
  DagNodeData,
  DagNodeStatus,
  DagEdgeData,
  StreamEvent,
  OutcomeStatus,
  CheckpointState,
} from '../lib/types';

interface PhaseStartData {
  planName: string;
  phaseName: string;
  iteration: number;
  command?: string;
  dependsOn?: string[];
}

interface PhaseCompleteData {
  planName: string;
  phaseName: string;
  iteration: number;
  outcome: OutcomeStatus;
  durationMs: number;
}

interface TaskStartedData {
  taskId: string;
  command: string;
  kind?: string;
}

interface TaskCompletedData {
  taskId: string;
  output?: string;
  result?: { stdout?: string };
}

interface TaskFailedData {
  taskId: string;
  error: string;
}

interface IterationData {
  planName: string;
  iteration: number;
  outcome?: OutcomeStatus;
}

interface FsmTransitionData {
  planName: string;
  iteration: number;
  from: string;
  to: string;
  event: string;
}

function asOutcomeStatus(v: string | undefined): DagNodeStatus {
  if (v === 'pass') return 'completed';
  if (v === 'fail' || v === 'error') return 'failed';
  return 'running';
}

function phaseNodeId(planName: string, phaseName: string, iteration: number): string {
  return `phase-${planName}-${phaseName}-i${iteration}`;
}

function loopNodeId(planName: string, iteration: number): string {
  return `loop-${planName}-i${iteration}`;
}

function gateNodeId(planName: string, from: string, to: string): string {
  return `gate-${planName}-${from}-to-${to}`;
}

/**
 * Apply a batch of StreamEvents to a node/edge map, returning the updated maps.
 * Shared by processEvents (live stream) and setScrubPos (replay scrub).
 */
function applyEvents(
  events: StreamEvent[],
  initialNodes: DagNodeData[] = [],
  initialEdges: DagEdgeData[] = [],
): { nodeMap: Map<string, DagNodeData>; edgeMap: Map<string, DagEdgeData> } {
  const nodeMap = new Map(initialNodes.map((n) => [n.id, n]));
  const edgeMap = new Map(initialEdges.map((e) => [e.id, e]));

  for (const ev of events) {
    switch (ev.type) {
      case 'phase_start': {
        const d = ev.data as PhaseStartData;
        const id = phaseNodeId(d.planName, d.phaseName, d.iteration);
        nodeMap.set(id, {
          id,
          label: d.phaseName,
          kind: 'phase',
          status: 'running',
          command: d.command,
          startedAt: ev.timestamp,
          dependsOn: d.dependsOn,
          iteration: d.iteration,
          planName: d.planName,
        });
        if (d.dependsOn) {
          for (const dep of d.dependsOn) {
            const src = phaseNodeId(d.planName, dep, d.iteration);
            const eid = `${src}->${id}`;
            edgeMap.set(eid, { id: eid, source: src, target: id });
          }
        }
        break;
      }
      case 'phase_complete': {
        const d = ev.data as PhaseCompleteData;
        const id = phaseNodeId(d.planName, d.phaseName, d.iteration);
        const existing = nodeMap.get(id);
        if (existing) {
          nodeMap.set(id, {
            ...existing,
            status: asOutcomeStatus(d.outcome ?? 'pass'),
            completedAt: ev.timestamp,
            durationMs: d.durationMs,
          });
        }
        break;
      }
      case 'task_started': {
        const d = ev.data as TaskStartedData;
        const taskKey = d.taskId ?? (d as { id?: string }).id;
        const id = `task-${taskKey}`;
        nodeMap.set(id, {
          id,
          label: d.command || d.taskId,
          kind: 'task',
          status: 'running',
          command: d.command,
          startedAt: ev.timestamp,
        });
        break;
      }
      case 'task_completed': {
        const d = ev.data as TaskCompletedData;
        const taskKey = d.taskId ?? (d as { id?: string }).id;
        const id = `task-${taskKey}`;
        const existing = nodeMap.get(id);
        if (existing) {
          nodeMap.set(id, {
            ...existing,
            status: 'completed',
            output: d.output || d.result?.stdout,
            completedAt: ev.timestamp,
          });
        }
        break;
      }
      case 'iteration_start': {
        const d = ev.data as IterationData;
        const id = loopNodeId(d.planName, d.iteration);
        nodeMap.set(id, {
          id,
          label: `Iteration ${d.iteration}`,
          kind: 'loop',
          status: 'running',
          iteration: d.iteration,
          planName: d.planName,
          startedAt: ev.timestamp,
        });
        break;
      }
      case 'iteration_complete': {
        const d = ev.data as IterationData;
        const id = loopNodeId(d.planName, d.iteration);
        const existing = nodeMap.get(id);
        if (existing) {
          nodeMap.set(id, {
            ...existing,
            status: asOutcomeStatus(d.outcome ?? 'pass'),
            completedAt: ev.timestamp,
          });
        }
        break;
      }
      case 'fsm_transition': {
        const d = ev.data as FsmTransitionData;
        const id = gateNodeId(d.planName, d.from, d.to);
        nodeMap.set(id, {
          id,
          label: `${d.from} → ${d.to}`,
          kind: 'gate',
          status: 'completed',
          command: d.event,
          planName: d.planName,
          startedAt: ev.timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  return { nodeMap, edgeMap };
}

export interface DagStore {
  dagNodes: DagNodeData[];
  dagEdges: DagEdgeData[];
  selectedNodeId: string | null;
  history: StreamEvent[];

  // ── Replay mode ──────────────────────────────────────────────────────────
  replayMode: boolean;
  selectedPlanName: string | null;
  replayEvents: StreamEvent[];
  scrubPos: number; // -1 = show all events, 0..N-1 = show up to that event
  // Backup of live DAG state when entering replay (so we can restore on exit)
  _liveDagNodes: DagNodeData[];
  _liveDagEdges: DagEdgeData[];
  _liveHistory: StreamEvent[];

  // ── Pause state (mirrored from WS daemon status) ─────────────────────────
  isPaused: boolean;

  // ── Deep-link state ──────────────────────────────────────────────────────
  deepLinkedPlan: string | null;
  deepLinkedPhase: string | null;

  setSelectedNode: (id: string | null) => void;
  processEvents: (events: StreamEvent[]) => void;
  reset: () => void;

  // ── Replay actions ───────────────────────────────────────────────────────
  enterReplayMode: () => void;
  exitReplayMode: () => void;
  setScrubPos: (pos: number) => void;
  loadCheckpoint: (state: CheckpointState) => StreamEvent[];
  selectReplayPlan: (planName: string | null) => void;

  // ── Pause actions ────────────────────────────────────────────────────────
  setPaused: (paused: boolean) => void;

  // ── Deep-link actions ────────────────────────────────────────────────────
  setDeepLinkedPlan: (plan: string | null) => void;
  setDeepLinkedPhase: (phase: string | null) => void;
  clearDeepLink: () => void;
}

export const useDagStore = create<DagStore>((set, get) => ({
  dagNodes: [],
  dagEdges: [],
  selectedNodeId: null,
  history: [],

  // Replay defaults
  replayMode: false,
  selectedPlanName: null,
  replayEvents: [],
  scrubPos: -1,
  _liveDagNodes: [],
  _liveDagEdges: [],
  _liveHistory: [],

  // Pause defaults
  isPaused: false,

  // Deep-link defaults
  deepLinkedPlan: null,
  deepLinkedPhase: null,

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  processEvents: (events) => {
    const state = get();
    const { nodeMap, edgeMap } = applyEvents(events, state.dagNodes, state.dagEdges);
    set({
      dagNodes: [...nodeMap.values()],
      dagEdges: [...edgeMap.values()],
      history: [...state.history, ...events],
    });
  },

  reset: () =>
    set({
      dagNodes: [],
      dagEdges: [],
      selectedNodeId: null,
      history: [],
      replayMode: false,
      selectedPlanName: null,
      replayEvents: [],
      scrubPos: -1,
    }),

  // ── Replay actions ───────────────────────────────────────────────────────

  enterReplayMode: () => {
    const state = get();
    // Save live state
    set({
      _liveDagNodes: state.dagNodes,
      _liveDagEdges: state.dagEdges,
      _liveHistory: state.history,
      replayMode: true,
      dagNodes: [],
      dagEdges: [],
      history: [],
      selectedNodeId: null,
    });
  },

  exitReplayMode: () => {
    const state = get();
    set({
      replayMode: false,
      selectedPlanName: null,
      replayEvents: [],
      scrubPos: -1,
      dagNodes: state._liveDagNodes,
      dagEdges: state._liveDagEdges,
      history: state._liveHistory,
      _liveDagNodes: [],
      _liveDagEdges: [],
      _liveHistory: [],
      selectedNodeId: null,
      deepLinkedPlan: null,
      deepLinkedPhase: null,
    });
  },

  setScrubPos: (pos) => {
    const state = get();
    if (!state.replayMode) return;
    set({ scrubPos: pos });

    const events =
      pos === -1
        ? state.replayEvents
        : state.replayEvents.slice(0, pos + 1);

    const { nodeMap, edgeMap } = applyEvents(events);
    set({
      dagNodes: [...nodeMap.values()],
      dagEdges: [...edgeMap.values()],
    });
  },

  /** Generate synthetic StreamEvent[] from a checkpoint and load them into the store. */
  loadCheckpoint: (checkpoint: CheckpointState): StreamEvent[] => {
    const events: StreamEvent[] = [];
    const startedBase = new Date(checkpoint.startedAt).getTime();

    const planName = checkpoint.planName;
    const iter = 1;

    // Iteration start
    events.push({
      type: 'iteration_start',
      data: { planName, iteration: iter } satisfies IterationData,
      timestamp: checkpoint.startedAt,
    });

    // FSM transition: init → run
    events.push({
      type: 'fsm_transition',
      data: { planName, iteration: iter, from: 'init', to: 'run', event: 'RUN' } satisfies FsmTransitionData,
      timestamp: checkpoint.startedAt,
    });

    let cumulativeMs = 0;
    let prevTaskId: string | null = null;

    // Completed tasks
    for (const taskId of checkpoint.completedTaskIds) {
      const result = checkpoint.results[taskId];
      const durationMs = result?.durationMs ?? 100;
      const taskStart = startedBase + cumulativeMs;
      const taskEnd = taskStart + durationMs;
      const taskStartIso = new Date(taskStart).toISOString();
      const taskEndIso = new Date(taskEnd).toISOString();

      // phase_start for this task
      events.push({
        type: 'phase_start',
        data: {
          planName,
          phaseName: taskId,
          iteration: iter,
          command: taskId,
          dependsOn: prevTaskId ? [prevTaskId] : undefined,
        } satisfies PhaseStartData,
        timestamp: taskStartIso,
      });

      const outcome = result?.status ?? 'pass';

      // phase_complete
      events.push({
        type: 'phase_complete',
        data: {
          planName,
          phaseName: taskId,
          iteration: iter,
          outcome,
          durationMs,
        } satisfies PhaseCompleteData,
        timestamp: taskEndIso,
      });

      cumulativeMs += durationMs + 50; // small gap between tasks
      prevTaskId = taskId;
    }

    // In-progress task (if any)
    if (checkpoint.inProgressTaskId) {
      const taskId = checkpoint.inProgressTaskId;
      const taskStart = startedBase + cumulativeMs;
      const taskStartIso = new Date(taskStart).toISOString();

      events.push({
        type: 'phase_start',
        data: {
          planName,
          phaseName: taskId,
          iteration: iter,
          command: taskId,
          dependsOn: prevTaskId ? [prevTaskId] : undefined,
        } satisfies PhaseStartData,
        timestamp: taskStartIso,
      });

    }

    // FSM transition: run → verify
    events.push({
      type: 'fsm_transition',
      data: { planName, iteration: iter, from: 'run', to: 'verify', event: 'VERIFY' } satisfies FsmTransitionData,
      timestamp: new Date(startedBase + cumulativeMs).toISOString(),
    });

    // Iteration complete
    events.push({
      type: 'iteration_complete',
      data: { planName, iteration: iter, outcome: 'pass' } satisfies IterationData,
      timestamp: checkpoint.updatedAt,
    });

    // Store and process all events
    set({
      selectedPlanName: planName,
      replayEvents: events,
      scrubPos: -1,
    });

    return events;
  },

  selectReplayPlan: (planName) => set({ selectedPlanName: planName }),

  // ── Pause actions ────────────────────────────────────────────────────────

  setPaused: (paused) => set({ isPaused: paused }),

  // ── Deep-link actions ────────────────────────────────────────────────────

  setDeepLinkedPlan: (plan) => set({ deepLinkedPlan: plan }),
  setDeepLinkedPhase: (phase) => set({ deepLinkedPhase: phase }),
  clearDeepLink: () => set({ deepLinkedPlan: null, deepLinkedPhase: null }),
}));
