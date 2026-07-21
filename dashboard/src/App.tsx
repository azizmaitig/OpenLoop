import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoopStreamProvider } from './hooks/useLoopStream';
import { TopBar } from './components/TopBar';
import { TabNav, type ScreenId } from './components/TabNav';
import { GatePanel } from './components/GatePanel';
import { OpsHealthScreen } from './screens/OpsHealthScreen';
import { DiagnosticScreen } from './screens/DiagnosticScreen';
import { DagScreen } from './screens/DagScreen';
import { SpecsScreen } from './screens/SpecsScreen';
import { OrchestrationScreen } from './screens/OrchestrationScreen';
import { EvolveScreen } from './screens/EvolveScreen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  const [screen, setScreen] = useState<ScreenId>('ops');

  return (
    <QueryClientProvider client={queryClient}>
      <LoopStreamProvider>
        <div className="app-shell">
          <TopBar />
          <TabNav active={screen} onChange={setScreen} />
          <div className="gate-bar" style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 16px', background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
            <GatePanel />
          </div>
          <main className="app-main">
            {screen === 'ops' ? <OpsHealthScreen /> : screen === 'diag' ? <DiagnosticScreen /> : screen === 'dag' ? <DagScreen /> : screen === 'specs' ? <SpecsScreen /> : screen === 'orchestration' ? <OrchestrationScreen /> : <EvolveScreen />}
          </main>
        </div>
      </LoopStreamProvider>
    </QueryClientProvider>
  );
}
