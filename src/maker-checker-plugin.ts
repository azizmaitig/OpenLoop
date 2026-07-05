import type { PhaseDef, PhaseResult, LoopState, LoopResult } from './types.js';
import type { Plugin } from './plugins.js';

export interface MakerCheckerConfig {
  /** Enable the maker/checker plugin. Default: false */
  enabled?: boolean;
  /** LLM model for the maker phase. Optional. */
  makerModel?: string;
  /** LLM model for the checker phase. Optional. */
  checkerModel?: string;
  /** If true, checker auto-approves without blocking. Default: false */
  autoApprove?: boolean;
  /** Max retries when checker fails. Default: 2 */
  maxCheckerRetries?: number;
}

/**
 * Create a maker/checker plugin.
 *
 * When enabled, the plugin intercepts phase lifecycle:
 * - Maker phase completed (pass) → auto-injects a checker phase result
 * - Checker phase completed (fail) → retries maker up to maxCheckerRetries
 * - Retries exhausted → marks maker phase as FAILED
 *
 * Must be loaded explicitly via --plugins or plugins config (not auto-loaded).
 */
export function createMakerCheckerPlugin(config: MakerCheckerConfig = {}): Plugin {
  const enabled = config.enabled ?? false;
  const maxCheckerRetries = config.maxCheckerRetries ?? 2;

  // ponytail: simple retry counter keyed by iteration for testability
  const retries = new Map<string, number>();

  return {
    name: 'maker-checker',

    onPhaseStart: async (_phase: PhaseDef, _state: LoopState) => {
      // no-op: maker-checker only acts on phase end
    },

    onPhaseEnd: async (phase: PhaseDef, result: PhaseResult, state: LoopState) => {
      if (!enabled) return;

      // ── Maker phase completed successfully → inject checker ──
      if (phase.name === 'maker' && result.status === 'pass') {
        state.phaseResults['checker'] = {
          status: 'pass',
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: 0,
          evidencePath: result.evidencePath,
          judgment: undefined, // to be set by the checker evaluation
        };
      }

      // ── Checker phase completed → evaluate judgment ──
      if (phase.name === 'checker') {
        const judgment = result.judgment;
        if (!judgment || judgment.passed) {
          retries.delete(phase.name);
          return;
        }

        const key = `${phase.name}:${state.iteration}`;
        const current = (retries.get(key) ?? 0) + 1;
        retries.set(key, current);

        if (current <= maxCheckerRetries) {
          state.errors.push(`Checker failed, retrying maker (${current}/${maxCheckerRetries})`);
        } else {
          state.errors.push(`Checker failed after ${current} retries, marking FAILED`);
          const makerResult = state.phaseResults['maker'];
          if (makerResult) {
            state.phaseResults['maker'] = { ...makerResult, status: 'fail' };
          }
        }
      }
    },

    onError: async (_error: Error, _phase: PhaseDef) => {
      // no-op: errors handled by the loop's error recovery
    },

    beforeLoop: async (_planPath: string): Promise<PhaseDef[]> => {
      return [];
    },

    afterLoop: async (_result: LoopResult) => {
      // no-op
    },
  };
}
