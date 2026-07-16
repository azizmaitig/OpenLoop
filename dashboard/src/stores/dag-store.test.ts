import { describe, it, expect, beforeEach } from 'vitest';
import { useDagStore } from './dag-store';
import type { CheckpointState } from '../lib/types';

/**
 * Build a representative CheckpointState with 2 completed tasks + 1 in-progress.
 * This is the fixture for MEDIUM-4 regression.
 */
function sampleCheckpoint(overrides?: Partial<CheckpointState>): CheckpointState {
  return {
    planPath: '/tmp/test-plan.yaml',
    planName: 'test-plan',
    startedAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:05:00.000Z',
    completedTaskIds: ['task-1', 'task-2'],
    inProgressTaskId: 'task-3',
    results: {
      'task-1': { status: 'pass', durationMs: 500, exitCode: 0 },
      'task-2': { status: 'fail', durationMs: 1200, exitCode: 1 },
    },
    ...overrides,
  };
}

describe('loadCheckpoint (MEDIUM-4 regression)', () => {
  beforeEach(() => {
    // Reset store to clean state before each test
    useDagStore.setState({
      dagNodes: [],
      dagEdges: [],
      selectedNodeId: null,
      history: [],
      replayMode: false,
      selectedPlanName: null,
      replayEvents: [],
      scrubPos: -1,
      _liveDagNodes: [],
      _liveDagEdges: [],
      _liveHistory: [],
    });
  });

  it('produces no task_started or task_completed events in the returned array', () => {
    const events = useDagStore.getState().loadCheckpoint(sampleCheckpoint());

    const forbidden = events.filter(
      (e) => e.type === 'task_started' || e.type === 'task_completed',
    );
    expect(forbidden).toHaveLength(0);
  });

  it('produces no task- prefixed DAG nodes after replay', () => {
    const store = useDagStore.getState();
    store.loadCheckpoint(sampleCheckpoint());

    // setScrubPos requires replayMode — fake it so the DAG is built from replayEvents
    useDagStore.setState({ replayMode: true });
    useDagStore.getState().setScrubPos(-1);

    const nodes = useDagStore.getState().dagNodes;
    const taskNodes = nodes.filter((n) => n.id.startsWith('task-'));
    expect(taskNodes).toHaveLength(0);
  });

  it('creates exactly one phase node per task unit', () => {
    const cp = sampleCheckpoint();
    const totalTasks =
      cp.completedTaskIds.length + (cp.inProgressTaskId ? 1 : 0); // = 3

    useDagStore.getState().loadCheckpoint(cp);
    useDagStore.setState({ replayMode: true });
    useDagStore.getState().setScrubPos(-1);

    const nodes = useDagStore.getState().dagNodes;
    const phaseNodes = nodes.filter((n) => n.kind === 'phase');
    expect(phaseNodes).toHaveLength(totalTasks);
  });

  it('edges link consecutive task phase nodes (dependsOn chain)', () => {
    const cp = sampleCheckpoint();
    useDagStore.getState().loadCheckpoint(cp);
    useDagStore.setState({ replayMode: true });
    useDagStore.getState().setScrubPos(-1);

    const edges = useDagStore.getState().dagEdges;

    // Each dependsOn creates one edge. First task has no dependsOn,
    // so N tasks produce N-1 dependency edges.
    const totalTasks =
      cp.completedTaskIds.length + (cp.inProgressTaskId ? 1 : 0);
    const depEdges = edges.filter(
      (e) => e.source.startsWith('phase-') && e.target.startsWith('phase-'),
    );
    expect(depEdges).toHaveLength(totalTasks - 1);

    // Verify the chain: task-1 → task-2 → task-3
    const nodeIds = ['task-1', 'task-2', 'task-3'];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const src = `phase-test-plan-${nodeIds[i]}-i1`;
      const tgt = `phase-test-plan-${nodeIds[i + 1]}-i1`;
      const edge = depEdges.find((e) => e.source === src && e.target === tgt);
      expect(edge, `expected edge ${src} -> ${tgt}`).toBeDefined();
    }
  });

  it('handles empty completed tasks with only an in-progress task', () => {
    const cp = sampleCheckpoint({
      completedTaskIds: [],
      inProgressTaskId: 'task-1',
      results: {},
    });

    const events = useDagStore.getState().loadCheckpoint(cp);
    const forbidden = events.filter(
      (e) => e.type === 'task_started' || e.type === 'task_completed',
    );
    expect(forbidden).toHaveLength(0);

    useDagStore.setState({ replayMode: true });
    useDagStore.getState().setScrubPos(-1);

    const nodes = useDagStore.getState().dagNodes;
    const phaseNodes = nodes.filter((n) => n.kind === 'phase');
    expect(phaseNodes).toHaveLength(1);
    expect(phaseNodes[0].id).toBe('phase-test-plan-task-1-i1');
    expect(phaseNodes[0].status).toBe('running'); // no phase_complete → running
  });

  it('marks failed tasks with failed status', () => {
    const cp = sampleCheckpoint();
    useDagStore.getState().loadCheckpoint(cp);
    useDagStore.setState({ replayMode: true });
    useDagStore.getState().setScrubPos(-1);

    const nodes = useDagStore.getState().dagNodes;
    const task2Node = nodes.find(
      (n) => n.id === 'phase-test-plan-task-2-i1',
    );
    expect(task2Node).toBeDefined();
    expect(task2Node!.status).toBe('failed');
  });
});

