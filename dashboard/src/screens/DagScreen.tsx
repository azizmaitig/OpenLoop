// screens/DagScreen.tsx — 3-pane resizable DAG visualization screen.
// Supports two modes:
//   - Live:  processes WS events in real-time from useEventFeed()
//   - Replay: loads checkpoint data from the server and scrubs through events
//
// EXTENDED: Live/Replay toggle, BreadcrumbBar for deep-link navigation,
// GatePanel integration.

import { useEffect, useRef, useMemo, useState } from 'react';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useEventFeed } from '../hooks/useLoopStream';
import { useDagStore } from '../stores/dag-store';
import { useDeepLink } from '../hooks/useDeepLink';
import { WorkflowGraph } from '../components/graph/WorkflowGraph';
import { BreadcrumbBar } from '../components/BreadcrumbBar';
import { ReplayPanel } from './ReplayPanel';
import { NodeDetail } from '../components/graph/NodeDetail';

export function DagScreen() {
  const events = useEventFeed();
  const processEvents = useDagStore((s) => s.processEvents);
  const selectedNodeId = useDagStore((s) => s.selectedNodeId);
  const setSelectedNode = useDagStore((s) => s.setSelectedNode);
  const dagNodes = useDagStore((s) => s.dagNodes);
  const reset = useDagStore((s) => s.reset);
  const [showCheckpointPicker, setShowCheckpointPicker] = useState(false);

  // Replay mode state
  const replayMode = useDagStore((s) => s.replayMode);

  // Deep-link hook
  useDeepLink();

  // Track event high-water mark via seq so the DAG keeps processing even
  // after the capped events[] saturates at EVENT_CAP (500).
  const processedSeqRef = useRef(-1);

  // Only process WS events when NOT in replay mode
  useEffect(() => {
    if (replayMode) return;

    const fresh = events.filter((e) => (e.seq ?? 0) > processedSeqRef.current);
    if (fresh.length > 0) {
      // fresh is newest-first (events[] order). Reverse to chronological.
      processEvents(fresh.slice().reverse());
      processedSeqRef.current = Math.max(
        ...events.map((e) => e.seq ?? 0),
        processedSeqRef.current,
      );
    }
  }, [events, processEvents, replayMode]);

  // Reset store when events array empties (connection reset), but not in replay
  useEffect(() => {
    if (replayMode) return;
    if (events.length === 0 && processedSeqRef.current >= 0) {
      reset();
      processedSeqRef.current = -1;
    }
  }, [events.length, reset, replayMode]);

  // Reset processedSeqRef when entering/exiting replay
  useEffect(() => {
    if (!replayMode) {
      processedSeqRef.current =
        events.length > 0
          ? Math.max(...events.map((e) => e.seq ?? 0))
          : -1;
    }
  }, [replayMode, events.length]);

  const selectedNode = useMemo(
    () => dagNodes.find((n) => n.id === selectedNodeId) ?? null,
    [dagNodes, selectedNodeId],
  );

  // ── Replay mode: render ReplayPanel (self-contained) ─────────────────
  if (replayMode) {
    return (
      <div className="dag-screen">
        <BreadcrumbBar />
        <ReplayPanel />
      </div>
    );
  }

  // ── Live mode: existing layout ────────────────────────────────────────
  return (
    <div className="dag-screen">
      <BreadcrumbBar />

      {dagNodes.length === 0 && !showCheckpointPicker ? (
        <div className="dag-empty">
          <div className="dag-empty-icon">⊞</div>
          <h3>No DAG data yet</h3>
          <p className="muted">
            Waiting for phase and task events from the agent-loop daemon.
            Open the daemon and run a task to see the execution graph.
          </p>
          <button
            className="pagebtn"
            style={{ marginTop: 12, padding: '6px 16px' }}
            onClick={() => setShowCheckpointPicker(true)}
          >
            Load Checkpoint Replay
          </button>
        </div>
      ) : showCheckpointPicker && dagNodes.length === 0 ? (
        <ReplayPanel />
      ) : (
        <PanelGroup direction="horizontal" autoSaveId="dag-layout">
          {/* Left / center: main graph canvas */}
          <Panel defaultSize={70} minSize={40}>
            <div className="dag-canvas">
              <WorkflowGraph />
            </div>
          </Panel>

          <PanelResizeHandle className="dag-resize-handle" />

          {/* Right: node detail panel */}
          <Panel defaultSize={30} minSize={20}>
            <div className="dag-detail">
              <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
            </div>
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
}
