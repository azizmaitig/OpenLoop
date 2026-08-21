import { describe, expect, test } from "bun:test";
import {
  TranscriptCollector,
  reconstructTranscript,
  DEFAULT_TRANSCRIPT_TAIL,
} from "../src/transcript.js";
import type { OpenCodeStreamEvent } from "../src/opencode-client.js";

function ev(data: Record<string, unknown>): OpenCodeStreamEvent {
  return { event: "message", data };
}

// ── TranscriptCollector — event-driven collection ───────────────────────────

describe("TranscriptCollector", () => {
  test("records tool called/success/failed and renders them in bounded text", () => {
    const c = new TranscriptCollector();
    c.record(ev({ type: "session.next.tool.called", callID: "call_1", tool: "bash", input: { cmd: "ls" } }));
    c.record(ev({ type: "session.next.tool.success", callID: "call_1", result: "file.txt" }));
    c.record(ev({ type: "session.next.tool.called", callID: "call_2", tool: "edit", input: { filePath: "a.ts" } }));
    c.record(ev({ type: "session.next.tool.failed", callID: "call_2", error: { message: "permission denied" } }));
    c.record(ev({ type: "session.next.text.ended", text: "done editing" }));

    const text = c.toBoundedText();
    expect(text).toContain("bash");
    expect(text).toContain("file.txt");
    expect(text).toContain("edit");
    expect(text).toContain("permission denied");
    expect(text).toContain("done editing");
  });

  test("collects patch parts from sync message.part.updated events", () => {
    const c = new TranscriptCollector();
    c.record(ev({
      type: "sync",
      syncEvent: {
        type: "message.part.updated.1",
        data: {
          sessionID: "ses_1",
          part: { type: "patch", hash: "abc123", files: ["src/a.ts", "src/b.ts"] },
          time: 1,
        },
      },
    }));
    const text = c.toBoundedText();
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
  });

  test("counts steps, tools, patches in the header", () => {
    const c = new TranscriptCollector();
    c.record(ev({ type: "session.next.step.ended", finish: "done" }));
    c.record(ev({ type: "session.next.step.ended", finish: "done" }));
    c.record(ev({ type: "session.next.tool.called", callID: "call_1", tool: "bash", input: {} }));
    c.record(ev({
      type: "sync",
      syncEvent: {
        type: "message.part.updated.1",
        data: { sessionID: "ses_1", part: { type: "patch", hash: "h", files: ["x.ts"] }, time: 1 },
      },
    }));

    const text = c.toBoundedText();
    expect(text).toMatch(/steps=2/);
    expect(text).toMatch(/tools=1/);
    expect(text).toMatch(/patches=1/);
  });

  test("caps bounded text at the tail cap while keeping the header", () => {
    const c = new TranscriptCollector();
    c.record(ev({ type: "session.next.text.ended", text: "final message" }));
    for (let i = 0; i < 20; i++) {
      c.record(ev({ type: "session.next.tool.called", callID: `call_${i}`, tool: "bash", input: { cmd: "x".repeat(500) } }));
      c.record(ev({ type: "session.next.tool.success", callID: `call_${i}`, result: "y".repeat(500) }));
    }

    const cap = 2000;
    const text = c.toBoundedText(cap);
    expect(text.length).toBeLessThanOrEqual(cap);
    expect(text).toContain("steps=");
    expect(text).toContain("final message");
    expect(text).toContain("truncated");
  });

  test("toJsonl emits one JSON line per entry, each parseable", () => {
    const c = new TranscriptCollector();
    c.record(ev({ type: "session.next.tool.called", callID: "call_1", tool: "bash", input: { cmd: "ls" } }));
    c.record(ev({ type: "session.next.tool.called", callID: "call_2", tool: "edit", input: { filePath: "a.ts" } }));
    c.record(ev({ type: "session.next.text.ended", text: "DONE" }));

    const lines = c.toJsonl().trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("kind");
      expect(parsed).toHaveProperty("ts");
    }
  });

  test("default tail cap is the ADR-0015 2000 chars", () => {
    expect(DEFAULT_TRANSCRIPT_TAIL).toBe(2000);
  });
});

// ── reconstructTranscript — post-crash refetch from message/part endpoints ───

describe("reconstructTranscript", () => {
  test("rebuilds from messages carrying tool + patch + text parts", () => {
    const collector = reconstructTranscript([
      {
        info: { id: "msg_1", role: "assistant" },
        parts: [
          { type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { cmd: "ls" }, output: "file.txt" } },
          { type: "tool", callID: "call_2", tool: "edit", state: { status: "error", input: { filePath: "a.ts" }, error: "denied" } },
          { type: "patch", hash: "abc123", files: ["src/a.ts"] },
          { type: "text", text: "all done" },
        ],
      },
    ]);

    const text = collector.toBoundedText();
    expect(text).toContain("bash");
    expect(text).toContain("file.txt");
    expect(text).toContain("denied");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("all done");
    expect(text).toMatch(/tools=2/);
    expect(text).toMatch(/patches=1/);
  });

  test("maps ToolPart state.status completed→success and error→failed", () => {
    const collector = reconstructTranscript([
      {
        info: { id: "msg_1", role: "assistant" },
        parts: [
          { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", output: "ok" } },
          { type: "tool", callID: "c2", tool: "edit", state: { status: "error", error: "boom" } },
        ],
      },
    ]);

    const text = collector.toBoundedText();
    expect(text).toContain("ok");
    expect(text).toContain("boom");
    expect(text).toMatch(/failedTools=1/);
  });
});