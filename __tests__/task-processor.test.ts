import { describe, expect, test } from "bun:test";
import { processQueue, executeTask, isSafeCommand } from "../src/task-processor.js";
import type { TaskContext } from "../src/task-processor.js";
import { TaskQueue } from "../src/task-queue.js";
import type { Task } from "../src/types.js";

// ── Fake TaskContext (no IO) ──────────────────────────────────────────────────

function fakeCtx(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskQueue: new TaskQueue(),
    baseDir: '.',
    getState: () => ({ status: 'running' }),
    isPaused: async () => false,
    broadcast: () => {},
    ...overrides,
  };
}

// ── isSafeCommand ─────────────────────────────────────────────────────────────

describe("isSafeCommand", () => {
  test("allows simple commands", () => {
    expect(isSafeCommand("echo hello")).toBe(true);
    expect(isSafeCommand("dir")).toBe(true);
    expect(isSafeCommand("npm run build")).toBe(true);
  });

  test("rejects commands with shell metacharacters", () => {
    expect(isSafeCommand("echo hello; rm -rf /")).toBe(false);
    expect(isSafeCommand("echo hello && ls")).toBe(false);
    expect(isSafeCommand("cat file | grep foo")).toBe(false);
    expect(isSafeCommand("echo `id`")).toBe(false);
    expect(isSafeCommand("echo $(whoami)")).toBe(false);
    expect(isSafeCommand("ls\nrm -rf")).toBe(false);
  });
});

// ── executeTask ───────────────────────────────────────────────────────────────

describe("executeTask", () => {
  test("rejects unsafe command and marks task failed", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("echo hello; rm -rf /");
    const dequeued = ctx.taskQueue.dequeue()!;

    await executeTask(dequeued, ctx);

    // ponytail: taskQueue.get() returns undefined after complete() nulls currentTask
    // Check the task object that was passed in directly
    expect(dequeued.status).toBe("failed");
    expect(dequeued.error).toContain("unsafe");
  });

  test("completes a simple echo command", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("echo hello world");
    const dequeued = ctx.taskQueue.dequeue()!;

    await executeTask(dequeued, ctx);

    expect(dequeued.status).toBe("completed");
    expect(dequeued.exitCode).toBe(0);
    expect(dequeued.stdout).toBe("hello world");
  });

  test("captures non-zero exit codes", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("cmd.exe /c exit 42");
    const dequeued = ctx.taskQueue.dequeue()!;

    await executeTask(dequeued, ctx);

    expect(dequeued.status).toBe("completed");
    expect(dequeued.exitCode).toBe(42);
  });

  test("handles LLM task shape gracefully (no real API key)", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("", {
      llm: { mcpServer: "", tool: "", prompt: "test prompt" },
    });
    const dequeued = ctx.taskQueue.dequeue()!;

    await executeTask(dequeued, ctx);

    expect(dequeued.status).toBe("failed");
  });
});

// ── processQueue ──────────────────────────────────────────────────────────────

describe("processQueue", () => {
  test("processes a single task successfully", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("echo hello");

    const count = await processQueue(ctx);

    expect(count).toBe(1);
    expect(ctx.taskQueue.length).toBe(0);
    expect(ctx.taskQueue.current).toBeNull();
  });

  test("processes multiple tasks in order", async () => {
    const ctx = fakeCtx();
    ctx.taskQueue.enqueue("echo first");
    ctx.taskQueue.enqueue("echo second");
    ctx.taskQueue.enqueue("echo third");

    const count = await processQueue(ctx);

    expect(count).toBe(3);
  });

  test("returns 0 when queue is empty", async () => {
    const ctx = fakeCtx();

    const count = await processQueue(ctx);

    expect(count).toBe(0);
  });

  test("stops processing when daemon status is not running", async () => {
    const ctx = fakeCtx({ getState: () => ({ status: 'stopped' }) });
    ctx.taskQueue.enqueue("echo hello");

    const count = await processQueue(ctx);

    expect(count).toBe(0);
  });

  test("does not dequeue when paused", async () => {
    const ctx = fakeCtx({ isPaused: async () => true });
    ctx.taskQueue.enqueue("echo hello");
    ctx.taskQueue.enqueue("echo world");

    const count = await processQueue(ctx);

    expect(count).toBe(0);
    expect(ctx.taskQueue.length).toBe(2); // tasks remain in queue
  });

  test("broadcasts on task completion", async () => {
    const broadcasts: unknown[] = [];
    const ctx = fakeCtx({ broadcast: (type, data) => { broadcasts.push({ type, data }); } });
    ctx.taskQueue.enqueue("echo hello");

    await processQueue(ctx);

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const b = broadcasts[0] as { type: string };
    expect(b.type).toBe("task_completed");
  });
});
