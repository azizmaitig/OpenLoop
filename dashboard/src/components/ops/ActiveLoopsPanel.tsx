import { useLoops } from '../../hooks/useLoops';
import { Card, Pill, Skeleton } from '../ui';
import type { ChildLoopStatus } from '../../lib/types';

function statusTone(s: ChildLoopStatus): 'ok' | 'warn' | 'crit' | 'dim' {
  return s === 'running' ? 'ok' : s === 'error' ? 'crit' : 'dim';
}

export function ActiveLoopsPanel() {
  const { data, isPending } = useLoops();

  return (
    <Card title="Active Loops">
      {isPending ? (
        <Skeleton />
      ) : !data || data.length === 0 ? (
        <div className="muted">no child loops registered</div>
      ) : (
        <table className="dt">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>Triggers</th>
            </tr>
          </thead>
          <tbody>
            {data.map((loop) => (
              <tr key={loop.id}>
                <td>{loop.name}</td>
                <td>
                  <Pill tone={statusTone(loop.status)}>{loop.status}</Pill>
                </td>
                <td>{loop.enabled ? 'yes' : 'no'}</td>
                <td>{loop.triggerCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
