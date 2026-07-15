import { useDaemonState } from '../hooks/useDaemonState';
import { useStreamStore } from '../hooks/useLoopStream';
import { formatUptime } from '../lib/format';
import { Pill, StatusDot } from './ui';

export function TopBar() {
  const { data: state } = useDaemonState();
  const stream = useStreamStore();

  const statusTone =
    state?.status === 'running' ? 'ok' : state?.status === 'error' ? 'crit' : 'warn';

  return (
    <header className="topbar">
      <span className="brand">agent-loop · dashboard</span>
      {state ? (
        <Pill tone={statusTone}>{state.status}</Pill>
      ) : (
        <span className="muted">connecting…</span>
      )}
      {state && <span className="muted">uptime {formatUptime(state.uptime)}</span>}
      {state && <span className="muted">v{state.version}</span>}
      <span className="spacer" />
      <span className="row" title={stream.transport === 'ws' ? 'live websocket' : 'polling fallback'}>
        <StatusDot status={stream.connected ? 'ok' : stream.transport === 'poll' ? 'warn' : 'dim'} />
        <span className="muted">{stream.connected ? 'live' : stream.transport === 'poll' ? 'poll' : 'offline'}</span>
      </span>
    </header>
  );
}
