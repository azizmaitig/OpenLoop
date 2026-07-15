import { memo } from 'react';
import { useDaemonState } from '../../hooks/useDaemonState';
import { Card, Skeleton } from '../ui';

export const QueueCard = memo(function QueueCard() {
  const { data, isPending } = useDaemonState();

  if (isPending || !data) {
    return (
      <Card title="Queue">
        <Skeleton height={60} />
      </Card>
    );
  }

  return (
    <Card title="Queue">
      <div className="value">{data.queueLength}</div>
      <div className="sub">
        {data.currentTask ? `running: ${data.currentTask.command?.slice(0, 32) ?? '…'}` : 'idle'}
      </div>
    </Card>
  );
});
