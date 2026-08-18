/**
 * docker.ts — docker workspace for agent tasks (v10 T5, issue #30).
 *
 * Verified mechanism (primary sources, AC4): a docker workspace IS a
 * containerized Agent Server — the client provisions it. The native sidecar
 * cannot provision containers (`workspaces_router` only persists GUI folder
 * picks); the SDK's DockerWorkspace runs the agent-server image itself, waits
 * for health, and stops the container on exit. One container = one agent
 * server = per-conversation isolation, so docker tasks get their own container
 * while local tasks share the uvx sidecar singleton.
 */

import type { AgentServerProcess, AgentServerSpawner } from './agent-server.js';
import { runCommand } from './shell.js';

export const DOCKER_AGENT_SERVER_IMAGE = 'ghcr.io/openhands/agent-server:latest-python';
/** Port the container's Agent Server listens on (host port is docker-assigned). */
export const DOCKER_AGENT_SERVER_CONTAINER_PORT = 8000;
/** Container workspace mount (verified agent-server image convention). */
export const DOCKER_WORKSPACE_MOUNT = '/workspace';

export interface DockerContainer {
  name: string;
  hostPort: number;
  stop(): Promise<void>;
}

export interface DockerRunner {
  runContainer(params: { image: string; hostDir: string }): Promise<DockerContainer>;
}

/** Build the docker run command. Host port 0 on 127.0.0.1 only — never expose the agent server on the LAN. */
export function buildDockerRunCommand(opts: {
  name: string;
  hostDir: string;
  image: string;
}): string {
  return [
    'docker run -d --rm --name',
    opts.name,
    `-p 127.0.0.1:0:${DOCKER_AGENT_SERVER_CONTAINER_PORT}`,
    `-v "${opts.hostDir}:${DOCKER_WORKSPACE_MOUNT}"`,
    opts.image,
    `--host 0.0.0.0 --port ${DOCKER_AGENT_SERVER_CONTAINER_PORT}`,
  ].join(' ');
}

/** Parse the host port from `docker port <name> 8000` output (e.g. "127.0.0.1:32145"). */
export function parseDockerPortOutput(output: string): number {
  const port = output.trim().split(':').pop() ?? '';
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`unparseable docker port output: "${output.trim()}"`);
  }
  return parsed;
}

export function createDockerRunner(): DockerRunner {
  return {
    async runContainer({ image, hostDir }): Promise<DockerContainer> {
      const name = `agent-server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const run = await runCommand(buildDockerRunCommand({ name, hostDir, image }));
      if (run.exitCode !== 0) {
        throw new Error(`docker run failed: ${(run.stderr || run.stdout).trim()}`);
      }
      let hostPort: number;
      try {
        const portResult = await runCommand(`docker port ${name} ${DOCKER_AGENT_SERVER_CONTAINER_PORT}`);
        if (portResult.exitCode !== 0) {
          throw new Error(`docker port discovery failed: ${portResult.stderr.trim()}`);
        }
        hostPort = parseDockerPortOutput(portResult.stdout);
      } catch (err) {
        await runCommand(`docker stop ${name}`); // never orphan a started container
        throw err;
      }
      return {
        name,
        hostPort,
        stop: async () => {
          const stopResult = await runCommand(`docker stop ${name}`);
          if (stopResult.exitCode !== 0) {
            console.error(`[docker] container stop failed (non-fatal): ${(stopResult.stderr || stopResult.stdout).trim()}`);
          }
        },
      };
    },
  };
}

export function createDockerSpawner(runner: DockerRunner): AgentServerSpawner {
  return {
    async spawn(_port: number): Promise<AgentServerProcess> {
      const container = await runner.runContainer({
        image: DOCKER_AGENT_SERVER_IMAGE,
        hostDir: process.cwd(),
      });
      return {
        pid: 0, // containers have no host pid — lifecycle is by container name
        baseUrl: `http://127.0.0.1:${container.hostPort}`,
        kill: () => {
          void container.stop();
        },
        stderr: Promise.resolve(''),
      };
    },
  };
}