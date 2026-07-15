import { useTask } from '../../hooks/useTask';
import { useCheckpoint } from '../../hooks/useCheckpoint';
import { formatDuration, formatTime } from '../../lib/format';
import { Card, Skeleton, StatusDot } from '../ui';

export function TaskDetailDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null;
  onClose: () => void;
}) {
  const { data, isPending, isError } = useTask(taskId);
  const { data: checkpoint } = useCheckpoint();

  if (!taskId) return null;

  const inCheckpoint =
    checkpoint &&
    (checkpoint.completedTaskIds.includes(taskId) || checkpoint.inProgressTaskId === taskId);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="task detail">
        <button className="close" onClick={onClose} aria-label="close">
          ×
        </button>
        <h2>Task {taskId.slice(0, 8)}</h2>

        {isPending ? (
          <Skeleton height={120} />
        ) : isError || !data ? (
          <div className="muted">failed to load task</div>
        ) : (
          <div className="stack">
            <div>
              <div className="muted">command</div>
              <code>{data.task.command}</code>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <span>
                <span className="muted">status </span>
                {data.task.lifecycle}
              </span>
              <span>
                <span className="muted">exit </span>
                {data.task.result?.exitCode ?? '—'}
              </span>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <span>
                <span className="muted">created </span>
                {formatTime(data.task.createdAt)}
              </span>
              <span>
                <span className="muted">completed </span>
                {formatTime(data.task.completedAt)}
              </span>
            </div>
            {data.task.result && (
              <div>
                <span className="muted">duration </span>
                {formatDuration(data.task.result.durationMs)}
              </div>
            )}

            {inCheckpoint && (
              <div className="row">
                <StatusDot status={checkpoint!.completedTaskIds.includes(taskId) ? 'ok' : 'warn'} />
                <span className="muted">
                  {checkpoint!.completedTaskIds.includes(taskId) ? 'in checkpoint (completed)' : 'checkpoint in progress'}
                </span>
              </div>
            )}

            <div>
              <h3 style={{ margin: '8px 0 6px' }}>Phases ({data.phases.length})</h3>
              {data.phases.length === 0 ? (
                <div className="muted">no phase data</div>
              ) : (
                data.phases.map((p, i) => (
                  <Card key={i} title={p.name} className="stack" >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="muted">exit {p.exitCode}</span>
                      <span>{formatDuration(p.durationMs)}</span>
                    </div>
                    {p.stdout && (
                      <pre className="snippet">{p.stdout.slice(0, 400)}</pre>
                    )}
                    {p.stderr && (
                      <pre className="snippet" style={{ color: 'var(--fail)' }}>
                        {p.stderr.slice(0, 400)}
                      </pre>
                    )}
                  </Card>
                ))
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
