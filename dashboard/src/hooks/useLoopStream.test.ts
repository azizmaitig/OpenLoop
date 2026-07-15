import { describe, it, expect } from 'vitest';
import { assignSeq } from './useLoopStream';
import type { StreamEvent } from '../lib/types';

function makeEvent(overrides?: Partial<StreamEvent>): StreamEvent {
  return {
    type: 'phase_start',
    data: { planName: 't', phaseName: 'p', iteration: 1 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('assignSeq', () => {
  it('assigns monotonic sequence numbers from 0', () => {
    const counter = { current: 0 };
    const events = [makeEvent(), makeEvent(), makeEvent()];
    assignSeq(events, counter);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
    expect(events[2].seq).toBe(2);
    expect(counter.current).toBe(3);
  });

  it('continues from existing counter value', () => {
    const counter = { current: 500 };
    const events = [makeEvent()];
    assignSeq(events, counter);
    expect(events[0].seq).toBe(500);
    expect(counter.current).toBe(501);
  });

  it('handles empty array', () => {
    const counter = { current: 42 };
    assignSeq([], counter);
    expect(counter.current).toBe(42);
  });
});

describe('DagScreen seq-based filtering (regression for CRITICAL-1)', () => {
  it('picks up new events past the 500-cap using monotonic seq', () => {
    // Simulate flush() assigning seq to 600 events
    const counter = { current: 0 };
    const all: StreamEvent[] = [];
    for (let i = 0; i < 600; i++) {
      all.push(makeEvent({ data: { planName: 't', phaseName: `p${i}`, iteration: 1 } }));
    }
    assignSeq(all, counter);
    expect(counter.current).toBe(600);

    // Simulate store: events stored newest-first, capped at 500
    const stored = all.slice().reverse().slice(0, 500);
    // stored[0] = newest = seq 599, stored[499] = oldest = seq 100

    // Simulate DagScreen's live-processing loop after first 500 processed
    let processedSeq: number = 499;
    let fresh = stored.filter((e) => (e.seq ?? 0) > processedSeq);
    expect(fresh.length).toBe(100); // seq 500-599
    // Reverse to chronological = oldest-new first
    const chronological = fresh.slice().reverse();
    expect(chronological[0].seq).toBe(500);
    expect(chronological[chronological.length - 1].seq).toBe(599);

    // Advance watermark after processing
    processedSeq = Math.max(...stored.map((e) => e.seq ?? 0), processedSeq);
    expect(processedSeq).toBe(599);

    // New batch arrives (seq 600-604), pushes out 5 oldest
    const batch2: StreamEvent[] = [];
    for (let i = 0; i < 5; i++) {
      batch2.push(makeEvent({ data: { planName: 't', phaseName: `p${600 + i}`, iteration: 1 } }));
    }
    assignSeq(batch2, counter);
    expect(counter.current).toBe(605);

    // Simulate flush merge: prepend newest-first, cap at 500
    const merged = [...batch2.slice().reverse(), ...stored].slice(0, 500);
    // merged still has 500 items, but 5 are new (seq 600-604)

    // DagScreen filter — should pick up exactly the 5 new events
    fresh = merged.filter((e) => (e.seq ?? 0) > processedSeq);
    expect(fresh.length).toBe(5);
    expect(fresh[0].seq).toBe(604); // newest first
  });
});
