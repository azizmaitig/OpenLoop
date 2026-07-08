import type { LoopConfig } from './types.js';

export const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 3,
  phaseTimeoutMs: 60000,
  taskName: 'default-task',
  phases: [],
  memory: { enabled: false },
};

export function mergeConfig(
  base: LoopConfig,
  override: Partial<LoopConfig>,
): LoopConfig {
  return {
    ...base,
    ...override,
    maxIterations: Math.min(
      override.maxIterations ?? base.maxIterations,
      20,
    ),
  };
}
