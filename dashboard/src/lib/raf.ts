// lib/raf.ts — requestAnimationFrame batch scheduler.
// Buffers callbacks and fires them once per frame so high-frequency WS messages
// coalesce into a single render pass (design §0 principle 3).

export type RafFlush = () => void;

export interface RafScheduler {
  /** Schedule a flush on the next animation frame. Idempotent per frame. */
  schedule(): void;
  /** Register the flush callback invoked once per frame. */
  setFlush(fn: RafFlush): void;
  /** Stop the scheduler and cancel any pending frame. */
  stop(): void;
}

export function createRafScheduler(): RafScheduler {
  let flushFn: RafFlush | null = null;
  let frame: number | null = null;

  const run = () => {
    frame = null;
    flushFn?.();
  };

  return {
    schedule() {
      if (frame === null && typeof requestAnimationFrame !== 'undefined') {
        frame = requestAnimationFrame(run);
      } else if (frame === null) {
        // SSR / no rAF: fall back to a macrotask so we still drain.
        frame = setTimeout(run, 16) as unknown as number;
      }
    },
    setFlush(fn) {
      flushFn = fn;
    },
    stop() {
      if (frame !== null) {
        if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
        else clearTimeout(frame);
        frame = null;
      }
    },
  };
}
