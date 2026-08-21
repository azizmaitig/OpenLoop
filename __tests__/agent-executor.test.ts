import { describe, expect, test } from "bun:test";
import {
  DONE_CONVENTION_INSTRUCTION,
  executeAgentPhase,
} from "../src/agent-executor.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { startOpenCodeStub } from "./helpers/opencode-stub.js";
import type { LoopConfig, PhaseDef } from "../src/types.js";

function makeConfig(stubUrl: string, overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    ...DEFAULT_CONFIG,
    opencodeServer: { url: stubUrl, idleTimeoutMs: 50 },
    ...overrides,
  };
}

function agentPhase(overrides: Partial<PhaseDef> = {}): PhaseDef {
  return { name: "agent", type: "agent", prompt: "do the thing", ...overrides };
}

// ── executeAgentPhase ─────────────────────────────────────────────────────────

describe("executeAgentPhase", () => {
  test("DONE marker → pass, stdout = agent text, prompt carries DONE convention + denylist", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("DONE");
      expect(stub.abortCount()).toBe(0);
      const prompt = stub.lastPrompt() ?? "";
      expect(prompt).toContain(DONE_CONVENTION_INSTRUCTION);
      expect(prompt).toContain("SAFETY CONSTRAINT");
    } finally {
      stub.close();
    }
  });

  test("DONE detection is line-based — a text block ending with DONE passes", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "summary of changes\nDONE" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("pass");
      expect(result.stdout).toContain("summary of changes");
    } finally {
      stub.close();
    }
  });

  test("StepFinishPart + idle timeout → pass (hand-off, verify is the real gate)", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.step.ended", finish: "done" }],
    });
    try {
      const started = Date.now();
      const result = await executeAgentPhase(
        makeConfig(stub.url, { opencodeServer: { url: stub.url, idleTimeoutMs: 40 } }),
        agentPhase(),
        5000,
      );
      expect(result.status).toBe("pass");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(stub.abortCount()).toBe(0);
    } finally {
      stub.close();
    }
  });

  test("timeoutMs hard cap → fail + session aborted (no leaked session)", async () => {
    const stub = startOpenCodeStub();
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 150);
      expect(result.status).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("timed out");
      expect(stub.abortCount()).toBe(1);
    } finally {
      stub.close();
    }
  });

  test("step.failed event → fail + session aborted", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.step.failed", error: "bash exited 1" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("fail");
      expect(result.stderr).toContain("bash exited 1");
      expect(stub.abortCount()).toBe(1);
    } finally {
      stub.close();
    }
  });

  test("step.ended with finish 'error' → fail + session aborted", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.step.ended", finish: "error" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("fail");
      expect(result.stderr).toContain('finished with "error"');
      expect(stub.abortCount()).toBe(1);
    } finally {
      stub.close();
    }
  });

  test("external abort signal → error result 'cancelled'", async () => {
    const stub = startOpenCodeStub();
    const ac = new AbortController();
    try {
      const promise = executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000, ac.signal);
      setTimeout(() => ac.abort(), 100);
      const result = await promise;
      expect(result.status).toBe("error");
      expect(result.stderr).toBe("cancelled");
    } finally {
      stub.close();
    }
  });

  test("missing prompt → error result without any HTTP traffic", async () => {
    const stub = startOpenCodeStub();
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase({ prompt: "   " }));
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("no prompt");
      expect(stub.calls.length).toBe(0);
    } finally {
      stub.close();
    }
  });

  test("exactly one session per agent task", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("pass");
      expect(stub.sessionCreateCount()).toBe(1);
    } finally {
      stub.close();
    }
  });

  test("session created with the phase agent + model mapped to the wire shape", async () => {
    const stub = startOpenCodeStub({
      events: [{ type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      await executeAgentPhase(
        makeConfig(stub.url),
        agentPhase({ agent: "build", model: { provider: "opencode", model: "deepseek-v4" } }),
        5000,
      );
      const create = stub.calls.find((c) => c.method === "POST" && c.path === "/session");
      expect(create?.body).toEqual({
        agent: "build",
        model: { id: "deepseek-v4", providerID: "opencode" },
      });
    } finally {
      stub.close();
    }
  });

  test("stream closed without DONE → pass (stream-end hand-off, verify judges)", async () => {
    const stub = startOpenCodeStub({ closeEvents: true });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("pass");
      expect(result.stdout).toBe("");
    } finally {
      stub.close();
    }
  });

  test("server down → error result with a clear diagnostic (no hung phase)", async () => {
    const stub = startOpenCodeStub({ unhealthy: true });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("error");
      expect(result.stderr).toContain("not healthy");
    } finally {
      stub.close();
    }
  });

  test("stub helper starts on an ephemeral port", () => {
    const stub = startOpenCodeStub();
    try {
      expect(new URL(stub.url).port).toMatch(/^\d+$/);
    } finally {
      stub.close();
    }
  });
});