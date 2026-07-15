/**
 * plan-config.ts — resolve a LoopConfig from a .plan.yaml path.
 *
 * Shared helper for both the CLI daemon path (loop.ts) and the orchestrated
 * multi-loop daemon (orchestrator.ts). Loads the plan-executor plugin, calls
 * its beforeLoop hook to map YAML tasks → PhaseDef[], and returns a ready
 * LoopConfig with maxIterations: 1 (single-run).
 */

import type { LoopConfig } from './types.js';
import { loadPlugins } from './plugins.js';
import type { Plugin } from './plugins.js';

export interface ResolvePlanConfigOpts {
  intervalMs?: number;
  port?: number;
}

/**
 * Build a LoopConfig from a planPath by loading the plan-executor plugin
 * and resolving its phases. Returns a config ready for runLoop().
 *
 * - maxIterations is hard-coded to 1 (single run per call).
 * - Sets taskName to the plan path basename for WS event identification.
 * - Logs how many phases were loaded.
 */
export async function resolvePlanConfig(
  planPath: string,
  opts?: ResolvePlanConfigOpts,
): Promise<LoopConfig> {
  const config: LoopConfig = {
    taskName: `plan:${planPath.replace(/\\/g, '/').split('/').pop() ?? planPath}`,
    maxIterations: 1,
    phaseTimeoutMs: 60000,
    phases: [],
    planPath,
    plugins: ['./src/plan-executor.ts'],
    daemon: { intervalMs: opts?.intervalMs ?? 60000, port: opts?.port },
  };

  const plugins = await loadPlugins(config);
  const planPlugin: Plugin | undefined = plugins.find(p => p.name === 'plan-executor');

  if (planPlugin?.beforeLoop) {
    const planPhases = await planPlugin.beforeLoop(planPath, false);
    config.phases = planPhases;
    console.log(`[plan-config] Loaded ${planPhases.length} phases from ${planPath}`);
  } else {
    console.warn(`[plan-config] plan-executor plugin not found — no phases for ${planPath}`);
  }

  return config;
}
