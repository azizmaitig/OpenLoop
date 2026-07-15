/**
 * Safety guards for the agent loop — timeout enforcement and iteration limits.
 *
 * @module safety
 */

/**
 * Error thrown when a phase exceeds its allotted time.
 */
export class PhaseTimeoutError extends Error {
  constructor(phaseName: string, timeoutMs: number) {
    super(`Phase '${phaseName}' timed out after ${timeoutMs}ms`);
    this.name = 'PhaseTimeoutError';
  }
}

/**
 * Error thrown when the loop exceeds the configured iteration cap.
 */
export class MaxIterationsExceededError extends Error {
  constructor(maxIterations: number) {
    super(`Max iterations (${maxIterations}) reached`);
    this.name = 'MaxIterationsExceededError';
  }
}

/**
 * Check whether the current iteration count is still within the limit.
 */
export function checkMaxIterations(
  currentIteration: number,
  maxIterations: number,
): boolean {
  return currentIteration < maxIterations;
}

export async function executeWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  phaseName: string,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PhaseTimeoutError(phaseName, timeoutMs));
    }, timeoutMs);
    // Unref so the timer does not keep the process alive
    timer.unref?.();
  });

  let timedOut = false;
  try {
    return await Promise.race([fn(signal), timeoutPromise]);
  } catch (err) {
    timedOut = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    // Only abort on timeout (Bun-on-Windows GC workaround).
    // Leaving the signal unresolved after successful completion prevents
    // Bun-on-Linux from terminating parent processes that use the signal.
    if (timedOut) controller.abort();
  }
}


