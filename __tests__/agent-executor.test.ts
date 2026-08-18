import { describe, expect, test } from "bun:test";
import type { LoopConfig, PhaseDef } from "../src/types.js";
import { executeAgentPhase } from "../src/agent-executor.js";
import type { DockerRunner } from "../src/docker.js";
import { startAgentStub } from "./helpers/agent-stub.js";
import type { StubServer } from "./helpers/agent-stub.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgentPhase(overrides?: Partial<PhaseDef>): PhaseDef {
  return {
    name: "analyze",
    type: "agent",
    prompt: "Analyze the auth module.",
    timeoutMs: 5000,
    expectedExitCode: 0,
    ...overrides,
  };
}

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

function runAgent(
  config: LoopConfig,
  phase: PhaseDef,
  timeoutMs?: number,
  signal?: AbortSignal,
) {
  return executeAgentPhase(config, phase, timeoutMs, signal);
}

function makeFakeDockerRunner() {
  const spawned: { stub: StubServer; stopped: boolean }[] = [];
  const runner: DockerRunner = {
    async runContainer() {
      const stub = startAgentStub({ terminalStatus: "finished" });
      const record = { stub, stopped: false };
      spawned.push(record);
      return {
        name: `agent-server-test-${spawned.length}`,
        hostPort: Number(new URL(stub.url).port),
        stop: async () => {
          record.stopped = true;
          stub.close();
        },
      };
    },
  };
  return { runner, spawned };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── executeAgentPhase ─────────────────────────────────────────────────────────

describe("executeAgentPhase", () => {
  test("finished conversation → pass, stdout = last agent message", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Analyze the auth module.");
      expect(result.stderr).toBe("");
    } finally {
      stub.close();
    }
  });

  test("failed conversation → fail with exitCode 1 and a status message", async () => {
    const stub = startAgentStub({ terminalStatus: "failed" });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("failed");
      expect(result.stdout).toContain("Analyze the auth module.");
    } finally {
      stub.close();
    }
  });

  test("aborted conversation → fail", async () => {
    const stub = startAgentStub({ terminalStatus: "aborted" });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("aborted");
    } finally {
      stub.close();
    }
  });

  test("conversation that never terminates → error on per-phase timeout", async () => {
    const stub = startAgentStub(); // no terminalStatus — runs forever
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
        100, // tiny timeout
      );
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("timed out");
    } finally {
      stub.close();
    }
  });

  test("omitted timeoutMs falls back to config.phaseTimeoutMs — never polls forever", async () => {
    const stub = startAgentStub(); // no terminalStatus — only the timeout stops it
    try {
      const result = await runAgent(
        makeConfig({
          phaseTimeoutMs: 100,
          agentServer: { manage: false, url: stub.url, port: 0 },
        }),
        makeAgentPhase({ timeoutMs: undefined }),
      );
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("timed out");
    } finally {
      stub.close();
    }
  });

  test("sends the phase prompt as the conversation message", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ prompt: "Do the thing now." }),
      );
      const id = stub.createdId;
      expect(id).toBeDefined();
      const sent = stub.calls.find(
        (c) => c.method === "POST" && c.path === `/api/conversations/${id}/events`,
      );
      const content = (sent?.body as { content?: string })?.content ?? "";
      expect(content).toContain("Do the thing now.");
      expect(content).toContain(".env"); // denylist instruction injected (trust tier)
      expect(content).toContain("auth/");
    } finally {
      stub.close();
    }
  });

  test("passes model + workspace type to conversation creation", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    try {
      const result = await executeAgentPhase(
        makeConfig(),
        makeAgentPhase({
          workspace: { type: "docker" },
          model: { provider: "ollama", model: "qwen2.5-coder" },
        }),
        undefined,
        undefined,
        undefined,
        runner,
      );
      expect(result.status).toBe("pass");
      const create = spawned[0]!.stub.calls.find(
        (c) => c.method === "POST" && c.path === "/api/conversations",
      );
      expect(create?.body).toEqual({
        model: { provider: "ollama", model: "qwen2.5-coder" },
        workspaceType: "docker",
        workingDir: "/workspace",
      });
    } finally {
      for (const c of spawned) c.stub.close();
    }
  });

  test("deletes the conversation after a terminal state (cleanup)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      const id = stub.createdId;
      expect(id).toBeDefined();
      expect(stub.calls.some((c) => c.method === "DELETE" && c.path === `/api/conversations/${id}`)).toBe(true);
      expect(stub.conversations.size).toBe(0);
    } finally {
      stub.close();
    }
  });

  test("server error at create → error result, not a throw", async () => {
    const stub = startAgentStub({ failCreate: true });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("Agent Server");
    } finally {
      stub.close();
    }
  });

  test("missing prompt → error result without any HTTP traffic", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ prompt: undefined }),
      );
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("prompt");
      expect(stub.calls.length).toBe(0);
    } finally {
      stub.close();
    }
  });

  test("local workspace targets the loop's working directory (AC1)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ workspace: { type: "local" } }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      expect((create?.body as { workingDir?: string }).workingDir).toBe(process.cwd());
    } finally {
      stub.close();
    }
  });

  test("omitted workspace targets the loop's working directory (local default, AC1)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ workspace: undefined }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      expect((create?.body as { workingDir?: string }).workingDir).toBe(process.cwd());
    } finally {
      stub.close();
    }
  });

  test("docker workspace targets /workspace (verified agent-server container convention)", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    try {
      const result = await executeAgentPhase(
        makeConfig(),
        makeAgentPhase({ workspace: { type: "docker" } }),
        undefined,
        undefined,
        undefined,
        runner,
      );
      expect(result.status).toBe("pass");
      const create = spawned[0]!.stub.calls.find(
        (c) => c.method === "POST" && c.path === "/api/conversations",
      );
      expect((create?.body as { workingDir?: string }).workingDir).toBe("/workspace");
    } finally {
      for (const c of spawned) c.stub.close();
    }
  });

  test("denylist instruction is injected into the sent prompt (AC3)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ prompt: "Analyze the auth module." }),
      );
      const id = stub.createdId;
      const sent = stub.calls.find(
        (c) => c.method === "POST" && c.path === `/api/conversations/${id}/events`,
      );
      const content = (sent?.body as { content?: string })?.content ?? "";
      for (const token of [".env", "auth/", "payments/", "secrets/", "credentials/"]) {
        expect(content).toContain(token);
      }
      expect(content).toContain("Analyze the auth module.");
      expect(content).toContain("SAFETY");
    } finally {
      stub.close();
    }
  });

  test("docker workspace runs through a per-task containerized sidecar and cleans up", async () => {
    const { runner, spawned } = makeFakeDockerRunner();
    try {
      const result = await executeAgentPhase(
        makeConfig(),
        makeAgentPhase({ workspace: { type: "docker" } }),
        undefined,
        undefined,
        undefined,
        runner,
      );
      expect(result.status).toBe("pass");
      expect(spawned.length).toBe(1); // per-task container
      expect(spawned[0]!.stopped).toBe(true); // container stopped after the phase
    } finally {
      for (const c of spawned) c.stub.close();
    }
  });

  test("local workspace never spawns a container", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    const { runner, spawned } = makeFakeDockerRunner();
    try {
      const result = await executeAgentPhase(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ workspace: { type: "local" } }),
        undefined,
        undefined,
        undefined,
        runner,
      );
      expect(result.status).toBe("pass");
      expect(spawned.length).toBe(0);
    } finally {
      stub.close();
      for (const c of spawned) c.stub.close();
    }
  });

  test("abort signal stops polling and produces an error result", async () => {
    const stub = startAgentStub(); // runs forever — only the abort stops it
    const ac = new AbortController();
    try {
      const promise = runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
        5000,
        ac.signal,
      );
      setTimeout(() => ac.abort(), 50);
      const result = await promise;
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("cancelled");
    } finally {
      stub.close();
    }
  });

  test("sidecar crash mid-conversation fails the phase — no hang (AC5)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished", terminalAfter: 999 });
    try {
      const promise = runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
        5000,
      );
      await sleep(100); // let the conversation start, then kill the sidecar
      stub.close();

      const result = await Promise.race([promise, sleep(2000).then(() => null)]);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("error");
      expect(result!.stderr).toContain("Agent Server");
    } finally {
      stub.close();
    }
  });
});

// ── stubs are real servers, so give the harness a moment-free teardown ────────
test("stub helper starts on an ephemeral port", () => {
  const stub: StubServer = startAgentStub();
  try {
    expect(new URL(stub.url).port).toMatch(/^\d+$/);
  } finally {
    stub.close();
  }
});