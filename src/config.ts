import type { AgentServerConfig, LoopConfig } from './types.js';

export const DEFAULT_AGENT_SERVER_CONFIG: AgentServerConfig = {
  manage: true,
  url: 'http://127.0.0.1:8000',
  port: 8000,
};

export const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 3,
  phaseTimeoutMs: 60000,
  taskName: 'default-task',
  phases: [],
  memory: { enabled: false },
  agentServer: DEFAULT_AGENT_SERVER_CONFIG,
};

export function mergeConfig(
  base: LoopConfig,
  override: Partial<LoopConfig>,
): LoopConfig {
  const merged: LoopConfig = {
    ...base,
    ...override,
    maxIterations: Math.min(
      override.maxIterations ?? base.maxIterations,
      20,
    ),
  };

  // Deep-merge agentServer so a partial override (e.g. { manage: false })
  // fills the untouched keys from the defaults instead of clobbering them.
  if (override.agentServer || base.agentServer) {
    const baseAgent = base.agentServer;
    const overrideAgent = override.agentServer;
    merged.agentServer = {
      ...DEFAULT_AGENT_SERVER_CONFIG,
      ...baseAgent,
      ...overrideAgent,
    };
    if (baseAgent?.defaults || overrideAgent?.defaults) {
      merged.agentServer.defaults = {
        ...baseAgent?.defaults,
        ...overrideAgent?.defaults,
      };
    }
  }

  return merged;
}
