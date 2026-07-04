/**
 * memory-hooks.ts — Lifecycle callbacks for agent-loop memory integration.
 *
 * All functions are fire-and-forget: errors swallowed, non-blocking.
 * Guarded by config.memory.enabled.
 *
 * @module memory-hooks
 */

import type { PhaseDef, PhaseResult, LoopConfig, LoopState } from './types.js';
import { saveEpisodic, archiveSession, saveLesson, pushPulse, recallLessons } from './agentmemory.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface PhaseSummary {
  name: string;
  status: string;
  exitCode: number;
  durationMs: number;
}

interface LoopSummary {
  taskName: string;
  iteration: number;
  finalState: string;
  phases: PhaseSummary[];
  totalDurationMs: number;
  errorCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSummary(state: LoopState, taskName: string): LoopSummary {
  const phases: PhaseSummary[] = Object.entries(state.phaseResults).map(
    ([name, r]) => ({
      name,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    }),
  );
  return {
    taskName,
    iteration: state.iteration,
    finalState: state.currentState,
    phases,
    totalDurationMs: phases.reduce((sum, p) => sum + p.durationMs, 0),
    errorCount: state.errors.length,
  };
}

function archiveFilePath(taskName: string, basePath: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${basePath}/${y}/${m}/${d}/${hh}/${mm}/${ts}-${taskName}.md`;
}

/**
 * Simple string hash for novelty dedup. Non-cryptographic.
 * ponytail: no crypto dep needed for dedup comparison.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (const c of str) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  return hash >>> 0;
}

// ── Exported ─────────────────────────────────────────────────────────────────

/**
 * Compute health score as passingPhases / totalPhases (0.0–1.0).
 * Returns 0 when there are no phase results.
 */
export function computeHealthScore(state: LoopState): number {
  const results = Object.values(state.phaseResults);
  if (results.length === 0) return 0;
  const passing = results.filter(r => r.status === 'pass').length;
  return passing / results.length;
}

/**
 * Log pre-phase context from agentmemory lessons.
 * Fire-and-forget — does not block phase execution.
 * Guarded by config.memory.enabled.
 */
export function logPhaseContext(
  phase: PhaseDef,
  config: LoopConfig,
): void {
  if (!config.memory?.enabled) return;

  void (async () => {
    try {
      const query = `${config.taskName}: ${phase.name}`;
      const lessons = await recallLessons(query);
      if (lessons && lessons.length > 0) {
        const top = lessons.slice(0, 5);
        for (const l of top) {
          const content = (l as Record<string, unknown>)?.content ?? '';
          console.log(`[memory] Context: ${String(content).slice(0, 200)}`);
        }
      } else {
        console.log(`[memory] No context available for "${query}"`);
      }
    } catch {
      // Swallow all errors — fire-and-forget
    }
  })().catch(() => {});
}

/**
 * Called when a phase fails. On novel failures (not seen in recent lessons),
 * saves a lesson to agentmemory.
 *
 * Novelty detection: simple string hash of the error message, compared against
 * content of lessons fetched via recallLessons.
 *
 * Fire-and-forget — does not block the caller.
 * Guarded by config.memory.enabled.
 */
export function onPhaseFailed(phase: PhaseDef, result: PhaseResult, config: LoopConfig): void {
  if (!config.memory?.enabled) return;

  void (async () => {
    try {
      const errorMsg = result.stderr?.trim() || `exit code ${result.exitCode}`;
      const errorHash = simpleHash(errorMsg);

      const lessons = await recallLessons(config.taskName);
      if (lessons) {
        const isNovel = !lessons.some((l: unknown) => {
          const content: string = (l as Record<string, unknown>)?.content as string ?? '';
          return simpleHash(content) === errorHash || content.includes(errorMsg.slice(0, 100));
        });
        if (!isNovel) return; // known failure, skip
      }

      const content = `Phase ${phase.name} failed with exit ${result.exitCode}: ${errorMsg}`;
      await saveLesson(content, config.taskName);
    } catch {
      // Swallow all errors — fire-and-forget
    }
  })().catch(() => {});
}

/**
 * Called when the loop completes (normal, failed, or aborted).
 *
 * Performs three actions:
 *   1. Episodic save to agentmemory (condensed summary)
 *   2. Health pulse: compute, console.log, push via pushPulse
 *   3. Session archive to vault history
 *
 * All calls are fire-and-forget — callers use `void onLoopComplete(...)`.
 * Errors are caught and swallowed internally.
 * Guarded by config.memory.enabled.
 */
export async function onLoopComplete(
  state: LoopState,
  config: LoopConfig,
): Promise<void> {
  if (!config.memory?.enabled) return;

  const taskName = config.taskName;

  const summary = buildSummary(state, taskName);
  console.log('[memory-hooks] Loop complete —', JSON.stringify(summary));

  void saveEpisodic(state, taskName).catch(() => {});

  const healthScore = computeHealthScore(state);
  const total = Object.keys(state.phaseResults).length;
  const passing = Object.values(state.phaseResults).filter(r => r.status === 'pass').length;
  console.log(`[memory] Health score: ${healthScore.toFixed(2)} (${passing}/${total} phases passing)`);
  void pushPulse(healthScore).catch(() => {});

  const basePath =
    config.memory?.archivePath ||
    '70-Memory/history'; /* ponytail: single vault default, make configurable when multi-vault needed */
  const path = archiveFilePath(taskName, basePath);
  console.log('[memory-hooks] Archive:', path);
  void archiveSession(state, taskName, basePath).catch(() => {});
}
