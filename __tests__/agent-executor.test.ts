import { describe, expect, test } from "bun:test";
import type { LoopConfig, PhaseDef } from "../src/types.js";
import { executeAgentPhase } from "../src/agent-executor.js";
import { startAgentStub } from "./helpers/agent-stub.js";
import type { StubServer } from "./helpers/agent-stub.js";
import { makeFakeDockerRunner } from "./helpers/docker-stub.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── executeAgentPhase ─────────────────────────────────────────────────────────

describe("executeAgentPhase", () => {
  test("finished conversation → pass, stdout = agent final response", async () => {
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

  test("carries the phase prompt in the create payload's initial_message", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ prompt: "Do the thing now." }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      const text = ((create?.body as { initial_message?: { content?: Array<{ text?: string }> } })
        ?.initial_message?.content?.[0]?.text) ?? "";
      expect(text).toContain("Do the thing now.");
      expect(text).toContain(".env"); // denylist instruction injected (trust tier)
      expect(text).toContain("auth/");
    } finally {
      stub.close();
    }
  });

  test("creates with the real payload shape: workspace + agent.llm + initial_message", async () => {
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
      const body = create?.body as {
        workspace?: { working_dir?: string };
        agent?: { llm?: { model?: string } };
        initial_message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      expect(body.workspace).toEqual({ working_dir: "/workspace" });
      expect(body.agent?.llm?.model).toBe("ollama/qwen2.5-coder");
      expect(body.initial_message?.role).toBe("user");
      expect(body.initial_message?.content?.[0]?.type).toBe("text");
      expect(body.initial_message?.content?.[0]?.text).toContain("Analyze the auth module.");
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
      expect(((create?.body as { workspace?: { working_dir?: string } }).workspace)?.working_dir).toBe(process.cwd());
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
      expect(((create?.body as { workspace?: { working_dir?: string } }).workspace)?.working_dir).toBe(process.cwd());
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
      expect(((create?.body as { workspace?: { working_dir?: string } }).workspace)?.working_dir).toBe("/workspace");
    } finally {
      for (const c of spawned) c.stub.close();
    }
  });

  test("agentServer.defaults wire model/baseUrl/apiKey into agent.llm (snake_case wire format)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({
          agentServer: {
            manage: false,
            url: stub.url,
            port: 0,
            defaults: {
              model: "opencode/deepseek-v4-flash-free",
              baseUrl: "http://127.0.0.1:4097",
              apiKey: "sk-none",
            },
          },
        }),
        makeAgentPhase(),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      expect((create?.body as { agent?: { llm?: unknown } }).agent?.llm).toEqual({
        model: "opencode/deepseek-v4-flash-free",
        base_url: "http://127.0.0.1:4097",
        api_key: "sk-none",
      });
    } finally {
      stub.close();
    }
  });

  test("per-task model overrides agentServer.defaults model", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({
          agentServer: {
            manage: false,
            url: stub.url,
            port: 0,
            defaults: { model: "opencode/deepseek-v4-flash-free", baseUrl: "http://127.0.0.1:4097" },
          },
        }),
        makeAgentPhase({ model: { provider: "ollama", model: "qwen2.5-coder" } }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      const llm = (create?.body as { agent?: { llm?: { model?: string; base_url?: string } } }).agent?.llm;
      expect(llm?.model).toBe("ollama/qwen2.5-coder");
      expect(llm?.base_url).toBe("http://127.0.0.1:4097"); // defaults still supply the endpoint
    } finally {
      stub.close();
    }
  });

  test("no llm config anywhere → no agent block in the create payload", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ model: undefined }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      expect((create?.body as { agent?: unknown }).agent).toBeUndefined();
    } finally {
      stub.close();
    }
  });

  test("error terminal status → fail with the status in stderr", async () => {
    const stub = startAgentStub({ terminalStatus: "error" });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("error");
    } finally {
      stub.close();
    }
  });

  test("unavailable final-response endpoint → stdout falls back to conversation events", async () => {
    const stub = startAgentStub({ terminalStatus: "finished", failFinalResponse: true });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("pass");
      expect(result.stdout).toContain("Analyze the auth module."); // event echo, not the final-response text
      expect(result.stderr).toBe("");
    } finally {
      stub.close();
    }
  });

  test("legacy server responses (status instead of execution_status) still map to a terminal result", async () => {
    const stub = startAgentStub({ terminalStatus: "finished", legacyStatus: true });
    try {
      const result = await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase(),
      );
      expect(result.status).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Analyze the auth module.");
    } finally {
      stub.close();
    }
  });

  test("denylist instruction is injected into the initial_message (AC3)", async () => {
    const stub = startAgentStub({ terminalStatus: "finished" });
    try {
      await runAgent(
        makeConfig({ agentServer: { manage: false, url: stub.url, port: 0 } }),
        makeAgentPhase({ prompt: "Analyze the auth module." }),
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/conversations");
      const text = ((create?.body as { initial_message?: { content?: Array<{ text?: string }> } })
        ?.initial_message?.content?.[0]?.text) ?? "";
      for (const token of [".env", "auth/", "payments/", "secrets/", "credentials/"]) {
        expect(text).toContain(token);
      }
      expect(text).toContain("Analyze the auth module.");
      expect(text).toContain("SAFETY");
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