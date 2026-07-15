import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEventFeed } from '../../hooks/useLoopStream';
import { formatTime } from '../../lib/format';
import { Card } from '../ui';
import type { StreamEventType } from '../../lib/types';

const ALL_TYPES: StreamEventType[] = [
  'state_change',
  'child_status_change',
  'task_event',
  'task_completed',
  'phase_start',
  'phase_complete',
  'task_started',
  'task_failed',
  'fsm_transition',
  'iteration_start',
  'iteration_complete',
];

const TYPE_COLOR: Record<string, string> = {
  state_change: 'var(--accent)',
  child_status_change: 'var(--pass)',
  task_event: 'var(--warn)',
  task_completed: 'var(--ok)',
  phase_start: 'var(--accent)',
  phase_complete: 'var(--ok)',
  task_started: 'var(--warn)',
  task_failed: 'var(--crit)',
  fsm_transition: 'var(--pass)',
  iteration_start: 'var(--accent)',
  iteration_complete: 'var(--ok)',
};

const ROW_HEIGHT = 26;

export function EventFeed() {
  const events = useEventFeed();
  const [active, setActive] = useState<Set<StreamEventType>>(new Set(ALL_TYPES));
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => events.filter((e) => active.has(e.type as StreamEventType)),
    [events, active],
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggle = (t: StreamEventType) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <Card title="Event Feed (live)">
      <div className="filterbar">
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            className={active.has(t) ? 'active' : ''}
            onClick={() => toggle(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className="feed-scroll" style={{ height: 420 }}>
        {filtered.length === 0 ? (
          <div className="muted">no events match filter</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const ev = filtered[vi.index];
              return (
                <div
                  key={`${ev.timestamp}-${vi.index}`}
                  className="feed-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span className="ts">{formatTime(ev.timestamp)}</span>
                  <span className="type" style={{ color: TYPE_COLOR[ev.type] ?? 'var(--text-dim)' }}>
                    {ev.type}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
