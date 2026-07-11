import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

function fakeLoopState(currentState = "run", iteration = 3): string {
  return JSON.stringify({
    currentState,
    iteration,
    startTime: new Date().toISOString(),
    errors: [],
    phaseResults: {
      test: {
        status: "pass",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 500,
        evidencePath: "",
        judgment: { passed: true, reason: "exit code", confidence: 1 },
      },
    },
  });
}

describe("Daemon loopState (dashboard-loop-state)", () => {
  test("GET /state includes loopState polled from STATE.md", async () => {
    const TMP = mkdtempSync(join(tmpdir(), "loop-state-"));
    writeFileSync(join(TMP, "STATE.md"), fakeLoopState("run", 3));

    const d = new Daemon(0, TMP, { loopStateDir: TMP });
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      // Bridge the 2s poll interval: wait for at least one tick.
      await new Promise((r) => setTimeout(r, 2200));

      const resp = await fetch(`http://localhost:${d.getState().port}/state`);
      expect(resp.status).toBe(200);
      const body = await resp.json();

      expect(body.loopState).not.toBeNull();
      expect(body.loopState.currentState).toBe("run");
      expect(body.loopState.iteration).toBe(3);
      expect(body.loopState.phaseResults.test.status).toBe("pass");
    } finally {
      d.stop();
      await startPromise;
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  test("getState().loopState is null when no STATE.md exists", async () => {
    const TMP = mkdtempSync(join(tmpdir(), "loop-state-"));

    const d = new Daemon(0, TMP, { loopStateDir: TMP });
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      await new Promise((r) => setTimeout(r, 2200));
      expect(d.getState().loopState).toBeNull();
    } finally {
      d.stop();
      await startPromise;
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  test("WS state_change carries loopState", async () => {
    const TMP = mkdtempSync(join(tmpdir(), "loop-state-"));
    writeFileSync(join(TMP, "STATE.md"), fakeLoopState("run", 7));

    const d = new Daemon(0, TMP, { loopStateDir: TMP });
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, 300));

    try {
      const port = d.getState().port;
      await new Promise((r) => setTimeout(r, 2200));

      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      const msg = await new Promise<any>((resolve, reject) => {
        ws.onmessage = (e) => {
          try { resolve(JSON.parse(e.data)); } catch { reject(new Error("invalid JSON")); }
        };
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      expect(msg).toHaveProperty("type", "state_change");
      expect(msg.data).toHaveProperty("loopState");
      expect(msg.data.loopState.currentState).toBe("run");
      expect(msg.data.loopState.iteration).toBe(7);
      ws.close();
    } finally {
      d.stop();
      await startPromise;
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});
