import { describe, expect, test, mock, spyOn, afterEach, beforeAll } from "bun:test";

// Skip all tests if agentmemory server is not running (CI, local dev without daemon)
let agentmemoryReachable = false;
beforeAll(async () => {
  try {
    const res = await fetch('http://localhost:3111/agentmemory/health');
    agentmemoryReachable = res.ok;
  } catch {
    agentmemoryReachable = false;
  }
});

// ── Mock filesystem before module imports ──
mock.module("node:fs/promises", () => ({
  mkdir: mock(() => Promise.resolve()),
}));

import {
  saveEpisodic,
  recallLessons,
  archiveSession,
  saveLesson,
  pushPulse,
} from "../src/agentmemory.js";
import type { LoopState, PhaseResult } from "../src/types.js";

// ── Helpers ──

function testState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    currentState: "done",
    iteration: 2,
    phaseResults: {
      init: { status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 100, evidencePath: "" },
      run: { status: "pass", exitCode: 0, stdout: "ok", stderr: "", durationMs: 200, evidencePath: "" },
    },
    startTime: "2026-07-03T00:00:00.000Z",
    errors: [],
    ...overrides,
  };
}

let originalFetch: typeof globalThis.fetch;
let lastUrl = "";
let lastBody: any = null;

function mockFetch(response: any, status = 200) {
  globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
    lastUrl = typeof url === "string" ? url : url.toString();
    lastBody = opts?.body ? JSON.parse(opts.body as string) : null;
    return new Response(JSON.stringify(response), { status });
  };
}

function mockFetchThrow(msg = "Connection refused") {
  globalThis.fetch = async () => { throw new Error(msg); };
}

originalFetch = globalThis.fetch;
afterEach(() => {
  lastUrl = "";
  lastBody = null;
  globalThis.fetch = originalFetch;
});

// ── Never-resolving promise (for timeout test) ──

