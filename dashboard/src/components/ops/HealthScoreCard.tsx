import { RadialBar, RadialBarChart, ResponsiveContainer } from 'recharts';
import { useHealthScore } from '../../hooks/useHealthScore';
import { formatPercent } from '../../lib/format';
import { Card, Skeleton } from '../ui';

function gradeTone(grade: string): 'ok' | 'warn' | 'crit' {
  return grade === 'healthy' ? 'ok' : grade === 'degraded' ? 'warn' : 'crit';
}

export function HealthScoreCard() {
  const { data, isPending } = useHealthScore();

  if (isPending) {
    return (
      <Card title="Health Score">
        <Skeleton height={120} />
      </Card>
    );
  }

  // Endpoints 404 until backend lands — degrade, don't crash (design §0.5).
  if (!data) {
    return (
      <Card title="Health Score">
        <div className="muted">health-score endpoint unavailable</div>
      </Card>
    );
  }

  const { score, grade, components } = data;
  const tone = gradeTone(grade);
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--crit)';
  const barData = [{ name: 'score', value: score, fill: color }];

  return (
    <Card title="Health Score">
      <div style={{ position: 'relative', height: 130 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="72%"
            outerRadius="100%"
            data={barData}
            startAngle={210}
            endAngle={-30}
          >
            <RadialBar background dataKey="value" cornerRadius={8} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ fontSize: 30, fontWeight: 700 }}>{score}</div>
          <div style={{ color, fontWeight: 600, textTransform: 'capitalize' }}>{grade}</div>
        </div>
      </div>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        <Bar label="pass rate" value={formatPercent(components.passRate)} />
        <Bar label="error rate" value={formatPercent(components.errorRate)} />
        <Bar label="budget" value={formatPercent(components.budget)} />
        <Bar label="queue depth" value={formatPercent(components.queueDepth)} />
      </div>
    </Card>
  );
}

function Bar({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}
