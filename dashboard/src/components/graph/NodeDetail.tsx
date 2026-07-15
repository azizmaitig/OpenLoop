// components/graph/NodeDetail.tsx — Shared node detail panel for the DAG graph.
// Replaces the duplicated node-detail rendering in DagScreen and ReplayPanel.

import type { DagNodeData } from '../../lib/types';
import { formatDuration, formatTime } from '../../lib/format';

/** Map a node's status to the CSS tone class used by pill and dot styles. */
export function statusToTone(status: string): string {
  if (status === 'running') return 'warn';
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'crit';
  return 'dim';
}

export function NodeDetail({ node, onClose, emptyMessage }: {
  node: DagNodeData | null;
  onClose: () => void;
  emptyMessage?: string;
}) {
  if (!node) {
    return (
      <div className="dag-detail-empty">
        <p className="muted">{emptyMessage ?? 'Click a node to inspect its details'}</p>
      </div>
    );
  }

  const tone = statusToTone(node.status);

  return (
    <>
      <div className="dag-detail-header">
        <h3>{node.label}</h3>
        <button className="dag-close-btn" onClick={onClose} title="Deselect">✕</button>
      </div>
      <div className="dag-detail-body">
        <div className="dag-detail-field">
          <span className="dag-detail-label">Status</span>
          <span className={`pill pill-${tone}`}>{node.status}</span>
        </div>
        <div className="dag-detail-field">
          <span className="dag-detail-label">Kind</span>
          <span className="muted">{node.kind}</span>
        </div>
        {node.iteration != null && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Iteration</span>
            <span className="muted">{node.iteration}</span>
          </div>
        )}
        {node.planName && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Plan</span>
            <span className="muted">{node.planName}</span>
          </div>
        )}
        {node.command && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Command</span>
            <code className="snippet">{node.command}</code>
          </div>
        )}
        {node.input && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Input</span>
            <code className="snippet">{node.input}</code>
          </div>
        )}
        {node.output && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Output</span>
            <code className="snippet">{node.output}</code>
          </div>
        )}
        {node.error && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Error</span>
            <code className="snippet" style={{ color: 'var(--crit)' }}>{node.error}</code>
          </div>
        )}
        <div className="dag-detail-grid">
          {node.startedAt && (
            <div className="dag-detail-field">
              <span className="dag-detail-label">Started</span>
              <span className="muted">{formatTime(node.startedAt)}</span>
            </div>
          )}
          {node.completedAt && (
            <div className="dag-detail-field">
              <span className="dag-detail-label">Completed</span>
              <span className="muted">{formatTime(node.completedAt)}</span>
            </div>
          )}
          {node.durationMs != null && (
            <div className="dag-detail-field">
              <span className="dag-detail-label">Duration</span>
              <span className="muted">{formatDuration(node.durationMs)}</span>
            </div>
          )}
        </div>
        {node.dependsOn && node.dependsOn.length > 0 && (
          <div className="dag-detail-field">
            <span className="dag-detail-label">Depends On</span>
            <ul className="dag-dep-list">
              {node.dependsOn.map((dep) => (
                <li key={dep}>{dep}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
