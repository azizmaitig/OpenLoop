import { memo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { useMetrics } from '../../hooks/useMetrics';
import { formatNumber } from '../../lib/format';
import { Card, Skeleton } from '../ui';

export const PassFailErrorDonut = memo(function PassFailErrorDonut() {
  const { data, isPending } = useMetrics();

  if (isPending || !data) {
    return (
      <Card title="Pass / Fail / Error">
        <Skeleton height={120} />
      </Card>
    );
  }

  const { passCount, failCount, errorCount } = data.taskMetrics;
  const total = passCount + failCount + errorCount;
  const pieData = [
    { name: 'pass', value: passCount, color: 'var(--pass)' },
    { name: 'fail', value: failCount, color: 'var(--fail)' },
    { name: 'error', value: errorCount, color: 'var(--error)' },
  ];

  return (
    <Card title="Pass / Fail / Error">
      {total === 0 ? (
        <div className="muted">no runs yet</div>
      ) : (
        <>
          <div style={{ height: 120 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" innerRadius={36} outerRadius={56} paddingAngle={2}>
                  {pieData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="row" style={{ gap: 12, justifyContent: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--pass)' }}>pass {formatNumber(passCount)}</span>
            <span style={{ color: 'var(--fail)' }}>fail {formatNumber(failCount)}</span>
            <span style={{ color: 'var(--error)' }}>error {formatNumber(errorCount)}</span>
          </div>
        </>
      )}
    </Card>
  );
});
