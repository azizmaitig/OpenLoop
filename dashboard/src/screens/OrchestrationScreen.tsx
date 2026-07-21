import { useState, useEffect, useCallback } from 'react';

interface DaemonState {
  status: string;
  queueLength: number;
  currentTask: { id: string; command: string; lifecycle: string } | null;
}

interface ChildLoop {
  id: string;
  name: string;
  status: string;
  planPath?: string;
  triggers?: { type: string; schedule?: string }[];
}

interface LoopEntry {
  id: string;
  label: string;
  port: number;
  planName: string;
  status: string;
  description: string;
}

const LOOPS: LoopEntry[] = [
  { id: 'l1', label: 'L1 — Spec Creator', port: 3001, planName: 'spec-creator', status: '?',
    description: 'Drafts new specs from ideas via speckit chain. Reads inbox, creates spec.md/plan.md/tasks.md.' },
  { id: 'l2', label: 'L2 — Spec Executor', port: 3002, planName: 'spec-executor', status: '?',
    description: 'Implements specs in a git worktree. Runs speckit.implement, verifies, stamps built.' },
  { id: 'l3', label: 'L3 — Spec Evolve', port: 3003, planName: 'spec-evolve', status: '?',
    description: 'Periodically proposes improvements to loop config. Human-in-the-loop review gate.' },
];

export function OrchestrationScreen() {
  const [state, setState] = useState<DaemonState | null>(null);
  const [loops, setLoops] = useState<ChildLoop[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      fetch('/state').then((r) => r.json()).catch(() => null),
      fetch('/loops').then((r) => r.json()).catch(() => []),
    ]).then(([stateResult, loopsResult]) => {
      if (stateResult.status === 'fulfilled') setState(stateResult.value);
      if (loopsResult.status === 'fulfilled') setLoops(loopsResult.value ?? []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const daemonStatus = state?.status ?? 'unknown';
  const daemonColor = daemonStatus === 'running' ? 'var(--ok)' : daemonStatus === 'paused' ? 'var(--warn)' : 'var(--crit)';

  return (
    <div className="stack">
      <div className="refresh-bar">
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Daemon: <span style={{ color: daemonColor }}>{daemonStatus}</span>
          {state ? ` | queue: ${state.queueLength}` : ''}
        </span>
        <button className="pagebtn" onClick={fetchData} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {LOOPS.map((loop) => (
        <div key={loop.id} className="card orchestration-card">
          <div className="orchestration-header">
            <span className="orchestration-label">{loop.label}</span>
            <span style={{ color: daemonColor }}>{state ? 'daemon running' : 'unknown'}</span>
          </div>
          <p className="sub" style={{ margin: '4px 0 8px' }}>{loop.description}</p>
          <div className="orchestration-detail">
            <span>Port: {loop.port}</span>
            <span>Plan: {loop.planName}</span>
            <span>{loops.find((c) => c.id === loop.id) ? 'child registered' : 'no child'}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
