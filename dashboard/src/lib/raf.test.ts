import { createRafScheduler } from './raf';

// Runner-agnostic (works under both Bun test and Vitest globals).
describe('createRafScheduler', () => {
  let rafCalls: ((cb: number) => void)[];

  beforeEach(() => {
    rafCalls = [];
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
      rafCalls.push(cb);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};
  });

  afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
  });

  it('batches multiple schedules into a single flush per frame', () => {
    let flushCount = 0;
    const s = createRafScheduler();
    s.setFlush(() => {
      flushCount++;
    });
    s.schedule();
    s.schedule();
    s.schedule();
    // Only one rAF should be queued for the frame.
    expect(rafCalls.length).toBe(1);
    // Drain the frame.
    rafCalls[0](0);
    expect(flushCount).toBe(1);
  });
});
