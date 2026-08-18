/**
 * agent-server.ts — sidecar manager (ADR-0023 decision 2, T3 issue #28).
 *
 * Owns the OpenHands Agent Server process lifecycle: lazy-spawn on the first
 * agent task, health-gates every agent task, bounded restart (1 initial +
 * maxRestarts, mirroring maxRetries) then ABORT. `agentServer.manage: false`
 * connects to a BYO server URL with zero process ownership. One manager is
 * shared across child loops via the getAgentServerManager() singleton cache —
 * each loop gets its own conversation on the one server.
 */

import type { LoopConfig } from './types.js';
import { createAgentServerClient } from './agent-server-client.js';
import type { AgentServerClient } from './agent-server-client.js';
import { DEFAULT_AGENT_SERVER_CONFIG } from './config.js';

/** Handle to a spawned sidecar process. */
export interface AgentServerProcess {
  pid: number;
  /** Actual listening URL — the spawner reports it when it differs from the config URL (e.g. ephemeral ports in tests). */
  baseUrl?: string;
  kill(): void;
  /** Sidecar stderr text; resolved when the process exits. Used for spawn-failure diagnostics. */
  stderr?: Promise<string>;
}

export interface AgentServerSpawner {
  spawn(port: number): Promise<AgentServerProcess>;
}

export interface AgentServerManager {
  /** Ensure a healthy sidecar is running and return a client for it. Throws after bounded restarts. */
  getClient(signal?: AbortSignal): Promise<AgentServerClient>;
  stop(): Promise<void>;
}

export interface AgentServerManagerOptions {
  /** How long to wait for a freshly spawned sidecar to become healthy. */
  readyTimeoutMs?: number;
  /** Poll cadence while waiting for readiness. */
  pollIntervalMs?: number;
  /** Restart budget after the initial spawn (mirrors maxRetries). */
  maxRestarts?: number;
}

const DEFAULT_OPTIONS: Required<AgentServerManagerOptions> = {
  readyTimeoutMs: 5000,
  pollIntervalMs: 250,
  maxRestarts: 3,
};

/** How long to wait for a killed sidecar's stderr before giving up on the diagnostic. */
const STDERR_READ_TIMEOUT_MS = 200;

/** Production spawner: `uvx openhands-agent-server` on the configured port. */
export const defaultSpawner: AgentServerSpawner = {
  async spawn(port: number): Promise<AgentServerProcess> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        ['uvx', 'openhands-agent-server', '--host', '127.0.0.1', '--port', String(port)],
        { stdout: 'ignore', stderr: 'pipe' },
      );
    } catch (err) {
      throw new Error(
        `could not start uvx: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const stderr =
      proc.stderr && typeof proc.stderr !== 'number'
        ? new Response(proc.stderr).text()
        : Promise.resolve('');
    return {
      pid: proc.pid,
      kill: () => {
        try {
          proc.kill();
        } catch (err) {
          console.error(`[agent-server] kill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      stderr,
    };
  },
};

/** Resolve the config's agentServer defaults once — shared by the manager and the singleton cache key. */
function agentServerDefaults(config: LoopConfig) {
  return {
    manage: config.agentServer?.manage ?? DEFAULT_AGENT_SERVER_CONFIG.manage,
    url: config.agentServer?.url ?? DEFAULT_AGENT_SERVER_CONFIG.url,
    port: config.agentServer?.port ?? DEFAULT_AGENT_SERVER_CONFIG.port,
  };
}

export function createAgentServerManager(
  config: LoopConfig,
  spawner: AgentServerSpawner = defaultSpawner,
  options: AgentServerManagerOptions = {},
): AgentServerManager {
  const opts: Required<AgentServerManagerOptions> = { ...DEFAULT_OPTIONS, ...options };
  const { manage, url: baseUrl, port } = agentServerDefaults(config);
  const maxAttempts = opts.maxRestarts + 1;

  let process: AgentServerProcess | null = null;
  let spawnAttempts = 0;
  let lastStderr = '';

  async function pollUntilHealthy(url: string): Promise<boolean> {
    const client = createAgentServerClient(url);
    const deadline = Date.now() + opts.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await client.checkHealth()) return true;
      await sleep(opts.pollIntervalMs);
    }
    return false;
  }

  function killProcess(): void {
    if (process) {
      try {
        process.kill();
      } catch (err) {
        console.error(`[agent-server] kill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process = null;
  }

  return {
    async getClient(signal?: AbortSignal): Promise<AgentServerClient> {
      if (!manage) {
        if (!(await pollUntilHealthy(baseUrl))) {
          throw new Error(
            `Agent Server (BYO) at ${baseUrl} is not healthy — is the server running? (agentServer.manage: false, no process ownership)`,
          );
        }
        return createAgentServerClient(baseUrl, signal);
      }

      for (;;) {
        if (process) {
          const url = process.baseUrl ?? baseUrl;
          const healthy = await createAgentServerClient(url).checkHealth();
          if (healthy) return createAgentServerClient(url, signal);
          killProcess();
        }

        if (spawnAttempts >= maxAttempts) {
          throw new Error(
            `Agent Server failed to become healthy after ${spawnAttempts} spawn attempts (${opts.maxRestarts} restarts) — aborting.` +
              (lastStderr ? ` Last sidecar stderr: ${lastStderr.slice(0, 200)}` : ''),
          );
        }

        try {
          process = await spawner.spawn(port);
          spawnAttempts++;
        } catch (err) {
          throw new Error(
            `Agent Server spawn failed: ${err instanceof Error ? err.message : String(err)} — is uvx installed and Python ≥ 3.12? (openhands-agent-server)`,
          );
        }

        const url = process.baseUrl ?? baseUrl;
        if (await pollUntilHealthy(url)) {
          return createAgentServerClient(url, signal);
        }
        // Kill first, then read stderr with a bound: a wedged process never closes
        // its stderr pipe, so an unbounded read would hang the restart loop.
        const stderrPromise = process.stderr;
        killProcess();
        lastStderr = stderrPromise
          ? await Promise.race([stderrPromise.catch(() => ''), sleep(STDERR_READ_TIMEOUT_MS).then(() => '')])
          : '';
      }
    },

    async stop(): Promise<void> {
      killProcess();
    },
  };
}

const managerCache = new Map<string, AgentServerManager>();

function cacheKey(config: LoopConfig): string {
  const { manage, url, port } = agentServerDefaults(config);
  return `${manage}|${url}|${port}`;
}

/**
 * Shared singleton per (manage, url, port) — one sidecar process across all
 * child loops (ADR-0023 decision 2). Tests inject explicit managers instead.
 */
export function getAgentServerManager(config: LoopConfig): AgentServerManager {
  const key = cacheKey(config);
  let manager = managerCache.get(key);
  if (!manager) {
    manager = createAgentServerManager(config);
    managerCache.set(key, manager);
  }
  return manager;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}