import type { LoopConfig } from './types.js';

export const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 3,
  phaseTimeoutMs: 60000,
  taskName: 'default-task',
  phases: [],
  memory: { enabled: false },
};

export function parseLoopArgs(args: string[]): Partial<LoopConfig> {
  const result: Partial<LoopConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--phases': {
        const val = args[++i];
        if (val) {
          result.phases = val.split(',').map((name) => ({
            name: name.trim(),
            command: '',
            expectedExitCode: 0,
            timeoutMs: DEFAULT_CONFIG.phaseTimeoutMs,
          }));
        }
        break;
      }
      case '--task': {
        const val = args[++i];
        if (val) result.taskName = val;
        break;
      }
      case '--max-iterations': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) result.maxIterations = val;
        break;
      }
      case '--timeout': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) result.phaseTimeoutMs = val;
        break;
      }
      case '--llm': {
        result.llmController = true;
        args[++i]; // consume value but don't store in Partial<LoopConfig>
        break;
      }
      case '--plugins': {
        const val = args[++i];
        if (val) {
          result.plugins = val.split(',').map(s => s.trim());
        }
        break;
      }
      case '--port': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) {
          result.daemon = { intervalMs: 60000, port: val };
        }
        break;
      }
    }
  }

  return result;
}

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
