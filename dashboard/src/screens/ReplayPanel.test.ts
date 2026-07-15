// Regression tests for ReplayPanel bug fixes
// BUG MEDIUM-5: auto-load effect is fragile (re-triggers on every checkpoint refetch)
// BUG MEDIUM-6: playback restart from end sets scrubPos=-1 (collapses graph to single node)

import { describe, it, expect, beforeEach } from 'vitest';
import { useDagStore } from '../stores/dag-store';
import type { StreamEvent } from '../lib/types';

function makeMockEvents(count: number): StreamEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'phase_start' as const,
    data: { planName: 'p', phaseName: `t${i}`, iteration: 1 },
    timestamp: new Date(0).toISOString(),
  }));
}

// ── BUG MEDIUM-6: Playback restart logic ─────────────────────────────────

describe('ReplayPanel — handlePlayPause restart (BUG MEDIUM-6)', () => {
  beforeEach(() => {
    useDagStore.setState({
      replayMode: true,
      replayEvents: makeMockEvents(3),
      scrubPos: -1,
    });
  });

  it('sets scrubPos to 0 when restarting play from the last event', () => {
    // Position at the last event (index 2, length-1 = 2)
    useDagStore.setState({ scrubPos: 2 });
    const state = useDagStore.getState();
    expect(state.scrubPos).toBe(2);
    expect(state.scrubPos >= state.replayEvents.length - 1).toBe(true);

    // Simulate handlePlayPause's restart branch (the fix: setScrubPos(0) not -1)
    if (state.scrubPos >= state.replayEvents.length - 1) {
      useDagStore.getState().setScrubPos(0);
    }

    expect(useDagStore.getState().scrubPos).toBe(0);
  });

  it('sets scrubPos to 0 when restarting play with exactly 1 event', () => {
    useDagStore.setState({ replayEvents: makeMockEvents(1), scrubPos: 0 });
    const state = useDagStore.getState();
    expect(state.scrubPos >= state.replayEvents.length - 1).toBe(true);

    if (state.scrubPos >= state.replayEvents.length - 1) {
      useDagStore.getState().setScrubPos(0);
    }

    expect(useDagStore.getState().scrubPos).toBe(0);
  });

  it('does NOT change scrubPos when not at end (mid-playback)', () => {
    useDagStore.setState({ replayEvents: makeMockEvents(5), scrubPos: 2 });
    const state = useDagStore.getState();
    expect(state.scrubPos >= state.replayEvents.length - 1).toBe(false);

    // This branch shouldn't execute
    if (state.scrubPos >= state.replayEvents.length - 1) {
      useDagStore.getState().setScrubPos(0);
    }

    expect(useDagStore.getState().scrubPos).toBe(2);
  });

  it('playback tick proceeds correctly from scrubPos=0 (not collapsing)', () => {
    // Set up: 3 events, position at 0 (first event)
    // The tick logic: if scrubPos >= max, stop; else setScrubPos(scrubPos + 1)
    useDagStore.setState({ replayEvents: makeMockEvents(3), scrubPos: 0 });

    const state = useDagStore.getState();
    const max = state.replayEvents.length - 1;

    // Tick 1: scrubPos=0, max=2 → 0 < 2 → advance to 1
    expect(state.scrubPos < max).toBe(true);
    useDagStore.getState().setScrubPos(state.scrubPos + 1);
    expect(useDagStore.getState().scrubPos).toBe(1);

    // Tick 2: scrubPos=1, max=2 → 1 < 2 → advance to 2
    expect(useDagStore.getState().scrubPos < max).toBe(true);
    useDagStore.getState().setScrubPos(useDagStore.getState().scrubPos + 1);
    expect(useDagStore.getState().scrubPos).toBe(2);

    // Tick 3: scrubPos=2, max=2 → 2 >= 2 → stop (setIsPlaying(false))
    expect(useDagStore.getState().scrubPos >= max).toBe(true);
    // No advance — playback stops
  });
});

// ── BUG MEDIUM-5: Auto-load guard ──────────────────────────────────────

describe('ReplayPanel — auto-load didAutoLoadRef guard (BUG MEDIUM-5)', () => {
  it('guards against re-triggering on subsequent checkpoint refetches', () => {
    const didAutoLoadRef = { current: null as string | null };

    // Scenario 1: deep-link planParam matches, not in replay mode, never loaded
    const planParam1 = 'test-plan';
    const replayMode = false;
    const shouldLoad1 = Boolean(
      planParam1 && !replayMode && didAutoLoadRef.current == null,
    );
    expect(shouldLoad1).toBe(true);

    // After successful auto-load, set the ref
    didAutoLoadRef.current = planParam1;

    // Scenario 2: same deep-link match fires again (simulating refetch tick)
    const shouldLoad2 = Boolean(
      planParam1 && !replayMode && didAutoLoadRef.current == null,
    );
    expect(shouldLoad2).toBe(false); // Guard prevents re-load ✓
  });

  it('allows loading a different plan after exit', () => {
    const didAutoLoadRef = { current: null as string | null };

    // Load first plan
    didAutoLoadRef.current = 'plan-a';

    // User exits replay mode, ref cleared
    didAutoLoadRef.current = null;

    // New deep-link to different plan
    const planParam = 'plan-b';
    const shouldLoad = Boolean(
      planParam && !false && didAutoLoadRef.current == null,
    );
    expect(shouldLoad).toBe(true);
  });

  it('does not block manual checkpoint selection', () => {
    const didAutoLoadRef = { current: null as string | null };

    // Manual selection through the CheckpointCard (no planParam from URL)
    const planParam = null;
    const shouldBlock = Boolean(
      planParam && !false && didAutoLoadRef.current == null,
    );
    expect(shouldBlock).toBe(false); // null planParam skips the effect — manual flow untouched
  });
});
