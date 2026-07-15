// hooks/useDeepLink.ts — URL-driven deep-link support.
// Parses `?plan=<planName>&phase=<phaseName>` on load and syncs the
// store's selected node / plan name. Updates the URL via history.replaceState
// when the user clicks a node or changes selection, without a full page reload.

import { useEffect, useCallback, useRef } from 'react';
import { useDagStore } from '../stores/dag-store';

/**
 * Parse `plan` and `phase` from the current URL search params.
 */
function readDeepLink(): { plan: string | null; phase: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    plan: params.get('plan'),
    phase: params.get('phase'),
  };
}

/**
 * Update the browser URL with current deep-link params (no page reload).
 */
function writeDeepLink(plan: string | null, phase: string | null) {
  const url = new URL(window.location.href);
  if (plan) {
    url.searchParams.set('plan', plan);
  } else {
    url.searchParams.delete('plan');
  }
  if (phase) {
    url.searchParams.set('phase', phase);
  } else {
    url.searchParams.delete('phase');
  }
  window.history.replaceState(null, '', url.toString());
}

/**
 * Hook that syncs URL deep-link params with the dag-store.
 *
 * - On mount: reads `?plan` and `?phase` from the URL and sets store state.
 * - Subscribes to store changes: when `selectedPlanName` or `selectedNodeId`
 *   changes, updates the URL (without full page reload).
 *
 * Returns a `clearDeepLink` function to remove URL params.
 */
export function useDeepLink() {
  const selectedPlanName = useDagStore((s) => s.selectedPlanName);
  const selectedNodeId = useDagStore((s) => s.selectedNodeId);
  const dagNodes = useDagStore((s) => s.dagNodes);
  const setDeepLinkedPlan = useDagStore((s) => s.setDeepLinkedPlan);
  const setDeepLinkedPhase = useDagStore((s) => s.setDeepLinkedPhase);
  const replayMode = useDagStore((s) => s.replayMode);

  // Tracks whether we've applied the initial deep-link from URL params
  const initialApplied = useRef(false);

  // ── On mount: consume URL params ──────────────────────────────────────
  useEffect(() => {
    if (initialApplied.current) return;
    initialApplied.current = true;

    const { plan, phase } = readDeepLink();

    if (plan) {
      setDeepLinkedPlan(plan);
    }
    if (phase) {
      setDeepLinkedPhase(phase);
    }
  }, [setDeepLinkedPlan, setDeepLinkedPhase]);

  // ── Sync store → URL ─────────────────────────────────────────────────
  // When selectedPlanName or selectedNodeId changes and replay is active,
  // update the URL without a page reload.
  useEffect(() => {
    if (!replayMode && !selectedPlanName) return;

    // Find the node label for the selected node ID (used for deep-link phase)
    const selectedNode = dagNodes.find((n) => n.id === selectedNodeId);
    const phaseLabel = selectedNode?.label ?? null;

    writeDeepLink(selectedPlanName, phaseLabel);
  }, [selectedPlanName, selectedNodeId, replayMode]);

  const clearDeepLink = useCallback(() => {
    writeDeepLink(null, null);
    useDagStore.getState().clearDeepLink();
  }, []);

  return { clearDeepLink };
}
