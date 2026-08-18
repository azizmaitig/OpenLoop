import { describe, expect, test } from "bun:test";
import type { PlanYamlTask, PlanYamlDoc, PlanContext } from "../src/types.js";

describe("plan type shapes", () => {
  test("PlanYamlTask, PlanYamlDoc, and PlanContext compose correctly at runtime", () => {
    const task: PlanYamlTask = {
      id: "build",
      command: "npm run build",
      timeoutMs: 30000,
      llm: { mcpServer: "fs", tool: "write", prompt: "build" },
    };
    expect(task.id).toBe("build");
    expect(task.command).toBe("npm run build");
    expect(task.timeoutMs).toBe(30000);
    expect(task.llm?.mcpServer).toBe("fs");
    expect(task.llm?.tool).toBe("write");
    expect(task.llm?.prompt).toBe("build");

    const doc: PlanYamlDoc = { planName: "ci", tasks: [task] };
    expect(doc.planName).toBe("ci");
    expect(doc.tasks).toHaveLength(1);
    expect(doc.tasks[0].id).toBe("build");

    const ctx: PlanContext = { planPath: "/tmp/ci.yaml", plan: doc };
    expect(ctx.planPath).toBe("/tmp/ci.yaml");
    expect(ctx.plan.planName).toBe("ci");

    // llm fields are all optional
    const minimal: PlanYamlTask = { id: "x", command: "y" };
    expect(minimal.llm).toBeUndefined();
    expect(minimal.timeoutMs).toBeUndefined();
  });

  test("PlanYamlTask agent shape composes (v10: type, prompt, workspace, model)", () => {
    const agentTask: PlanYamlTask = {
      id: "analyze",
      type: "agent",
      prompt: "Analyze the auth module and report security issues.",
      agent: "openhands",
      model: { provider: "ollama", model: "qwen2.5-coder" },
      workspace: { type: "docker" },
    };
    expect(agentTask.type).toBe("agent");
    expect(agentTask.prompt).toBe("Analyze the auth module and report security issues.");
    expect(agentTask.agent).toBe("openhands");
    expect(agentTask.model).toEqual({ provider: "ollama", model: "qwen2.5-coder" });
    expect(agentTask.workspace).toEqual({ type: "docker" });
    expect(agentTask.command).toBeUndefined();

    // legacy command task without an explicit type stays valid
    const legacy: PlanYamlTask = { id: "x", command: "y" };
    expect(legacy.type).toBeUndefined();
    expect(legacy.command).toBe("y");
  });
});
