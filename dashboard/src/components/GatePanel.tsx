// components/GatePanel.tsx — Gate/pause control panel.
// Shows current pause state (Paused / Running) with a toggle button,
// guard status indicator, and number of tasks in queue.
// Reads from the WS daemon state and POSTs to /api/pause on toggle.

import { useState, useCallback } from 'react';
import { useStreamStore } from '../hooks/useLoopStream';
import { setPause } from '../lib/api';
import { useDagStore } from '../stores/dag-store';
import { Pill } from './ui';

export function GatePanel() {
  // Read daemon state from WS stream
  const stream = useStreamStore();
  const daemonStatus = stream.state?.status ?? 'idle';
  const isPaused = stream.state?.isPaused ?? false;
  const queueLength = stream.state?.queueLength ?? 0;

  // Local toggle loading state
  const [toggling, setToggling] = useState(false);

  const handleTogglePause = useCallback(async () => {
    setToggling(true);
    try {
      const currentPaused = stream.state?.isPaused ?? false;
      const next = !currentPaused;
      await setPause(next);
      useDagStore.getState().setPaused(next);
    } catch (err) {
      console.error('Failed to toggle pause:', err);
    } finally {
      setToggling(false);
    }
  }, [stream.state?.isPaused]);

  // Determine guard status
  const guardStatus = daemonStatus === 'error' ? 'crit' : isPaused ? 'warn' : 'ok';
  const guardLabel = daemonStatus === 'error' ? 'error' : isPaused ? 'paused' : 'running';

  return (
    <div
      className="gate-panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 12px',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        fontSize: 13,
      }}
    >
      {/* Status indicator */}
      <Pill tone={guardStatus as 'ok' | 'warn' | 'crit'}>
        {guardLabel}
      </Pill>

      {/* Queue length */}
      {queueLength > 0 && (
        <span className="muted" style={{ fontSize: 12 }}>
          {queueLength} queued
        </span>
      )}

      {/* Toggle button */}
      <button
        className="pagebtn"
        onClick={handleTogglePause}
        disabled={toggling || daemonStatus === 'error'}
        style={{
          fontSize: 12,
          padding: '3px 10px',
          borderColor: isPaused ? 'var(--ok)' : 'var(--warn)',
          color: isPaused ? 'var(--ok)' : 'var(--warn)',
        }}
        title={isPaused ? 'Resume daemon' : 'Pause daemon'}
      >
        {toggling ? '…' : isPaused ? '▶ Resume' : '⏸ Pause'}
      </button>
    </div>
  );
}
