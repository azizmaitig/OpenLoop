import { useMetrics } from '../../hooks/useMetrics';
import { useTimeSeries } from '../../hooks/useTimeSeries';
import { Card, Skeleton } from '../ui';
import { UPlotChart } from '../ops/LiveTimeSeriesStrip';
import { DEFAULT_WINDOW } from '../../lib/constants';

export function IndicatorsPanel({ window = DEFAULT_WINDOW }: { window?: string }) {
  const { data: metrics, isPending } = useMetrics();
  const throughput = useTimeSeries('throughput', window);
  const duration = useTimeSeries('durationP95', window);
  const passRate = useTimeSeries('passRate', window);

  return (
    <div className="stack">
      <Card title="Triggers">
        {isPending || !metrics ? (
          <Skeleton />
        ) : metrics.triggers.length === 0 ? (
          <div className="muted">no triggers configured</div>
        ) : (
          <table className="dt">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Fires</th>
                <th>Running</th>
                <th>Last fired</th>
              </tr>
            </thead>
            <tbody>
              {metrics.triggers.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.type}</td>
                  <td>{t.fireCount}</td>
                  <td>{t.running ? 'yes' : 'no'}</td>
                  <td>{t.lastFiredAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-2">
        <ChartCard label="Throughput" q={throughput} metric="throughput" />
        <ChartCard label="Duration p95 (ms)" q={duration} metric="durationP95" />
        <ChartCard label="Pass rate" q={passRate} metric="passRate" />
      </div>
    </div>
  );
}

function ChartCard({
  label,
  q,
  metric,
}: {
  label: string;
  q: ReturnType<typeof useTimeSeries>;
  metric: string;
}) {
  return (
    <Card title={label}>
      {q.isPending ? (
        <Skeleton height={150} />
      ) : !q.data || q.data.points.length === 0 ? (
        <div className="muted">no series data</div>
      ) : (
        <UPlotChart points={q.data.points} metric={metric} />
      )}
    </Card>
  );
}
