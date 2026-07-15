import { useCheckpoint } from '../../hooks/useCheckpoint';
import { Card, Skeleton, StatusDot } from '../ui';

export function CheckpointBar({ planPath }: { planPath?: string }) {
  const { data, isPending } = useCheckpoint(planPath);

  return (
    <Card title="Checkpoint Progress">
      {isPending ? (
        <Skeleton />
      ) : !data ? (
        <div className="muted">no checkpoint for this plan</div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{data.planName}</span>
            <span>
              {data.completedTaskIds.length} done
              {data.inProgressTaskId ? ' · 1 in progress' : ''}
            </span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${
                  data.completedTaskIds.length === 0 && !data.inProgressTaskId
                    ? 0
                    : Math.round(
                        (data.completedTaskIds.length /
                          (data.completedTaskIds.length + (data.inProgressTaskId ? 1 : 0))) *
                          100,
                      )
                }%`,
              }}
            />
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {data.completedTaskIds.map((id) => (
              <span key={id} className="row" style={{ fontSize: 12 }}>
                <StatusDot status="ok" />
                {id.slice(0, 6)}
              </span>
            ))}
            {data.inProgressTaskId && (
              <span className="row" style={{ fontSize: 12 }}>
                <StatusDot status="warn" />
                {data.inProgressTaskId.slice(0, 6)}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
