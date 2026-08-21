// __tests__/integration-opencode-live.test.ts
// Live integration test against the REAL opencode server on :4096 (v11 T8 #41).
// Proves the round-trip: a session is created, a prompt is sent, the agent
// works (real tool calls), and the bounded transcript collects the evidence
// (tool call → result, anti-hallucination proof).
//
// Environment-gated: the whole file SKIPS with a clear message when the server
// is down (pattern: agentmemory integration tests + the BYO agent-server test).
//
// NOTE (2026-08-20, infra discovery): the SSE event stream
// (`GET /api/session/{id}/event`) delivers NOTHING on the docker-hosted
// opencode server currently on :4096, even on a live session (curl and
// Invoke-WebRequest both time out with zero bytes). The T6 probe proved the
// stream works on the NATIVE server. The executor's primary path (event
// stream) is covered by unit tests against the HTTP stub; this live test uses
// the documented post-crash reconstruction path (ADR-0024 D3b) — the message
// endpoints — which reads the SAME stored messages/parts the stream would
// have delivered. Server-infra defect to re-check when the native server is
// back on :4096.

import { describe, expect, test } from "bun:test";
import { createOpenCodeClient } from "../src/opencode-client.js";
import { reconstructSessionTranscript } from "../src/agent-executor.js";
import { TranscriptCollector } from "../src/transcript.js";
import type { LoopConfig } from "../src/types.js";

const BASE_URL = process.env.OPENCODE_LIVE_URL ?? "http://127.0.0.1:4096";
// Env-gated BY DESIGN (handoff T8 §5: "test.skip par défaut sauf env"): the
// live tests only run with OPENCODE_LIVE=1 — a real session costs real tokens
// and would otherwise run inside every full-suite pass. Reachability alone
// must NOT enable them (they also interfere with other tests when the server
// is up). Run: `OPENCODE_LIVE=1 bun test __tests__/integration-opencode-live.test.ts`
const LIVE_ENABLED = process.env.OPENCODE_LIVE === "1";

async function serverReachable(): Promise<boolean> {
  const client = createOpenCodeClient(BASE_URL);
  return client.checkHealth();
}

const reachable = LIVE_ENABLED && (await serverReachable().catch(() => false));

function makeConfig(): LoopConfig {
  return {
    taskName: "integration",
    maxIterations: 1,
    phaseTimeoutMs: 120000,
    phases: [],
    memory: { enabled: false },
    opencodeServer: { url: BASE_URL, idleTimeoutMs: 60000, transcriptTailChars: 4000 },
  };
}

async function runLiveRoundTrip(prompt: string): Promise<{
  transcript: string;
  jsonl: string;
  sessionId: string;
}> {
  const client = createOpenCodeClient(BASE_URL);
  await client.assertHealthy();
  const session = await client.createSession();
  await client.sendPrompt(session.id, prompt);
  // Poll the stored messages until an ASSISTANT reply has finished (finish
  // is set on the last assistant message). The prompt text itself contains
  // the marker, so matching the transcript alone would break immediately —
  // wait for a real response message. Polling the message endpoint is the
  // documented reconstruction fallback; the executor's stream path is
  // unit-tested.
  const deadline = Date.now() + 120000;
  let transcript = "";
  let jsonl = "";
  for (;;) {
    const messages = await client.listMessages(session.id);
    const assistantFinished = messages.some(
      (m) => m.info.role === "assistant" && typeof m.info.finish === "string" && m.info.finish !== "",
    );
    if (assistantFinished) {
      const rebuilt = await reconstructSessionTranscript(client, session.id, 4000);
      transcript = rebuilt.text;
      jsonl = rebuilt.jsonl;
      break;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await client.abortSession(session.id).catch(() => {});
  return { transcript, jsonl, sessionId: session.id };
}

describe("live opencode round-trip (env-gated)", () => {
  test.skipIf(!reachable)(
    "tool call → result collected into the bounded transcript (real :4096)",
    async () => {
      const { transcript } = await runLiveRoundTrip(
        "Use a tool call to list the files in the current directory, then report " +
          "which tools you used. Reply with exactly: PROBE DONE.",
      );

      // A REAL tool call must appear in the bounded transcript — the
      // anti-hallucination proof: the agent actually touched the tools.
      expect(transcript).toMatch(/tools=[1-9]/);
      expect(transcript).toMatch(/tool:/);
    },
    180000,
  );

  test.skipIf(!reachable)(
    "DONE convention terminates and the final message is captured",
    async () => {
      const { transcript } = await runLiveRoundTrip(
        "Reply with exactly: PROBE DONE. Do not use any tools.",
      );

      expect(transcript).toMatch(/last-agent-message: PROBE DONE/);
    },
    180000,
  );
});

// ── Unit-level guard against transcript regressions (no server needed) ───────

describe("TranscriptCollector round-trip shape (unit)", () => {
  test("collects a tool call + its success result from raw events", () => {
    const collector = new TranscriptCollector();
    collector.record({
      data: {
        type: "session.next.tool.called",
        callID: "call_1",
        tool: "bash",
        input: { command: "ls" },
      },
    } as never);
    collector.record({
      data: {
        type: "session.next.tool.success",
        callID: "call_1",
        result: "README.md  src  package.json",
      },
    } as never);

    const text = collector.toBoundedText(2000);
    expect(text).toMatch(/tools=1/);
    expect(text).toMatch(/tool:bash call_1/);
    expect(text).toMatch(/→ ok:.*README\.md/);
  });

  test("collects a PatchPart from a sync event (T8 anti-hallucination anchor)", () => {
    const collector = new TranscriptCollector();
    collector.record({
      data: {
        type: "sync",
        syncEvent: {
          type: "message.part.updated.1",
          data: {
            part: {
              type: "patch",
              hash: "abc123",
              files: ["src/App.tsx"],
            },
          },
        },
      },
    } as never);

    const text = collector.toBoundedText(2000);
    expect(text).toMatch(/patches=1/);
    expect(text).toMatch(/patch:abc123 files=\[src\/App\.tsx\]/);
  });
});