import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveTaskHistory, readTaskHistory, listTaskHistory, historyDirExists } from "../src/history.js";
import type { Task } from "../src/types.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "history-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-test-1",
    command: "echo hello",
    status: "completed",
    createdAt: "2026-07-05T00:00:00.000Z",
    startedAt: "2026-07-05T00:00:01.000Z",
    completedAt: "2026-07-05T00:00:02.000Z",
    exitCode: 0,
    stdout: "hello",
    stderr: "",
    durationMs: 1000,
    ...overrides,
  };
}

describe("history", () => {
  test("saveTaskHistory writes task.json to _loop-history/<taskId>/", async () => {
    const task = makeTask();
    const path = await saveTaskHistory(tmpDir, task);
    expect(path).toContain("task-test-1");
    expect(path).toContain("task.json");
    expect(path).toContain("_loop-history");

    const entry = await readTaskHistory(tmpDir, "task-test-1");
    expect(entry).not.toBeNull();
    expect(entry!.task.id).toBe("task-test-1");
    expect(entry!.task.command).toBe("echo hello");
    expect(entry!.task.status).toBe("completed");
    expect(entry!.task.exitCode).toBe(0);
    expect(entry!.task.stdout).toBe("hello");
    expect(entry!.phases).toEqual([]);
  });

  test("saveTaskHistory with phases persists phase logs", async () => {
    const task = makeTask({ id: "task-phases-1" });
    const phases = [
      { name: "scan", command: "echo scan", startedAt: "2026-07-05T00:00:01.000Z", completedAt: "2026-07-05T00:00:02.000Z", exitCode: 0, stdout: "scan done", stderr: "", durationMs: 500 },
      { name: "report", command: "echo report", startedAt: "2026-07-05T00:00:02.000Z", completedAt: "2026-07-05T00:00:03.000Z", exitCode: 0, stdout: "report done", stderr: "", durationMs: 500 },
    ];
    await saveTaskHistory(tmpDir, task, phases);

    const entry = await readTaskHistory(tmpDir, "task-phases-1");
    expect(entry!.phases.length).toBe(2);
    expect(entry!.phases[0].name).toBe("scan");
    expect(entry!.phases[1].name).toBe("report");
    expect(entry!.phases[0].stdout).toBe("scan done");
  });

  test("readTaskHistory returns null for nonexistent task", async () => {
    const entry = await readTaskHistory(tmpDir, "nonexistent");
    expect(entry).toBeNull();
  });

  test("listTaskHistory returns paginated results sorted by date desc", async () => {
    // Save several tasks
    for (let i = 0; i < 5; i++) {
      const task = makeTask({
        id: `task-batch-${i}`,
        command: `echo task-${i}`,
        createdAt: `2026-07-0${5 - i}T00:00:00.000Z`, // newest first
      });
      await saveTaskHistory(tmpDir, task);
    }

    const result = await listTaskHistory(tmpDir, 1, 3);
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.tasks.length).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(3);

    // Page 2
    const page2 = await listTaskHistory(tmpDir, 2, 3);
    expect(page2.tasks.length).toBeGreaterThanOrEqual(2);
  });

  test("listTaskHistory returns empty list when no history dir exists", async () => {
    const result = await listTaskHistory("/nonexistent/path");
    expect(result.tasks).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("listTaskHistory entries have correct shape", async () => {
    const result = await listTaskHistory(tmpDir, 1, 10);
    for (const entry of result.tasks) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("command");
      expect(entry).toHaveProperty("status");
      expect(entry).toHaveProperty("createdAt");
      // completed tasks should have completedAt and durationMs
      if (entry.status === "completed") {
        expect(entry.completedAt).toBeDefined();
        expect(entry.durationMs).toBeDefined();
      }
    }
  });

  test("historyDirExists returns true/false correctly", () => {
    expect(historyDirExists(tmpDir)).toBe(true);
    expect(historyDirExists("/nonexistent")).toBe(false);
  });

  test("saveTaskHistory handles failed tasks", async () => {
    const task = makeTask({
      id: "task-failed-1",
      status: "failed",
      exitCode: 1,
      stderr: "command not found",
      error: "execution failed",
    });
    await saveTaskHistory(tmpDir, task);

    const entry = await readTaskHistory(tmpDir, "task-failed-1");
    expect(entry!.task.status).toBe("failed");
    expect(entry!.task.exitCode).toBe(1);
    expect(entry!.task.error).toBe("execution failed");
    expect(entry!.task.stderr).toBe("command not found");
  });

  test("readTaskHistory returns full HistoryEntry with all fields", async () => {
    const task = makeTask({ id: "task-full-1" });
    await saveTaskHistory(tmpDir, task);
    const entry = await readTaskHistory(tmpDir, "task-full-1");
    expect(entry!.task.id).toBe("task-full-1");
    expect(entry!.task.command).toBe("echo hello");
    expect(entry!.task.createdAt).toBe("2026-07-05T00:00:00.000Z");
    expect(entry!.task.startedAt).toBe("2026-07-05T00:00:01.000Z");
    expect(entry!.task.completedAt).toBe("2026-07-05T00:00:02.000Z");
    expect(entry!.task.exitCode).toBe(0);
    expect(entry!.task.stdout).toBe("hello");
    expect(entry!.task.durationMs).toBe(1000);
  });
});
