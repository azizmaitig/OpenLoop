import { useState } from 'react';
import { IndicatorsPanel } from '../components/diag/IndicatorsPanel';
import { EventFeed } from '../components/diag/EventFeed';
import { HistoryTable } from '../components/diag/HistoryTable';
import { CheckpointBar } from '../components/diag/CheckpointBar';
import { TaskDetailDrawer } from '../components/diag/TaskDetailDrawer';

export function DiagnosticScreen() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="grid grid-2">
        <IndicatorsPanel window="1h" />
        <EventFeed />
      </div>
      <div className="grid grid-2">
        <HistoryTable onSelect={setSelected} />
        <CheckpointBar />
      </div>
      <TaskDetailDrawer taskId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
