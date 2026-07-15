import { memo } from 'react';
import { useMetrics } from '../../hooks/useMetrics';
import { formatRate } from '../../lib/format';
import { Card, Skeleton } from '../ui';

export const ThroughputCard = memo(function ThroughputCard() {
  const { data, isPending } = useMetrics();

  if (isPending || !data) {
    return (
      <Card title="Throughput">
        <Skeleton height={60} />
      </Card>
    );
  }

  const { throughputTasksPerMin, throughputWindowMinutes } = data.taskMetrics;

  return (
    <Card title="Throughput">
      <div className="value">{formatRate(throughputTasksPerMin)}</div>
      <div className="sub">over last {throughputWindowMinutes}m window</div>
    </Card>
  );
});