/**
 * LIVE-MODE ORDER CHAINING (long-term fix).
 *
 * The engine now emits `order` on phase_start. The dashboard must chain
 * phases by that `order` — deterministically, regardless of event arrival
 * order or Map insertion order. This replaces the old heuristic that only
 * worked "by accident" for plans whose events arrived in plan order.
 */
describe('live mode order-based phase chaining', () => {
  const plan = 'cal-continuous';

  function phaseStart(phaseName: string, order: number, ts: string) {
    return {
      type: 'phase_start' as const,
      data: { planName: plan, iteration: 1, phaseName, command: `cmd ${phaseName}`, order },
      timestamp: ts,
    };
  }
  function iterationStart() {
    return {
      type: 'iteration_start' as const,
      data: { planName: plan, iteration: 1 },
      timestamp: '2026-07-16T00:00:00.000Z',
    };
  }
  function fsm(from: string, to: string) {
    return {
      type: 'fsm_transition' as const,
      data: { planName: plan, iteration: 1, from, to, event: from.toUpperCase() },
      timestamp: '2026-07-16T00:00:00.000Z',
    };
  }

  beforeEach(() => {
    useDagStore.setState({
      dagNodes: [],
      dagEdges: [],
      selectedNodeId: null,
      history: [],
      replayMode: false,
      liveMode: true,
      selectedPlanName: null,
      replayEvents: [],
      scrubPos: -1,
      _liveDagNodes: [],
      _liveDagEdges: [],
      _liveHistory: [],
    });
  });

  function chainEdges() {
    const edges = useDagStore.getState().dagEdges;
    return edges.filter((e) => e.source.startsWith('phase-') && e.target.startsWith('phase-'));
  }

  it('chains phases in emitted order regardless of arrival order', () => {
    // Arrival order is intentionally scrambled (verify-build first, then read-state).
    const events = [
      iterationStart(),
      fsm('init', 'run'),
      phaseStart('verify-build', 3, '2026-07-16T00:00:03.000Z'),
      phaseStart('scan-reality', 1, '2026-07-16T00:00:01.000Z'),
      phaseStart('improve', 2, '2026-07-16T00:00:02.000Z'),
      phaseStart('read-state', 0, '2026-07-16T00:00:00.000Z'),
      fsm('run', 'verify'),
    ];
    useDagStore.getState().processEvents(events);

    const edges = chainEdges();
    expect(edges).toHaveLength(3); // 4 phases → 3 chain edges

    const expected = [
      ['phase-cal-continuous-read-state', 'phase-cal-continuous-scan-reality'],
      ['phase-cal-continuous-scan-reality', 'phase-cal-continuous-improve'],
      ['phase-cal-continuous-improve', 'phase-cal-continuous-verify-build'],
    ];
    for (const [src, tgt] of expected) {
      const edge = edges.find((e) => e.source === src && e.target === tgt);
      expect(edge, `expected chain edge ${src} -> ${tgt}`).toBeDefined();
    }
  });

  it('loop badge reflects incremented run count after N iteration_start events', () => {
    const events = [
      iterationStart(),
      iterationStart(),
      iterationStart(),
      fsm('init', 'run'),
      phaseStart('read-state', 0, '2026-07-16T00:00:00.000Z'),
      phaseStart('improve', 1, '2026-07-16T00:00:01.000Z'),
      fsm('run', 'verify'),
    ];
    useDagStore.getState().processEvents(events);

    const loopNode = useDagStore.getState().dagNodes.find((n) => n.kind === 'loop');
    expect(loopNode).toBeDefined();
    expect(loopNode!.iteration).toBe(3); // 3 iteration_start → x3
  });

  it('produces finite positions (no NaN/Infinity) after many iterations', () => {
    // Simulate 50 iterations of a 2-phase plan, feeding events incrementally
    // like the live WS stream would.
    const store = useDagStore.getState();
    for (let iter = 1; iter <= 50; iter++) {
      store.processEvents([
        { type: 'iteration_start', data: { planName: plan, iteration: iter }, timestamp: new Date(iter * 1000).toISOString() },
        { type: 'fsm_transition', data: { planName: plan, iteration: iter, from: 'init', to: 'run', event: 'RUN' }, timestamp: new Date(iter * 1000).toISOString() },
        phaseStart('read-state', 0, new Date(iter * 1000 + 1).toISOString()),
        phaseStart('improve', 1, new Date(iter * 1000 + 2).toISOString()),
        { type: 'fsm_transition', data: { planName: plan, iteration: iter, from: 'run', to: 'verify', event: 'VERIFY' }, timestamp: new Date(iter * 1000 + 3).toISOString() },
      ]);
    }

    const phases = useDagStore.getState().dagNodes.filter((n) => n.kind === 'phase');
    for (const p of phases) {
      expect(p.order).toBeDefined();
      expect(Number.isFinite(p.order as number)).toBe(true);
    }
    // Exactly 2 canonical phase nodes (live mode collapses iterations).
    expect(phases).toHaveLength(2);

    const edges = chainEdges();
    expect(edges).toHaveLength(1); // read-state → improve
    expect(edges[0].source).toBe('phase-cal-continuous-read-state');
    expect(edges[0].target).toBe('phase-cal-continuous-improve');
  });
});
