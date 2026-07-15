import { PassFailErrorDonut } from './PassFailErrorDonut';
import { DurationCard } from './DurationCard';
import { ThroughputCard } from './ThroughputCard';
import { QueueCard } from './QueueCard';

export function MetricCardGrid() {
  return (
    <div className="grid grid-cards">
      <PassFailErrorDonut />
      <DurationCard />
      <ThroughputCard />
      <QueueCard />
    </div>
  );
}
