import { describe, expect, test } from "bun:test";
import type { PlanYamlTask, PlanYamlDoc, PlanContext } from "../src/types.js";

describe("PlanYamlTask", () => {
  test("constructs with minimal fields", () => {
    const task: PlanYamlTask = { id: "test", command: "echo hello" };
    expect(task.id).toBe("test");
    expect(task.command).toBe("echo hello");
  });

  test("constructs with timeoutMs", () => {
    const task: PlanYamlTask = { id: "scan", command: "ls", timeoutMs: 5000 };
    expect(task.timeoutMs).toBe(5000);
  });

  test("constructs with optional llm config", () => {
    const task: PlanYamlTask = {
      id: "llm-task",
      command: "analyze",
      llm: { mcpServer: "playwright", tool: "snapshot", prompt: "check page" },
    };
    expect(task.llm?.mcpServer).toBe("playwright");
    expect(task.llm?.tool).toBe("snapshot");
    expect(task.llm?.prompt).toBe("check page");
  });

  test("llm fields are all optional", () => {
    const task: PlanYamlTask = {
      id: "partial",
      command: "run",
      llm: { prompt: "just a prompt" },
    };
    expect(task.llm?.prompt).toBe("just a prompt");
    expect(task.llm?.mcpServer).toBeUndefined();
    expect(task.llm?.tool).toBeUndefined();
  });
});

describe("PlanYamlDoc", () => {
  test("constructs with planName and tasks", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "t1", command: "echo first" },
        { id: "t2", command: "echo second", timeoutMs: 3000 },
      ],
    };
    expect(doc.planName).toBe("test-plan");
    expect(doc.tasks).toHaveLength(2);
    expect(doc.tasks[0].id).toBe("t1");
  });
});

describe("PlanContext", () => {
  test("constructs with planPath and plan", () => {
    const task: PlanYamlTask = { id: "x", command: "y" };
    const doc: PlanYamlDoc = { planName: "p", tasks: [task] };
    const ctx: PlanContext = { planPath: "/tmp/plan.yaml", plan: doc };
    expect(ctx.planPath).toBe("/tmp/plan.yaml");
    expect(ctx.plan.planName).toBe("p");
  });
});
