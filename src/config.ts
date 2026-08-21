import type { AgentServerConfig, LoopConfig, OpenCodeServerConfig } from './types.js';

export const DEFAULT_AGENT_SERVER_CONFIG: AgentServerConfig = {
  manage: true,
  url: 'http://127.0.0.1:8000',
  port: 8000,
};

export const DEFAULT_OPENCODE_SERVER_CONFIG: OpenCodeServerConfig = {
  url: 'http://127.0.0.1:4096',
  idleTimeoutMs: 60000,
  transcriptTailChars: 2000,
};

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Read `agentServer.*` overrides from `LOOP_AGENT_SERVER_*` env vars —
 * the CLI-facing surface for sidecar + LLM-defaults configuration
 * (the guide documents agentServer as loop-level config, not plan YAML).
 */
export function agentServerFromEnv(): Partial<AgentServerConfig> {
  const out: Partial<AgentServerConfig> = {};
  if (process.env.LOOP_AGENT_SERVER_MANAGE !== undefined) {
    const v = process.env.LOOP_AGENT_SERVER_MANAGE.toLowerCase();
    out.manage = v !== 'false' && v !== '0' && v !== '';
  }
  if (process.env.LOOP_AGENT_SERVER_URL !== undefined) {
    out.url = process.env.LOOP_AGENT_SERVER_URL;
  }
  const port = num(process.env.LOOP_AGENT_SERVER_PORT);
  if (port !== undefined) out.port = port;
  const readyTimeoutMs = num(process.env.LOOP_AGENT_SERVER_READY_TIMEOUT_MS);
  if (readyTimeoutMs !== undefined) out.readyTimeoutMs = readyTimeoutMs;
  const maxRestarts = num(process.env.LOOP_AGENT_SERVER_MAX_RESTARTS);
  if (maxRestarts !== undefined) out.maxRestarts = maxRestarts;

  const defaults: NonNullable<AgentServerConfig['defaults']> = {};
  if (process.env.LOOP_AGENT_SERVER_DEFAULTS_PROVIDER !== undefined) {
    defaults.provider = process.env.LOOP_AGENT_SERVER_DEFAULTS_PROVIDER;
  }
  if (process.env.LOOP_AGENT_SERVER_DEFAULTS_MODEL !== undefined) {
    defaults.model = process.env.LOOP_AGENT_SERVER_DEFAULTS_MODEL;
  }
  if (process.env.LOOP_AGENT_SERVER_DEFAULTS_BASE_URL !== undefined) {
    defaults.baseUrl = process.env.LOOP_AGENT_SERVER_DEFAULTS_BASE_URL;
  }
  if (process.env.LOOP_AGENT_SERVER_DEFAULTS_API_KEY !== undefined) {
    defaults.apiKey = process.env.LOOP_AGENT_SERVER_DEFAULTS_API_KEY;
  }
  if (Object.keys(defaults).length > 0) out.defaults = defaults;

  return out;
}

/**
 * Read `opencodeServer.*` overrides from `LOOP_OPENCODE_SERVER_*` env vars —
 * the CLI-facing surface for the opencode server URL (v11, ADR-0024).
 */
export function opencodeServerFromEnv(): Partial<OpenCodeServerConfig> {
  const out: Partial<OpenCodeServerConfig> = {};
  if (process.env.LOOP_OPENCODE_SERVER_URL !== undefined) {
    out.url = process.env.LOOP_OPENCODE_SERVER_URL;
  }
  const idleTimeoutMs = num(process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS);
  if (idleTimeoutMs !== undefined) out.idleTimeoutMs = idleTimeoutMs;
  const transcriptTailChars = num(process.env.LOOP_OPENCODE_SERVER_TRANSCRIPT_TAIL_CHARS);
  if (transcriptTailChars !== undefined) out.transcriptTailChars = transcriptTailChars;
  return out;
}

export const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 3,
  phaseTimeoutMs: 60000,
  taskName: 'default-task',
  phases: [],
  memory: { enabled: false },
  agentServer: DEFAULT_AGENT_SERVER_CONFIG,
  opencodeServer: DEFAULT_OPENCODE_SERVER_CONFIG,
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

  // Deep-merge opencodeServer the same way: a partial override fills the
  // untouched keys from the defaults instead of clobbering them.
  if (override.opencodeServer || base.opencodeServer) {
    merged.opencodeServer = {
      ...DEFAULT_OPENCODE_SERVER_CONFIG,
      ...base.opencodeServer,
      ...override.opencodeServer,
    };
  }

  return merged;
}
