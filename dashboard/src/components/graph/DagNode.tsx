import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  GitBranch,
  Play,
  IterationCw,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import type { DagNodeData } from '../../lib/types';

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--warn)',
  completed: 'var(--ok)',
  failed: 'var(--crit)',
  queued: 'var(--text-dim)',
  cancelled: 'var(--crit)',
  paused: 'var(--accent)',
  idle: 'var(--text-dim)',
};

const KIND_ICON: Record<string, LucideIcon> = {
  phase: Play,
  task: GitBranch,
  loop: IterationCw,
  gate: Shield,
};

function DagNode({ data }: NodeProps) {
  const d = data as unknown as DagNodeData;
  const Icon = KIND_ICON[d.kind] ?? Play;
  const statusColor = STATUS_COLOR[d.status] ?? 'var(--text-dim)';
  const isRunning = d.status === 'running';

  return (
    <div className="dag-node">
      <Handle type="target" position={Position.Top} className="dag-handle" />

      <div className="dag-node-body">
        <div className="dag-node-header">
          <Icon size={14} className="dag-node-icon" />
          <span className="dag-node-label">{d.label}</span>
        </div>

        <div className="dag-node-status-row">
          <span
            className={`dag-pill ${isRunning ? 'dag-pulse' : ''}`}
            style={{
              '--pill-color': statusColor,
              background: `color-mix(in srgb, ${statusColor} 18%, transparent)`,
              color: statusColor,
              borderColor: `color-mix(in srgb, ${statusColor} 40%, transparent)`,
            } as React.CSSProperties}
          >
            <span
              className="dag-pill-dot"
              style={{ background: statusColor }}
            />
            {d.status}
          </span>
          {d.kind && <span className="dag-node-kind">{d.kind}</span>}
        </div>

        {d.command && <div className="dag-node-command">{d.command}</div>}

        {d.durationMs != null && (
          <div className="dag-node-meta">
            {d.durationMs < 1000
              ? `${Math.round(d.durationMs)}ms`
              : `${(d.durationMs / 1000).toFixed(1)}s`}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="dag-handle" />
    </div>
  );
}

export default memo(DagNode);