function mockFetchHang() {
  globalThis.fetch = async (_url: RequestInfo | URL, opts?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
}

// ── saveEpisodic ──

describe("saveEpisodic", () => {
  if (!agentmemoryReachable) { test.skip("agentmemory not available", () => {}); return; }
  test("sends POST /agentmemory/remember with episodic type and session summary", async () => {
    mockFetch({ ok: true });
    await saveEpisodic(testState(), "demo");

    expect(lastUrl).toContain("/agentmemory/remember");
    expect(lastBody.type).toBe("episodic");
    expect(lastBody.project).toBe("agent-loop/demo");
    expect(lastBody.concepts).toContain("agent-loop");
    expect(lastBody.concepts).toContain("session");

    const content = JSON.parse(lastBody.content);
    expect(content.taskName).toBe("demo");
    expect(content.summary.currentState).toBe("done");
    expect(content.summary.iteration).toBe(2);
    expect(content.summary.errorCount).toBe(0);
    expect(content.summary.phases).toHaveLength(2);
  });

  test("returns null on success", async () => {
    mockFetch({ ok: true });
    const result = await saveEpisodic(testState(), "demo");
    expect(result).toBeNull();
  });

  test("returns null when server responds 500", async () => {
    mockFetch({}, 500);
    const result = await saveEpisodic(testState(), "demo");
    expect(result).toBeNull();
  });

  test("does not throw when agentmemory is unreachable", async () => {
    mockFetchThrow();
    const result = await saveEpisodic(testState(), "demo");
    expect(result).toBeNull();
  });

  test("returns null when fetch times out (AbortController fires)", async () => {
    mockFetchHang();
    const result = await saveEpisodic(testState(), "demo");
    expect(result).toBeNull();
  }, { timeout: 5000 });
});

// ── recallLessons ──

describe("recallLessons", () => {
  if (!agentmemoryReachable) { test.skip("agentmemory not available", () => {}); return; }
  test("sends POST /agentmemory/lesson/recall with task name query", async () => {
    mockFetch({ results: [] });
    await recallLessons("demo");

    expect(lastUrl).toContain("/agentmemory/lesson/recall");
    expect(lastBody.query).toBe("demo");
    expect(lastBody.project).toBe("agent-loop");
  });

  test("returns parsed results when server responds ok", async () => {
    mockFetch({ results: [{ content: "lesson 1", confidence: 0.8 }] });
    const result = await recallLessons("demo");
    expect(result).toEqual([{ content: "lesson 1", confidence: 0.8 }]);
  });

  test("returns null when results field is missing", async () => {
    mockFetch({ notResults: [] });
    const result = await recallLessons("demo");
    expect(result).toBeNull();
  });

  test("returns null when agentmemory is unreachable", async () => {
    mockFetchThrow();
    const result = await recallLessons("demo");
    expect(result).toBeNull();
  });

  test("returns null on non-200 response", async () => {
    mockFetch({}, 400);
    const result = await recallLessons("demo");
    expect(result).toBeNull();
  });
});

// ── archiveSession ──

describe("archiveSession", () => {
  if (!agentmemoryReachable) { test.skip("agentmemory not available", () => {}); return; }
  test("writes markdown archive to vault history path", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);

    const state = testState();
    await archiveSession(state, "demo-task");

    expect(writeSpy).toHaveBeenCalled();
    const callPath = writeSpy.mock.calls[0]?.[0] as string;
    expect(callPath).toContain("70-Memory/history");
    expect(callPath).toContain("-demo-task.md");

    writeSpy.mockRestore();
  });

  test("includes phase results in archive content", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);

    const phaseResult: PhaseResult = {
      status: "pass", exitCode: 0, stdout: "compiled", stderr: "", durationMs: 150, evidencePath: "",
    };
    const state = testState({ phaseResults: { build: phaseResult } });
    await archiveSession(state, "test");

    const content = writeSpy.mock.calls[0]?.[1] as string;
    expect(content).toContain("taskName: test");
    expect(content).toContain("finalState: done");
    expect(content).toContain("build");
    expect(content).toContain("status: pass");
    expect(content).toContain("150ms");

    writeSpy.mockRestore();
  });

  test("includes errors in archive when present", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);

    const state = testState({ errors: ["something broke"] });
    await archiveSession(state, "err-test");

    const content = writeSpy.mock.calls[0]?.[1] as string;
    expect(content).toContain("something broke");

    writeSpy.mockRestore();
  });

  test("returns null", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);
    const result = await archiveSession(testState(), "demo");
    expect(result).toBeNull();
    writeSpy.mockRestore();
  });

  test("uses custom basePath when provided", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);

    await archiveSession(testState(), "my-task", "custom/path");

    const callPath = writeSpy.mock.calls[0]?.[0] as string;
    expect(callPath).toContain("custom/path");
    expect(callPath).toContain("-my-task.md");
    expect(callPath).not.toContain("70-Memory/history");

    writeSpy.mockRestore();
  });

  test("falls back to _agent-loop-output when primary write fails", async () => {
    const writeSpy = spyOn(Bun, "write")
      .mockImplementationOnce(async () => { throw new Error("permission denied"); }) // primary fails
      .mockImplementationOnce(async () => 0); // fallback succeeds

    await archiveSession(testState(), "fallback-test", "bad/path");

    expect(writeSpy).toHaveBeenCalledTimes(2);
    const secondPath = writeSpy.mock.calls[1]?.[0] as string;
    expect(secondPath).toContain("_agent-loop-output/session-archive");

    writeSpy.mockRestore();
  });
});

// ── saveLesson ──

describe("saveLesson", () => {
  if (!agentmemoryReachable) { test.skip("agentmemory not available", () => {}); return; }
  test("sends POST /agentmemory/lesson/save with content and context", async () => {
    mockFetch({ ok: true });
    await saveLesson("Phase build failed with exit 1", "demo");

    expect(lastUrl).toContain("/agentmemory/lesson/save");
    expect(lastBody.content).toBe("Phase build failed with exit 1");
    expect(lastBody.context).toBe("demo");
    expect(lastBody.project).toBe("agent-loop");
  });

  test("returns null on success", async () => {
    mockFetch({ ok: true });
    const result = await saveLesson("test", "ctx");
    expect(result).toBeNull();
  });

  test("returns null when agentmemory is down", async () => {
    mockFetchThrow();
    const result = await saveLesson("test", "ctx");
    expect(result).toBeNull();
  });
});

// ── pushPulse ──

describe("pushPulse", () => {
  if (!agentmemoryReachable) { test.skip("agentmemory not available", () => {}); return; }
  test("sends POST /agentmemory/remember with pulse type and score", async () => {
    mockFetch({ ok: true });
    await pushPulse(0.75);

    expect(lastUrl).toContain("/agentmemory/remember");
    expect(lastBody.type).toBe("pulse");
    expect(lastBody.project).toBe("agent-loop");

    const content = JSON.parse(lastBody.content);
    expect(content.score).toBe(0.75);
    expect(content.timestamp).toBeDefined();
  });

  test("returns null on success", async () => {
    mockFetch({ ok: true });
    const result = await pushPulse(0.5);
    expect(result).toBeNull();
  });

  test("returns null when agentmemory is down", async () => {
    mockFetchThrow();
    const result = await pushPulse(0.0);
    expect(result).toBeNull();
  });
});
