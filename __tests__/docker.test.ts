import { describe, expect, test } from "bun:test";
import type { DockerRunner } from "../src/docker.js";
import { createDockerSpawner, parseDockerPortOutput, DOCKER_AGENT_SERVER_IMAGE } from "../src/docker.js";
import { createAgentServerManager } from "../src/agent-server.js";
import type { LoopConfig } from "../src/types.js";
import { startAgentStub } from "./helpers/agent-stub.js";
import type { StubServer } from "./helpers/agent-stub.js";

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

interface FakeContainer {
  stub: StubServer;
  stopped: boolean;
  hostPort: number;
  params?: { image: string; hostDir: string };
}

/** Fake docker runner: each runContainer starts a real stub on a random port and records params. */
function makeFakeDockerRunner() {
  const spawned: FakeContainer[] = [];
  const runner: DockerRunner = {
    async runContainer(params) {
      const stub = startAgentStub();
      const record: FakeContainer = {
        stub,
        stopped: false,
        hostPort: Number(new URL(stub.url).port),
        params,
      };
      spawned.push(record);
      return {
        name: `agent-server-test-${spawned.length}`,
        hostPort: record.hostPort,
        stop: async () => {
          record.stopped = true;
          stub.close();
        },
      };
    },
  };
  return { runner, spawned };
}

describe("parseDockerPortOutput", () => {
  test("parses the host port from `docker port` output", () => {
    expect(parseDockerPortOutput("0.0.0.0:32145\n")).toBe(32145);
  });

  test("throws on unparseable output", () => {
    expect(() => parseDockerPortOutput("")).toThrow();
    expect(() => parseDockerPortOutput("0.0.0.0:notaport")).toThrow();
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