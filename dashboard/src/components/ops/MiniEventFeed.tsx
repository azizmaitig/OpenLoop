import { useEventFeed } from '../../hooks/useLoopStream';
import { formatTime } from '../../lib/format';
import { Card } from '../ui';

const TYPE_COLOR: Record<string, string> = {
  state_change: 'var(--accent)',
  child_status_change: 'var(--pass)',
  task_event: 'var(--warn)',
  task_completed: 'var(--ok)',
};

export function MiniEventFeed({ limit = 8 }: { limit?: number }) {
  const events = useEventFeed();
  const recent = events.slice(0, limit);

  return (
    <Card title="Live Events">
      {recent.length === 0 ? (
        <div className="muted">awaiting events…</div>
      ) : (
        <div className="feed">
          {recent.map((ev, i) => (
            <div className="feed-row" key={`${ev.timestamp}-${i}`}>
              <span className="ts">{formatTime(ev.timestamp)}</span>
              <span className="type" style={{ color: TYPE_COLOR[ev.type] ?? 'var(--text-dim)' }}>
                {ev.type}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
