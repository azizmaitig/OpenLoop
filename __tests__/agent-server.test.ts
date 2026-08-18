import { describe, expect, test } from "bun:test";
import type { LoopConfig } from "../src/types.js";
import { buildAgentServerSpawnCommand, createAgentServerManager } from "../src/agent-server.js";
import type { AgentServerManager, AgentServerProcess, AgentServerSpawner } from "../src/agent-server.js";
import { startAgentStub } from "./helpers/agent-stub.js";
import type { StubServer } from "./helpers/agent-stub.js";

// ── spawn command (real console script — smoke-test finding #1) ──────────────

describe("buildAgentServerSpawnCommand", () => {
  test("uses the package's real console script (agent-server), not the package name", () => {
    expect(buildAgentServerSpawnCommand(8000, "win32")).toEqual([
      "uvx", "--from", "openhands-agent-server", "agent-server.exe",
      "--host", "127.0.0.1", "--port", "8000",
    ]);
    expect(buildAgentServerSpawnCommand(8000, "linux")).toEqual([
      "uvx", "--from", "openhands-agent-server", "agent-server",
      "--host", "127.0.0.1", "--port", "8000",
    ]);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Fake sidecar: each spawn brings up a stub on its own port; health is driven by the stub. */
function makeFakeSpawner(healthySequence: boolean[] = [true]) {
  const spawned: { stub: StubServer; process: AgentServerProcess }[] = [];
  let index = 0;
  const spawner: AgentServerSpawner = {
    async spawn() {
      const healthy = healthySequence[Math.min(index, healthySequence.length - 1)];
      index++;
      const stub = startAgentStub({ healthy });
      const process: AgentServerProcess = {
        pid: index,
        baseUrl: stub.url,
        kill: () => {
          try {
            stub.close();
          } catch {}
        },
        stderr: Promise.resolve("fake sidecar stderr"),
      };
      spawned.push({ stub, process });
      return process;
    },
  };
  return { spawner, spawned };
}

function makeManager(
  config: LoopConfig,
  spawner: AgentServerSpawner,
  opts?: Partial<{ readyTimeoutMs: number; pollIntervalMs: number; maxRestarts: number }>,
): AgentServerManager {
  return createAgentServerManager(config, spawner, {
    readyTimeoutMs: 50,
    pollIntervalMs: 10,
    maxRestarts: 3,
    ...opts,
  });
}

function agentServerConfig(manage: boolean, url: string, port: number) {
  return { agentServer: { manage, url, port } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── manage: true — lifecycle ──────────────────────────────────────────────────

describe("createAgentServerManager (manage: true)", () => {
  test("lazy spawn: nothing until the first getClient", () => {
    const { spawner, spawned } = makeFakeSpawner();
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);
    expect(spawned.length).toBe(0);
    void mgr;
  });

  test("spawns once on first getClient and returns a working client", async () => {
    const { spawner, spawned } = makeFakeSpawner();
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    const client = await mgr.getClient();
    const conv = await client.createConversation({});

    expect(spawned.length).toBe(1);
    expect(conv.id).toBeDefined();
  });

  test("reuses the same process across getClient calls (shared across child loops)", async () => {
    const { spawner, spawned } = makeFakeSpawner();
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    await mgr.getClient();
    await mgr.getClient();
    await mgr.getClient();

    expect(spawned.length).toBe(1);
  });

  test("restarts a crashed sidecar on the next getClient", async () => {
    const { spawner, spawned } = makeFakeSpawner();
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    await mgr.getClient();
    expect(spawned.length).toBe(1);

    spawned[0]!.stub.close(); // simulate crash

    const client = await mgr.getClient();
    const conv = await client.createConversation({});

    expect(spawned.length).toBe(2);
    expect(conv.id).toBeDefined();
  });

  test("aborts after bounded restarts when the sidecar never becomes healthy", async () => {
    const { spawner, spawned } = makeFakeSpawner([false, false, false, false]);
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    await expect(mgr.getClient()).rejects.toThrow(/aborting/);
    expect(spawned.length).toBe(4); // 1 initial + 3 restarts (maxRestarts)
  });

  test("readiness options come from agentServer config (maxRestarts)", async () => {
    const { spawner, spawned } = makeFakeSpawner([false, false, false]);
    const mgr = createAgentServerManager(
      makeConfig({
        agentServer: { manage: true, url: "http://127.0.0.1:1", port: 1, maxRestarts: 1 },
      }),
      spawner,
      { readyTimeoutMs: 50, pollIntervalMs: 10 }, // health poll stays fast; maxRestarts comes from config
    );

    await expect(mgr.getClient()).rejects.toThrow(/aborting/);
    expect(spawned.length).toBe(2); // 1 initial + 1 restart (config maxRestarts, not the 3 default)
  });

  test("alive-but-unhealthy sidecar does not hang the restart loop", async () => {
    const spawner: AgentServerSpawner = {
      async spawn() {
        const stub = startAgentStub({ healthy: false });
        return {
          pid: 1,
          baseUrl: stub.url,
          kill: () => {
            try {
              stub.close();
            } catch {}
          },
          // stderr never resolves — simulates a wedged process whose pipe never closes
          stderr: new Promise<string>(() => {}),
        };
      },
    };
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    const outcome = await Promise.race([
      mgr.getClient().then(
        () => "RESOLVED",
        (err: Error) => `REJECTED: ${err.message}`,
      ),
      sleep(2000).then(() => "HANG"),
    ]);
    expect(outcome).toContain("aborting");
  });

  test("surfaces a spawn failure with a clear diagnostic (missing uvx)", async () => {
    const spawner: AgentServerSpawner = {
      async spawn() {
        throw new Error("uvx: command not found");
      },
    };
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    await expect(mgr.getClient()).rejects.toThrow(/spawn failed.*uvx.*Python ≥ 3\.12/s);
  });

  test("stop() kills the spawned process", async () => {
    const { spawner, spawned } = makeFakeSpawner();
    const mgr = makeManager(makeConfig(agentServerConfig(true, "http://127.0.0.1:1", 1)), spawner);

    await mgr.getClient();
    expect(spawned.length).toBe(1);

    await mgr.stop();
    // The process was killed (stub closed); the next getClient must spawn fresh.
    const client = await mgr.getClient();
    expect(spawned.length).toBe(2);
    expect(client).toBeDefined();
  });
});

// ── manage: false — BYO server ────────────────────────────────────────────────

describe("createAgentServerManager (manage: false)", () => {
  test("never spawns; returns a client for a healthy BYO url", async () => {
    const stub = startAgentStub();
    try {
      const { spawner, spawned } = makeFakeSpawner();
      const mgr = makeManager(makeConfig(agentServerConfig(false, stub.url, 0)), spawner);

      const client = await mgr.getClient();
      const conv = await client.createConversation({});

      expect(spawned.length).toBe(0);
      expect(conv.id).toBeDefined();
    } finally {
      stub.close();
    }
  });

  test("fails fast when the BYO url is unhealthy", async () => {
    const stub = startAgentStub({ healthy: false });
    try {
      const { spawner } = makeFakeSpawner();
      const mgr = makeManager(makeConfig(agentServerConfig(false, stub.url, 0)), spawner);

      await expect(mgr.getClient()).rejects.toThrow(/not healthy.*manage: false/s);
    } finally {
      stub.close();
    }
  });
});