import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DONE_CONVENTION_INSTRUCTION,
  executeAgentPhase,
  reconstructSessionTranscript,
} from "../src/agent-executor.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { startOpenCodeStub } from "./helpers/opencode-stub.js";
import { createOpenCodeClient } from "../src/opencode-client.js";
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

// ── Transcript collection (T4 #37, D3b) ─────────────────────────────────────

describe("executeAgentPhase - transcript collection", () => {
  const toolEvents = [
    { type: "session.next.tool.called", callID: "call_1", tool: "bash", input: { cmd: "ls" } },
    { type: "session.next.tool.success", callID: "call_1", result: "src\nfile.txt" },
    { type: "session.next.tool.called", callID: "call_2", tool: "edit", input: { filePath: "src/a.ts" } },
    { type: "session.next.tool.failed", callID: "call_2", error: { message: "permission denied" } },
  ];

  test("transcript contains real tool calls, results, failed-tool outputs and patch files", async () => {
    const stub = startOpenCodeStub({
      events: [
        ...toolEvents,
        {
          type: "sync",
          syncEvent: {
            type: "message.part.updated.1",
            data: {
              sessionID: "ses_1",
              part: { type: "patch", hash: "abc123", files: ["src/a.ts"] },
              time: 1,
            },
          },
        },
        { type: "session.next.text.ended", text: "DONE" },
      ],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("pass");
      expect(result.transcript).toBeDefined();
      expect(result.transcript).toContain("bash");
      expect(result.transcript).toContain("file.txt");
      expect(result.transcript).toContain("permission denied");
      expect(result.transcript).toContain("src/a.ts");
      expect(result.transcript).toContain("tools=2");
      expect(result.transcript).toContain("failedTools=1");
      expect(result.transcript).toContain("patches=1");
      // Event-driven only — no systematic refetch on the happy path
      expect(stub.messageListCount()).toBe(0);
    } finally {
      stub.close();
    }
  });

  test("full transcript is offloaded to <run>/<iter>-<task>.agent.jsonl when a run name is given", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "t4-offload-"));
    const stub = startOpenCodeStub({
      events: [...toolEvents, { type: "session.next.text.ended", text: "DONE" }],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(
        makeConfig(stub.url),
        agentPhase({ name: "audit" }),
        5000,
        undefined,
        undefined,
        undefined,
        { runName: "calendar-design", iteration: 3, outputDir: outDir },
      );
      expect(result.status).toBe("pass");
      expect(result.transcriptPath).toBeDefined();
      expect(result.transcriptPath).toContain("calendar-design");
      expect(result.transcriptPath).toContain("3-audit.agent.jsonl");
      expect(result.evidencePath).toBe(result.transcriptPath);
      expect(existsSync(result.transcriptPath!)).toBe(true);
      const lines = readFileSync(result.transcriptPath!, "utf-8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("kind");
      }
    } finally {
      stub.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("bounded transcript respects the configured tail cap", async () => {
    const big = "x".repeat(500);
    const stub = startOpenCodeStub({
      events: [
        { type: "session.next.tool.called", callID: "c1", tool: "bash", input: { cmd: big } },
        { type: "session.next.tool.success", callID: "c1", result: big.repeat(4) },
        { type: "session.next.text.ended", text: "DONE" },
      ],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(
        makeConfig(stub.url, { opencodeServer: { url: stub.url, idleTimeoutMs: 50, transcriptTailChars: 500 } }),
        agentPhase(),
        5000,
      );
      expect(result.transcript!.length).toBeLessThanOrEqual(500);
    } finally {
      stub.close();
    }
  });

  test("transcript survives timeout and failure outcomes too", async () => {
    const stub = startOpenCodeStub({
      events: [
        ...toolEvents,
        { type: "session.next.step.failed", error: "bash exited 1" },
      ],
      closeEvents: true,
    });
    try {
      const result = await executeAgentPhase(makeConfig(stub.url), agentPhase(), 5000);
      expect(result.status).toBe("fail");
      expect(result.transcript).toContain("permission denied");
      expect(result.transcript).toContain("tools=2");
    } finally {
      stub.close();
    }
  });
});

// ── Post-crash reconstruction (T4 #37, D3b refetch fallback) ────────────────

describe("reconstructSessionTranscript", () => {
  test("rebuilds the transcript from the message/part endpoints after a crash", async () => {
    const stub = startOpenCodeStub({
      messages: [
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [
            { type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { cmd: "ls" }, output: "file.txt" } },
            { type: "tool", callID: "call_2", tool: "edit", state: { status: "error", input: { filePath: "a.ts" }, error: "denied" } },
            { type: "patch", hash: "abc123", files: ["src/a.ts"] },
            { type: "text", text: "all done" },
          ],
        },
      ],
      parts: new Map([["msg_1:prt_1", { type: "patch", hash: "abc123", files: ["src/a.ts"] }]]),
    });
    try {
      const rebuilt = await reconstructSessionTranscript(createOpenCodeClient(stub.url), "ses_1");
      expect(rebuilt.text).toContain("file.txt");
      expect(rebuilt.text).toContain("denied");
      expect(rebuilt.text).toContain("src/a.ts");
      expect(rebuilt.text).toContain("all done");
      expect(rebuilt.text).toMatch(/tools=2/);
      expect(rebuilt.text).toMatch(/patches=1/);
      const lines = rebuilt.jsonl.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(4);
    } finally {
      stub.close();
    }
  });

  test("does not hit the event stream — refetch is messages-only", async () => {
    const stub = startOpenCodeStub({ messages: [] });
    try {
      await reconstructSessionTranscript(createOpenCodeClient(stub.url), "ses_1");
      const eventCalls = stub.calls.filter((c) => c.path.includes("/event"));
      expect(eventCalls.length).toBe(0);
    } finally {
      stub.close();
    }
  });
});