import { memo } from 'react';
import { useMetrics } from '../../hooks/useMetrics';
import { formatDuration } from '../../lib/format';
import { Card, Skeleton } from '../ui';

export const DurationCard = memo(function DurationCard() {
  const { data, isPending } = useMetrics();

  if (isPending || !data) {
    return (
      <Card title="Duration">
        <Skeleton height={60} />
      </Card>
    );
  }

  const { p50DurationMs, p95DurationMs, avgDurationMs } = data.taskMetrics;

  return (
    <Card title="Duration (p50 / p95 / avg)">
      <div className="value">{formatDuration(p95DurationMs)}</div>
      <div className="sub">
        p50 {formatDuration(p50DurationMs)} · avg {formatDuration(avgDurationMs)}
      </div>
    </Card>
  );
});
