import { useMetrics } from '../hooks/useMetrics';
import { formatNumber } from '../lib/format';
import { Pill, Skeleton } from './ui';

export function BudgetBanner() {
  const { data, isPending } = useMetrics();

  if (isPending || !data) {
    return (
      <div className="card">
        <Skeleton />
      </div>
    );
  }

  const { budget } = data;
  const tone = budget.status === 'ok' ? 'ok' : budget.status === 'warning' ? 'warn' : 'crit';
  const remaining = budget.remaining < 0 ? 0 : budget.remaining;

  return (
    <div className="card row" style={{ justifyContent: 'space-between' }}>
      <div className="row">
        <Pill tone={tone}>budget {budget.status}</Pill>
        <span className="muted">
          {formatNumber(budget.runsToday)} / {formatNumber(budget.cap)} runs today
        </span>
      </div>
      <span className="muted">{formatNumber(remaining)} remaining</span>
    </div>
  );
}
