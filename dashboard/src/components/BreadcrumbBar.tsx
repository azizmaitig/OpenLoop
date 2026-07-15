// components/BreadcrumbBar.tsx — Navigation breadcrumb for deep-linked DAG views.
// Shows "Plans > {planName} > phase: {phaseName}" and syncs with the store's
// selected plan/node. Only visible in replay mode or when deep-link params are active.

import { useMemo } from 'react';
import { useDagStore } from '../stores/dag-store';
import { StatusDot } from './ui';

export function BreadcrumbBar() {
  const selectedPlanName = useDagStore((s) => s.selectedPlanName);
  const selectedNodeId = useDagStore((s) => s.selectedNodeId);
  const dagNodes = useDagStore((s) => s.dagNodes);
  const replayMode = useDagStore((s) => s.replayMode);
  const deepLinkedPlan = useDagStore((s) => s.deepLinkedPlan);
  const deepLinkedPhase = useDagStore((s) => s.deepLinkedPhase);
  const setSelectedNode = useDagStore((s) => s.setSelectedNode);

  // Determine the phase name from the selected node
  const phaseLabel = useMemo(() => {
    if (!selectedNodeId) return deepLinkedPhase ?? null;
    const node = dagNodes.find((n) => n.id === selectedNodeId);
    return node?.label ?? null;
  }, [selectedNodeId, dagNodes, deepLinkedPhase]);

  // Only show when replay mode or deep-link is active
  const plan = selectedPlanName ?? deepLinkedPlan;
  const visible = replayMode && plan;

  if (!visible) {
    return null;
  }

  return (
    <div
      className="breadcrumb-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        fontSize: 13,
        color: 'var(--text-dim)',
      }}
    >
      <StatusDot status="dim" />
      <span style={{ color: 'var(--text-dim)' }}>Plans</span>
      <Chevron />
      <span
        style={{
          color: 'var(--text)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onClick={() => setSelectedNode(null)}
        title="Go to plan overview"
      >
        {plan}
      </span>
      {phaseLabel && (
        <>
          <Chevron />
          <span
            style={{
              color: 'var(--accent)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onClick={() => {
              // Find and select the node with this label
              const node = dagNodes.find((n) => n.label === phaseLabel);
              if (node) setSelectedNode(node.id);
            }}
            title="Scroll to phase"
          >
            phase: {phaseLabel}
          </span>
        </>
      )}
    </div>
  );
}

/** Small chevron separator. */
function Chevron() {
  return (
    <span style={{ color: 'var(--text-dim)', fontSize: 11, userSelect: 'none' }}>
      ▸
    </span>
  );
}
