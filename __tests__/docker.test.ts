import { describe, expect, test } from "bun:test";
import type { LoopConfig } from "../src/types.js";
import {
  createDockerSpawner,
  parseDockerPortOutput,
  buildDockerRunCommand,
  DOCKER_AGENT_SERVER_IMAGE,
  DOCKER_AGENT_SERVER_CONTAINER_PORT,
  DOCKER_WORKSPACE_MOUNT,
} from "../src/docker.js";
import { createAgentServerManager } from "../src/agent-server.js";
import { makeFakeDockerRunner } from "./helpers/docker-stub.js";

function makeConfig(overrides?: Partial<LoopConfig>): LoopConfig {
  return {
    taskName: "test",
    maxIterations: 3,
    phaseTimeoutMs: 30000,
    phases: [],
    memory: { enabled: false },
    ...overrides,
  };
}

describe("parseDockerPortOutput", () => {
  test("parses the host port from `docker port` output", () => {
    expect(parseDockerPortOutput("127.0.0.1:32145\n")).toBe(32145);
  });

  test("throws on unparseable output", () => {
    expect(() => parseDockerPortOutput("")).toThrow();
    expect(() => parseDockerPortOutput("0.0.0.0:notaport")).toThrow();
  });
});

describe("buildDockerRunCommand", () => {
  test("binds the host port on 127.0.0.1 only — never exposes the agent server on the LAN", () => {
    const cmd = buildDockerRunCommand({
      name: "agent-server-test-1",
      hostDir: "C:\\proj",
      image: DOCKER_AGENT_SERVER_IMAGE,
    });
    expect(cmd).toContain(`-p 127.0.0.1:0:${DOCKER_AGENT_SERVER_CONTAINER_PORT}`);
    expect(cmd).not.toContain("-p 0:");
  });

  test("mounts the host project at the container workspace", () => {
    const cmd = buildDockerRunCommand({
      name: "agent-server-test-1",
      hostDir: "C:\\proj",
      image: DOCKER_AGENT_SERVER_IMAGE,
    });
    expect(cmd).toContain(`-v "C:\\proj:${DOCKER_WORKSPACE_MOUNT}"`);
  });
});

describe("createDockerSpawner", () => {
  test("runs the agent-server image with the cwd mounted and reports the container URL", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    const spawner = createDockerSpawner(runner);

    const proc = await spawner.spawn(0);

    expect(spawned.length).toBe(1);
    expect(spawned[0]!.params).toEqual({
      image: DOCKER_AGENT_SERVER_IMAGE,
      hostDir: process.cwd(),
    });
    expect(proc.baseUrl).toBe(`http://127.0.0.1:${spawned[0]!.hostPort}`);
  });

  test("kill() stops the container", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    const spawner = createDockerSpawner(runner);

    const proc = await spawner.spawn(0);
    expect(spawned[0]!.stopped).toBe(false);

    proc.kill();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned[0]!.stopped).toBe(true);
  });

  test("manager lifecycle works with the docker spawner (spawn → health → stop)", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    const mgr = createAgentServerManager(
      makeConfig({ agentServer: { manage: true, url: "http://127.0.0.1:1", port: 1 } }),
      createDockerSpawner(runner),
      { readyTimeoutMs: 50, pollIntervalMs: 10 },
    );

    const client = await mgr.getClient();
    const conv = await client.createConversation({});

    expect(spawned.length).toBe(1);
    expect(conv.id).toBeDefined();

    await mgr.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned[0]!.stopped).toBe(true);
  });
});

describe("createDockerRunner (real docker)", () => {
  const daemonAvailable = (() => {
    try {
      return Bun.spawnSync(["docker", "ps"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  })();

  test("spawns and stops a real agent-server container — requires docker daemon", async () => {
    if (!daemonAvailable) {
      console.log("SKIP: docker daemon not available");
      return;
    }
    const { createDockerRunner } = await import("../src/docker.js");
    const spawner = createDockerSpawner(createDockerRunner());
    const proc = await spawner.spawn(0);
    expect(proc.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    proc.kill();
  });
});