// screens/ReplayPanel.tsx — Checkpoint replay mode for the DAG graph.
// Loads checkpoint data from the server, converts to synthetic StreamEvent[],
// and allows scrubbing through events via a timeline slider + playback controls.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useQuery } from '@tanstack/react-query';
import { fetchCheckpoints, fetchCheckpoint } from '../lib/api';
import { useDagStore } from '../stores/dag-store';
import { WorkflowGraph } from '../components/graph/WorkflowGraph';
import { formatTime } from '../lib/format';
import { Pill, Skeleton, StatusDot } from '../components/ui';
import type { CheckpointSummary } from '../lib/types';
import { BASE_INTERVAL_MS } from '../lib/constants';
import { NodeDetail } from '../components/graph/NodeDetail';

/** Playback speed multiplier */
type PlaybackSpeed = 0.5 | 1 | 2 | 5;

export function ReplayPanel() {
  // Store
  const replayMode = useDagStore((s) => s.replayMode);
  const selectedPlanName = useDagStore((s) => s.selectedPlanName);
  const replayEvents = useDagStore((s) => s.replayEvents);
  const scrubPos = useDagStore((s) => s.scrubPos);
  const dagNodes = useDagStore((s) => s.dagNodes);
  const enterReplayMode = useDagStore((s) => s.enterReplayMode);
  const exitReplayMode = useDagStore((s) => s.exitReplayMode);
  const setScrubPos = useDagStore((s) => s.setScrubPos);
  const loadCheckpoint = useDagStore((s) => s.loadCheckpoint);
  const selectReplayPlan = useDagStore((s) => s.selectReplayPlan);
  const setSelectedNode = useDagStore((s) => s.setSelectedNode);
  const selectedNodeId = useDagStore((s) => s.selectedNodeId);

  // Local state
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  // Playback timer ref
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Guards auto-load effect from re-triggering on checkpoint refetch
  const didAutoLoadRef = useRef<string | null>(null);

  // ── Load a specific checkpoint ─────────────────────────────────────────
  const handleLoadCheckpoint = useCallback(async (planName: string) => {
    setLoading(true);
    setError(null);
    setSelectedCheckpoint(planName);

    try {
      const cp = await fetchCheckpoint(planName);
      if (!cp) {
        setError(`Checkpoint "${planName}" not found`);
        setLoading(false);
        return;
      }

      // Enter replay mode
      enterReplayMode();
      selectReplayPlan(cp.planName);

      // Generate synthetic events and load into store
      loadCheckpoint(cp);

      // Show all events initially
      setScrubPos(-1);

      setLoading(false);
    } catch (err) {
      setError(`Failed to load checkpoint: ${String(err)}`);
      setLoading(false);
    }
  }, [enterReplayMode, selectReplayPlan, loadCheckpoint, setScrubPos]);

  // ── Fetch checkpoint list ───────────────────────────────────────────────
  const { data: checkpointsData, isPending: cpPending } = useQuery({
    queryKey: ['checkpoints'],
    queryFn: fetchCheckpoints,
    refetchInterval: 10_000,
  });

  const checkpoints = useMemo(
    () => checkpointsData?.checkpoints ?? [],
    [checkpointsData],
  );

  // ── Auto-load from deep-link ────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planParam = params.get('plan');
    if (planParam && checkpoints.length > 0 && !replayMode && didAutoLoadRef.current == null) {
      const match = checkpoints.find((cp) => cp.planName === planParam);
      if (match) {
        didAutoLoadRef.current = planParam;
        handleLoadCheckpoint(match.planName);
      }
    }
  }, [checkpoints, replayMode, handleLoadCheckpoint]);

  // ── Exit replay ─────────────────────────────────────────────────────────
  const handleExit = useCallback(() => {
    setIsPlaying(false);
    exitReplayMode();
    setSelectedCheckpoint(null);
    setError(null);
  }, [exitReplayMode]);

  // ── Playback controls ──────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      // If at end, restart
      const state = useDagStore.getState();
      if (state.scrubPos >= state.replayEvents.length - 1) {
        setScrubPos(0);
      }
      setIsPlaying(true);
    }
  }, [isPlaying, setScrubPos]);

  const handleStepForward = useCallback(() => {
    const state = useDagStore.getState();
    const max = state.replayEvents.length - 1;
    const next = Math.min(state.scrubPos + 1, max);
    setScrubPos(next);
  }, [setScrubPos]);

  const handleStepBack = useCallback(() => {
    const state = useDagStore.getState();
    const prev = Math.max(state.scrubPos - 1, -1);
    setScrubPos(prev);
  }, [setScrubPos]);

  const handleSpeedChange = useCallback((newSpeed: PlaybackSpeed) => {
    setSpeed(newSpeed);
  }, []);

  // ── Playback tick ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.round(BASE_INTERVAL_MS / speed); // base 800ms per event

    playTimerRef.current = setInterval(() => {
      const state = useDagStore.getState();
      const max = state.replayEvents.length - 1;

      if (state.scrubPos >= max) {
        setIsPlaying(false);
        return;
      }

      setScrubPos(state.scrubPos + 1);
    }, intervalMs);

    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, speed, setScrubPos]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
      }
    };
  }, []);

  // ── Selected node detail ───────────────────────────────────────────────
  const selectedNode = useMemo(
    () => dagNodes.find((n) => n.id === selectedNodeId) ?? null,
    [dagNodes, selectedNodeId],
  );

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="dag-screen">
      {!replayMode ? (
        // ── Checkpoint list (pick a checkpoint to replay) ──────────────
        <div className="stack" style={{ height: '100%', overflow: 'auto' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Checkpoint Replay</h3>
          </div>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            Select a saved checkpoint to replay its execution in the DAG graph.
          </p>

          {cpPending ? (
            <div className="stack">
              <Skeleton height={48} />
              <Skeleton height={48} />
              <Skeleton height={48} />
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="dag-empty">
              <div className="dag-empty-icon">📋</div>
              <h3>No checkpoints found</h3>
              <p className="muted">
                No checkpoint files were found on the server. Run a plan to generate checkpoints.
              </p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {checkpoints.map((cp: CheckpointSummary) => (
                <CheckpointCard
                  key={cp.planName}
                  cp={cp}
                  selected={selectedCheckpoint === cp.planName}
                  loading={loading && selectedCheckpoint === cp.planName}
                  onSelect={() => handleLoadCheckpoint(cp.planName)}
                />
              ))}
            </div>
          )}

          {error && (
            <div className="card" style={{ borderColor: 'var(--crit)' }}>
              <p style={{ color: 'var(--crit)', margin: 0 }}>{error}</p>
            </div>
          )}
        </div>
      ) : (
        // ── Replay active: graph + timeline + detail ───────────────────
        <div className="stack" style={{ height: '100%', gap: 0 }}>
          {/* Top bar: plan name + exit button */}
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              padding: '8px 0',
              borderBottom: '1px solid var(--border)',
              marginBottom: 8,
            }}
          >
            <div className="row">
              <Pill tone="dim">replay</Pill>
              <span style={{ fontWeight: 600 }}>
                {selectedPlanName ?? 'Unknown plan'}
              </span>
              <span className="muted">
                {scrubPos === -1
                  ? `${replayEvents.length} events`
                  : `event ${scrubPos + 1} / ${replayEvents.length}`}
              </span>
            </div>
            <button className="pagebtn" onClick={handleExit}>
              Exit Replay
            </button>
          </div>

          {/* Main content: graph + detail */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <PanelGroup direction="horizontal" autoSaveId="replay-layout">
              <Panel defaultSize={70} minSize={40}>
                <div className="dag-canvas">
                  {dagNodes.length === 0 ? (
                    <div className="dag-empty">
                      <p className="muted">No nodes to display at this scrub position.</p>
                    </div>
                  ) : (
                    <WorkflowGraph />
                  )}
                </div>
              </Panel>

              <PanelResizeHandle className="dag-resize-handle" />

              <Panel defaultSize={30} minSize={20}>
                <div className="dag-detail">
                  <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
                </div>
              </Panel>
            </PanelGroup>
          </div>

          {/* Timeline scrubber */}
          <div
            className="replay-timeline"
            style={{
              borderTop: '1px solid var(--border)',
              padding: '10px 12px',
              background: 'var(--bg-elev)',
            }}
          >
            {/* Playback controls */}
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className="pagebtn"
                  onClick={handleStepBack}
                  title="Step backward"
                  disabled={scrubPos <= -1}
                >
                  ⏮
                </button>
                <button
                  className="pagebtn"
                  onClick={handlePlayPause}
                  title={isPlaying ? 'Pause' : 'Play'}
                  style={{ minWidth: 40 }}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <button
                  className="pagebtn"
                  onClick={handleStepForward}
                  title="Step forward"
                  disabled={scrubPos >= replayEvents.length - 1}
                >
                  ⏭
                </button>
              </div>

              <div className="row" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>Speed:</span>
                {([0.5, 1, 2, 5] as PlaybackSpeed[]).map((s) => (
                  <button
                    key={s}
                    className={`pagebtn ${speed === s ? 'active' : ''}`}
                    onClick={() => handleSpeedChange(s)}
                    style={speed === s ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>

            {/* Range slider */}
            <div className="row" style={{ gap: 10 }}>
              <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', minWidth: 40 }}>
                {scrubPos === -1 ? 'Start' : `#${scrubPos + 1}`}
              </span>
              <input
                type="range"
                min={-1}
                max={Math.max(0, replayEvents.length - 1)}
                value={scrubPos}
                onChange={(e) => {
                  setIsPlaying(false);
                  setScrubPos(Number(e.target.value));
                }}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
                aria-label="Timeline scrubber"
              />
              <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', minWidth: 40 }}>
                {replayEvents.length === 0 ? '0' : `#${replayEvents.length}`}
              </span>
            </div>

            {/* Event type legend */}
            <div className="row" style={{ gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
              {replayEvents.length > 0 && (
                <span className="muted" style={{ fontSize: 11 }}>
                  Current event:{' '}
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                    {scrubPos >= 0 && scrubPos < replayEvents.length
                      ? replayEvents[scrubPos]?.type
                      : '—'}
                  </span>
                  {scrubPos >= 0 && scrubPos < replayEvents.length && replayEvents[scrubPos]?.timestamp && (
                    <span style={{ marginLeft: 8 }}>
                      @ {formatTime(replayEvents[scrubPos].timestamp)}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small card for a single checkpoint in the list. */
function CheckpointCard({
  cp,
  selected,
  loading,
  onSelect,
}: {
  cp: CheckpointSummary;
  selected: boolean;
  loading: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className="card"
      onClick={onSelect}
      disabled={loading}
      style={{
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        border: selected ? '1px solid var(--accent)' : undefined,
        opacity: loading ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{cp.planName}</span>
        {loading && <StatusDot status="warn" />}
      </div>
      <div className="row" style={{ gap: 16, fontSize: 12 }}>
        <span className="muted">{cp.taskCount} tasks</span>
        <span className="muted">
          started {cp.startedAt ? formatTime(cp.startedAt) : '—'}
        </span>
      </div>
      {cp.updatedAt && (
        <span className="muted" style={{ fontSize: 11 }}>
          updated {new Date(cp.updatedAt).toLocaleString()}
        </span>
      )}
    </button>
  );
}
