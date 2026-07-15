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
