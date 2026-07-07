/**
 * execute-phases.ts — shared phase execution for loop.ts runLoop() and tick().
 *
 * Both callers construct an ExecutionDeps and call executePhaseGroup(),
 * extracting ~50 LOC of duplication from each.
 */

import { evaluatePhase } from './evaluate.js';
import { executeHooks } from './plugins.js';
import type { Plugin, HookContext } from './plugins.js';
import { updatePhaseResult } from './state.js';
import type { PhaseDef, PhaseResult, LoopState, LoopConfig } from './types.js';
import { logPhaseContext } from './memory-hooks.js';

/** Everything executePhaseGroup needs from the caller's context. */
export interface ExecutionDeps {
  config: LoopConfig;
  plugins: Plugin[];
  writeState(state: LoopState): Promise<void>;
  onPhaseFailed(phase: PhaseDef, result: PhaseResult): void;
}

/** Result of a phase execution group (one iteration's phases). */
export interface PhaseGroupResult {
  allPassed: boolean;
  state: LoopState;
}

/**
 * Execute all phases for one iteration.
 *
 * Shared by:
 * - runLoop()   in loop.ts (single-run mode)
 * - tick()      in loop.ts (daemon/interval mode)
 *
 * Does NOT handle state machine transitions — the caller manages those.
 */
export async function executePhaseGroup(
  deps: ExecutionDeps,
  state: LoopState,
  iteration: number,
): Promise<PhaseGroupResult> {
  let allPassed = true;

  for (const phase of deps.config.phases) {
    process.stdout.write(`[${iteration}/${deps.config.maxIterations}] ${phase.name}... `);

    // Plugin hooks: onPhaseStart
    const prePluginResults = await executeHooks('onPhaseStart', { phase, state }, deps.plugins);
    let pluginResults: Record<string, unknown> = { ...prePluginResults };

    logPhaseContext(phase, deps.config);

    const phaseStart = Date.now();
    const result = await executeShellCommand(phase.command, phase.timeoutMs);

    // Plugin hooks: onPhaseEnd or onError
    if (result.status === 'error') {
      const errResults = await executeHooks('onError', { phase, state, error: new Error(result.stderr) }, deps.plugins);
      Object.assign(pluginResults, errResults);
    } else {
      const postPluginResults = await executeHooks('onPhaseEnd', { phase, result, state }, deps.plugins);
      Object.assign(pluginResults, postPluginResults);
    }
    result.pluginResults = pluginResults;

    // ponytail: evaluation failure should not crash the loop
    try {
      const judgment = await evaluatePhase(phase, result);
      result.judgment = judgment;
    } catch {
      // Non-fatal
    }

    const totalPhaseMs = Date.now() - phaseStart;
    state = updatePhaseResult(state, phase.name, result);

    // Log result with real wall-clock duration (shell + LLM eval)
    if (result.status === 'pass') {
      console.log(`PASS (${totalPhaseMs}ms)`);
    } else if (result.status === 'fail') {
      allPassed = false;
      console.log(`FAIL (${totalPhaseMs}ms)`);
      if (result.stderr) console.error(`  stderr: ${result.stderr}`);
      if (result.stdout) console.error(`  stdout: ${result.stdout}`);
    } else {
      allPassed = false;
      console.log(`ERROR (${totalPhaseMs}ms)`);
      if (result.stderr) console.error(`  error: ${result.stderr}`);
    }

    if (result.status !== 'pass') {
      deps.onPhaseFailed(phase, result);
    }

    await deps.writeState(state);
  }

  return { allPassed, state };
}

// ── Shell command executor (moved from loop.ts) ──────────────────────────────

import { executeWithTimeout } from './safety.js';

async function executeShellCommand(
  command: string,
  timeoutMs: number,
): Promise<PhaseResult> {
  const startTime = Date.now();

  try {
    return await executeWithTimeout(async (signal) => {
      const proc = Bun.spawn(['cmd.exe', '/c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });

      const [stdout, stderr] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
      ]);

      const exitCode = await proc.exited;

      return {
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startTime,
        evidencePath: '',
      };
    }, timeoutMs, command);
  } catch (err) {
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      evidencePath: '',
    };
  }
}
