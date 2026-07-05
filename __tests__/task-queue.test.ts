import { describe, expect, test } from "bun:test";
import { TaskQueue } from "../src/task-queue.js";

describe("TaskQueue", () => {
  test("enqueue adds a task with queued status and returns it", () => {
    const q = new TaskQueue();
    const task = q.enqueue("echo hi");
    expect(task.id).toMatch(/^task-/);
    expect(task.command).toBe("echo hi");
    expect(task.status).toBe("queued");
    expect(typeof task.createdAt).toBe("string");
  });

  test("enqueue accepts optional timeoutMs and llm", () => {
    const q = new TaskQueue();
    const task = q.enqueue("echo hi", { timeoutMs: 5000, llm: { mcpServer: "srv", tool: "t", prompt: "p" } });
    expect(task.timeoutMs).toBe(5000);
    expect(task.llm).toEqual({ mcpServer: "srv", tool: "t", prompt: "p" });
  });

  test("dequeue returns null when queue is empty", () => {
    const q = new TaskQueue();
    expect(q.dequeue()).toBeNull();
  });

  test("dequeue returns queued task and marks it running", () => {
    const q = new TaskQueue();
    q.enqueue("echo hi");
    const task = q.dequeue();
    expect(task).not.toBeNull();
    expect(task!.status).toBe("running");
    expect(task!.startedAt).toBeDefined();
    expect(q.current).toBe(task);
    expect(q.length).toBe(0);
  });

  test("dequeue returns null while a task is already running", () => {
    const q = new TaskQueue();
    q.enqueue("task1");
    q.enqueue("task2");
    q.dequeue(); // now task1 is running
    expect(q.dequeue()).toBeNull(); // task2 stays queued
    expect(q.length).toBe(1);
  });

  test("complete marks task as completed and clears current", () => {
    const q = new TaskQueue();
    q.enqueue("echo hi");
    const task = q.dequeue()!;
    const result = q.complete(task.id, { exitCode: 0, stdout: "hi", stderr: "", durationMs: 10 });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.exitCode).toBe(0);
    expect(result!.stdout).toBe("hi");
    expect(result!.durationMs).toBe(10);
    expect(result!.completedAt).toBeDefined();
    expect(q.current).toBeNull();
  });

  test("complete returns null for unknown id", () => {
    const q = new TaskQueue();
    expect(q.complete("nonexistent", { exitCode: 0, stdout: "", stderr: "", durationMs: 0 })).toBeNull();
  });

  test("fail marks task as failed and clears current", () => {
    const q = new TaskQueue();
    q.enqueue("bad");
    const task = q.dequeue()!;
    q.fail(task.id, "something went wrong");
    expect(task.status).toBe("failed");
    expect(task.error).toBe("something went wrong");
    expect(q.current).toBeNull();
  });

  test("fail removes queued tasks from the queue", () => {
    const q = new TaskQueue();
    const task = q.enqueue("task1");
    q.enqueue("task2");
    q.fail(task.id, "cancelled before start");
    expect(q.get(task.id)).toBeUndefined();
    expect(q.length).toBe(1); // task2 still there
  });

  test("cancel removes queued task and marks cancelled", () => {
    const q = new TaskQueue();
    q.enqueue("task1");
    const task = q.enqueue("task2");
    const result = q.cancel(task.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("cancelled");
    expect(q.length).toBe(1);
  });

  test("cancel returns null for running task", () => {
    const q = new TaskQueue();
    q.enqueue("task1");
    const task = q.dequeue()!;
    expect(q.cancel(task.id)).toBeNull();
    expect(task.status).toBe("running");
  });

  test("cancel returns null for unknown id", () => {
    const q = new TaskQueue();
    expect(q.cancel("nonexistent")).toBeNull();
  });

  test("peek returns next task without removing it", () => {
    const q = new TaskQueue();
    expect(q.peek()).toBeNull();
    q.enqueue("first");
    q.enqueue("second");
    expect(q.peek()!.command).toBe("first");
    expect(q.length).toBe(2);
  });

  test("get returns task by id", () => {
    const q = new TaskQueue();
    const task = q.enqueue("echo");
    expect(q.get(task.id)!.id).toBe(task.id);
    expect(q.get("nonexistent")).toBeUndefined();
  });

  test("length returns queued count (not including running)", () => {
    const q = new TaskQueue();
    expect(q.length).toBe(0);
    q.enqueue("a");
    q.enqueue("b");
    expect(q.length).toBe(2);
    q.dequeue();
    expect(q.length).toBe(1); // one still queued, one running
  });

  test("history returns completed task IDs in reverse chronological order", () => {
    const q = new TaskQueue();
    const t1 = q.enqueue("first");
    const t2 = q.enqueue("second");
    const t3 = q.enqueue("third");

    q.dequeue(); q.complete(t1.id, { exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    q.dequeue(); q.complete(t2.id, { exitCode: 1, stdout: "", stderr: "err", durationMs: 2 });
    q.dequeue(); q.complete(t3.id, { exitCode: 0, stdout: "done", stderr: "", durationMs: 3 });

    const hist = q.history;
    expect(hist[0]).toBe(t3.id); // most recent first
    expect(hist[1]).toBe(t2.id);
    expect(hist[2]).toBe(t1.id);
  });

  test("toJSON and fromJSON serialize/deserialize state", () => {
    const q = new TaskQueue();
    const t1 = q.enqueue("task1");
    q.enqueue("task2");
    q.enqueue("task3");
    q.dequeue(); q.complete(t1.id, { exitCode: 0, stdout: "", stderr: "", durationMs: 5 });

    const json = q.toJSON();
    expect(json.queue.length).toBe(2);
    expect(json.currentTask).toBeNull();
    expect(json.history.length).toBe(1);

    const q2 = new TaskQueue();
    q2.fromJSON(json);
    expect(q2.length).toBe(2);
    expect(q2.current).toBeNull();
    expect(q2.history.length).toBe(1);
  });

  test("allTasks returns current + queued tasks", () => {
    const q = new TaskQueue();
    q.enqueue("task1");
    q.enqueue("task2");
    const running = q.dequeue()!;
    q.enqueue("task3");

    const all = q.allTasks();
    expect(all.length).toBe(3);
    expect(all[0].id).toBe(running.id); // current first
    // queued tasks in order
    expect(all[1].command).toBe("task2");
    expect(all[2].command).toBe("task3");
  });

  test("reset clears everything", () => {
    const q = new TaskQueue();
    q.enqueue("task1");
    q.enqueue("task2");
    q.reset();
    expect(q.length).toBe(0);
    expect(q.current).toBeNull();
    expect(q.history.length).toBe(0);
  });

  test("FIFO order: tasks dequeued in the order they were enqueued", () => {
    const q = new TaskQueue();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");

    expect(q.dequeue()!.command).toBe("first");
    q.complete(q.current!.id, { exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    expect(q.dequeue()!.command).toBe("second");
    q.complete(q.current!.id, { exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    expect(q.dequeue()!.command).toBe("third");
  });

  test("full lifecycle: enqueue -> dequeue -> complete -> history", () => {
    const q = new TaskQueue();
    const t = q.enqueue("echo hello");

    expect(t.status).toBe("queued");
    const running = q.dequeue()!;
    expect(running.id).toBe(t.id);
    expect(running.status).toBe("running");

    q.complete(t.id, { exitCode: 0, stdout: "hello", stderr: "", durationMs: 50 });
    expect(t.status).toBe("completed");
    expect(t.exitCode).toBe(0);
    expect(t.stdout).toBe("hello");
    expect(t.durationMs).toBe(50);
    expect(t.completedAt).toBeDefined();
    expect(q.current).toBeNull();
    expect(q.history.length).toBe(1);
    expect(q.history[0]).toBe(t.id);
  });
});
