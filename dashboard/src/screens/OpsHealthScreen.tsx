import { HealthScoreCard } from '../components/ops/HealthScoreCard';
import { MetricCardGrid } from '../components/ops/MetricCardGrid';
import { LiveTimeSeriesStrip } from '../components/ops/LiveTimeSeriesStrip';
import { ActiveLoopsPanel } from '../components/ops/ActiveLoopsPanel';
import { MiniEventFeed } from '../components/ops/MiniEventFeed';
import { BudgetBanner } from '../components/BudgetBanner';

export function OpsHealthScreen() {
  return (
    <div className="stack">
      <BudgetBanner />
      <div className="grid grid-2">
        <HealthScoreCard />
        <MetricCardGrid />
      </div>
      <LiveTimeSeriesStrip window="1h" />
      <div className="grid grid-2">
        <ActiveLoopsPanel />
        <MiniEventFeed />
      </div>
    </div>
  );
}
