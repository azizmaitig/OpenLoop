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
  order?: number;
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

function phaseNodeId(planName: string, phaseName: string, iteration: number, liveMode?: boolean): string {
  return liveMode ? `phase-${planName}-${phaseName}` : `phase-${planName}-${phaseName}-i${iteration}`;
}

function loopNodeId(planName: string, iteration: number, liveMode?: boolean): string {
  return liveMode ? `loop-${planName}` : `loop-${planName}-i${iteration}`;
}

function gateNodeId(planName: string, from: string, to: string): string {
  return `gate-${planName}-${from}-to-${to}`;
}

/**
 * Apply a batch of StreamEvents to a node/edge map, returning the updated maps.
 * Shared by processEvents (live stream) and setScrubPos (replay scrub).
 *
 * @param liveMode – When true, collapse per-iteration phase/loop nodes into a single
 *   canonical node keyed WITHOUT the iteration suffix, preventing unbounded growth in
 *   infinite-loop runs. When false (replay mode), use iteration-suffixed IDs for
 *   historical fidelity.
 */
function applyEvents(
  events: StreamEvent[],
  initialNodes: DagNodeData[] = [],
  initialEdges: DagEdgeData[] = [],
  liveMode: boolean = true,
): { nodeMap: Map<string, DagNodeData>; edgeMap: Map<string, DagEdgeData> } {
  const nodeMap = new Map(initialNodes.map((n) => [n.id, n]));
  const edgeMap = new Map(initialEdges.map((e) => [e.id, e]));

  for (const ev of events) {
    switch (ev.type) {
      case 'phase_start': {
        const d = ev.data as PhaseStartData;
        const id = phaseNodeId(d.planName, d.phaseName, d.iteration, liveMode);
        const existing = nodeMap.get(id);
        if (existing && liveMode) {
          // Live mode: update canonical node with latest iteration status
          nodeMap.set(id, {
            ...existing,
            status: 'running',
            command: d.command ?? existing.command,
            startedAt: ev.timestamp,
            dependsOn: d.dependsOn ?? existing.dependsOn,
            order: d.order ?? existing.order,
            iteration: d.iteration, // track the highest iteration
            completedAt: undefined, // clear previous completion when restarting
            durationMs: undefined,
          });
        } else {
          nodeMap.set(id, {
            id,
            label: d.phaseName,
            kind: 'phase',
            status: 'running',
            command: d.command,
            startedAt: ev.timestamp,
            dependsOn: d.dependsOn,
            order: d.order,
            iteration: d.iteration,
            planName: d.planName,
          });
        }
        if (d.dependsOn) {
          for (const dep of d.dependsOn) {
            const src = phaseNodeId(d.planName, dep, d.iteration, liveMode);
            const eid = `${src}->${id}`;
            edgeMap.set(eid, { id: eid, source: src, target: id });
          }
        }
        break;
      }
      case 'phase_complete': {
        const d = ev.data as PhaseCompleteData;
        const id = phaseNodeId(d.planName, d.phaseName, d.iteration, liveMode);
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
      case 'task_failed': {
        const d = ev.data as TaskFailedData;
        const taskKey = d.taskId ?? (d as { id?: string }).id;
        const id = `task-${taskKey}`;
        const existing = nodeMap.get(id);
        if (existing) {
          nodeMap.set(id, {
            ...existing,
            status: 'failed',
            error: d.error,
            completedAt: ev.timestamp,
          });
        }
        break;
      }
      case 'iteration_start': {
        const d = ev.data as IterationData;
        const id = loopNodeId(d.planName, d.iteration, liveMode);
        const existing = nodeMap.get(id);
        if (existing && liveMode) {
          // Live mode: update canonical loop node, increment per-plan run counter
          const nextCount = (existing.iteration ?? 0) + 1;
          nodeMap.set(id, {
            ...existing,
            status: 'running',
            iteration: nextCount,
            startedAt: ev.timestamp,
            completedAt: undefined,
          });
        } else {
          nodeMap.set(id, {
            id,
            label: liveMode ? 'Loop' : `Iteration ${d.iteration}`,
            kind: 'loop',
            status: 'running',
            iteration: d.iteration,
            planName: d.planName,
            startedAt: ev.timestamp,
          });
        }
        break;
      }
      case 'iteration_complete': {
        const d = ev.data as IterationData;
        const id = loopNodeId(d.planName, d.iteration, liveMode);
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

  // Live mode: synthesize LOOP back-edge from the sink phase back to the loop node.
  // This represents the FSM verify → LOOP → init transition.
  if (liveMode) {
    const loopNodes = [...nodeMap.values()].filter((n) => n.kind === 'loop');
    const phaseNodes = [...nodeMap.values()].filter((n) => n.kind === 'phase');

    for (const loop of loopNodes) {
      if (phaseNodes.length === 0) continue;

      // Find the sink phase — a phase that no other phase edge originates from
      const phaseSet = new Set(phaseNodes.map((n) => n.id));
      const outgoingPhaseSources = new Set<string>();
      for (const edge of edgeMap.values()) {
        if (phaseSet.has(edge.source) && phaseSet.has(edge.target)) {
          outgoingPhaseSources.add(edge.source);
        }
      }

      // Sinks are phases with no outgoing edge to another phase
      const sinks = phaseNodes.filter((n) => !outgoingPhaseSources.has(n.id));
      const sinkId = sinks.length > 0 ? sinks[sinks.length - 1].id : phaseNodes[phaseNodes.length - 1].id;
      const backEdgeId = `loop-back-${loop.planName ?? 'default'}`;

      // Only set if not already present (idempotent)
      if (!edgeMap.has(backEdgeId)) {
        edgeMap.set(backEdgeId, {
          id: backEdgeId,
          source: sinkId,
          target: loop.id,
        });
      }
    }

    // Synthesize deterministic intra-phase chain edges from the engine's
    // `order` field. This is the single source of truth for phase sequence —
    // no more guessing from Map insertion / event arrival order.
    // Phases that already carry explicit `dependsOn` edges keep those; only
    // order-indexed phases without an incoming dependsOn edge are chained.
    {
      const allPhases = [...nodeMap.values()].filter((n) => n.kind === 'phase');
      const hasOrder = allPhases.filter((n) => typeof n.order === 'number');
      if (hasOrder.length >= 2) {
        hasOrder.sort((a, b) => (a.order as number) - (b.order as number));
        // Set of phase ids that are already targets of a dependsOn edge.
        const dependsTargets = new Set<string>();
        for (const edge of edgeMap.values()) {
          if (phaseNodes.some((p) => p.id === edge.source) && phaseNodes.some((p) => p.id === edge.target)) {
            dependsTargets.add(edge.target);
          }
        }
        for (let i = 0; i < hasOrder.length - 1; i++) {
          const src = hasOrder[i];
          const tgt = hasOrder[i + 1];
          // Don't synthesize over an explicit dependsOn edge into tgt.
          if (dependsTargets.has(tgt.id)) continue;
          const chainId = `${src.id}->${tgt.id}`;
          if (!edgeMap.has(chainId)) {
            edgeMap.set(chainId, { id: chainId, source: src.id, target: tgt.id });
          }
        }
      }
    }

    // Wire gate nodes into the canonical flow so the DAG reads as:
    // loop → gate(init→run) → first phase → ... → last phase → gate(run→verify→done/init) → loop
    const gateNodes = [...nodeMap.values()].filter((n) => n.kind === 'gate');
    for (const gate of gateNodes) {
      const plan = gate.planName;
      const labelParts = gate.label?.split(' → ');
      if (labelParts?.length !== 2) continue;
      const [from, to] = labelParts;
      const loopForPlan = [...nodeMap.values()].find((n) => n.kind === 'loop' && n.planName === plan);

      if (!loopForPlan) continue;

      if (from === 'init' && to === 'run') {
        // Edge: loop → gate(init→run)
        const loopToGateId = `${loopForPlan.id}->${gate.id}`;
        if (!edgeMap.has(loopToGateId)) {
          edgeMap.set(loopToGateId, { id: loopToGateId, source: loopForPlan.id, target: gate.id });
        }
        // Edge: gate(init→run) → first phase
        const allPhases = [...nodeMap.values()].filter((n) => n.kind === 'phase');
        const incomingPhaseTargets = new Set<string>();
        for (const edge of edgeMap.values()) {
          if (allPhases.some((n) => n.id === edge.source) && allPhases.some((n) => n.id === edge.target)) {
            incomingPhaseTargets.add(edge.target);
          }
        }
        const firstPhase = allPhases.find((n) => !incomingPhaseTargets.has(n.id));
        if (firstPhase) {
          const gateToPhaseId = `${gate.id}->${firstPhase.id}`;
          if (!edgeMap.has(gateToPhaseId)) {
            edgeMap.set(gateToPhaseId, { id: gateToPhaseId, source: gate.id, target: firstPhase.id });
          }
        }
      } else if (to === 'init') {
        // LOOP back-edge gate: gate(verify→init) → loop (feeds the back-edge)
        const gateToLoopId = `${gate.id}->${loopForPlan.id}`;
        if (!edgeMap.has(gateToLoopId)) {
          edgeMap.set(gateToLoopId, { id: gateToLoopId, source: gate.id, target: loopForPlan.id });
        }
      } else {
        // Other gates (run→verify, verify→done): connect from last sink phase
        const allPhases = [...nodeMap.values()].filter((n) => n.kind === 'phase');
        const outgoingPhaseSources = new Set<string>();
        for (const edge of edgeMap.values()) {
          if (allPhases.some((n) => n.id === edge.source) && allPhases.some((n) => n.id === edge.target)) {
            outgoingPhaseSources.add(edge.source);
          }
        }
        const sinks = allPhases.filter((n) => !outgoingPhaseSources.has(n.id));
        const lastPhase = sinks.length > 0 ? sinks[sinks.length - 1] : allPhases[allPhases.length - 1];
        if (lastPhase) {
          const lastPhaseToGateId = `${lastPhase.id}->${gate.id}`;
          if (!edgeMap.has(lastPhaseToGateId)) {
            edgeMap.set(lastPhaseToGateId, { id: lastPhaseToGateId, source: lastPhase.id, target: gate.id });
          }
        }
      }
    }
  }

  return { nodeMap, edgeMap };
}

export interface DagStore {
  dagNodes: DagNodeData[];
  dagEdges: DagEdgeData[];
  selectedNodeId: string | null;
  history: StreamEvent[];

  // ── Live mode (collapse per-iteration nodes into canonical nodes) ────────
  liveMode: boolean;

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
  setLiveMode: (mode: boolean) => void;
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

  // Live mode default (collapse iterations into canonical nodes)
  liveMode: true,

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
    const { nodeMap, edgeMap } = applyEvents(events, state.dagNodes, state.dagEdges, state.liveMode);
    set({
      dagNodes: [...nodeMap.values()],
      dagEdges: [...edgeMap.values()],
      history: [...state.history, ...events].slice(-500),
    });
  },

  setLiveMode: (mode) => set({ liveMode: mode }),

  reset: () =>
    set({
      dagNodes: [],
      dagEdges: [],
      selectedNodeId: null,
      history: [],
      liveMode: true,
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

    const { nodeMap, edgeMap } = applyEvents(events, [], [], false);
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

    // Iteration complete — outcome reflects actual task results.
    const anyFailed = checkpoint.completedTaskIds.some((id) => {
      const r = checkpoint.results[id];
      return r?.status === 'fail' || r?.status === 'error';
    });
    const iterOutcome = anyFailed ? 'fail' : 'pass';
    events.push({
      type: 'iteration_complete',
      data: { planName, iteration: iter, outcome: iterOutcome } satisfies IterationData,
      timestamp: checkpoint.updatedAt,
    });

    // Store and process all events in one atomic update (replay mode = not live)
    const { nodeMap, edgeMap } = applyEvents(events, [], [], false);
    set({
      selectedPlanName: planName,
      replayEvents: events,
      scrubPos: -1,
      dagNodes: [...nodeMap.values()],
      dagEdges: [...edgeMap.values()],
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
