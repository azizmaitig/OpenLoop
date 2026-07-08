import { describe, expect, test } from "bun:test";
// Imports resolve via Bun's .js → .ts automatic extension resolution
import { parsePlanYaml, stringifyPlanYaml } from "../src/plan-executor.js";
import type { PlanYamlTask, PlanYamlDoc } from "../src/types.js";

const FIXTURE_PATH = "__tests__/fixtures/sample.plan.yaml";

describe("parsePlanYaml", () => {
  test("parses sample.plan.yaml — returns PlanYamlDoc with planName and 3 tasks", async () => {
    const doc = await parsePlanYaml(FIXTURE_PATH);
    expect(doc.planName).toBe("test-fixture");
    expect(doc.tasks).toHaveLength(3);
  });

  test("creates PlanYamlTask with no llm — command-only task", async () => {
    const doc = await parsePlanYaml(FIXTURE_PATH);
    const setupTask = doc.tasks.find((t: PlanYamlTask) => t.id === "setup");
    expect(setupTask).toBeDefined();
    expect(setupTask!.command).toBe("echo 'setup complete'");
    expect(setupTask!.timeoutMs).toBe(5000);
    expect(setupTask!.llm).toBeUndefined();
  });

  test("creates PlanYamlTask with llm — has correct sub-fields", async () => {
    const doc = await parsePlanYaml(FIXTURE_PATH);
    const buildTask = doc.tasks.find((t: PlanYamlTask) => t.id === "build");
    expect(buildTask).toBeDefined();
    expect(buildTask!.command).toBe("echo 'build complete'");
    expect(buildTask!.llm).toBeDefined();
    expect(buildTask!.llm!.mcpServer).toBe("filesystem");
    expect(buildTask!.llm!.tool).toBe("write");
    expect(buildTask!.llm!.prompt).toBe("write build artifact");
  });

  test("verify task has command and timeout but no llm", async () => {
    // Third task in the fixture: command-only with timeout
    const doc = await parsePlanYaml(FIXTURE_PATH);
    const verifyTask = doc.tasks.find((t: PlanYamlTask) => t.id === "verify");
    expect(verifyTask).toBeDefined();
    expect(verifyTask!.command).toBe("echo 'verify complete'");
    expect(verifyTask!.timeoutMs).toBe(10000);
    expect(verifyTask!.llm).toBeUndefined();
  });

  test("empty task list returns empty tasks array", async () => {
    // ponytail: use inline YAML or a dedicated fixture when added
    const doc = await parsePlanYaml("__tests__/fixtures/empty.plan.yaml");
    expect(doc.tasks).toEqual([]);
  });

  test("non-existent file throws an error", async () => {
    await expect(
      parsePlanYaml("__tests__/fixtures/nonexistent.yaml"),
    ).rejects.toThrow();
  });

  test("invalid YAML content throws an error", async () => {
    await expect(
      parsePlanYaml("__tests__/fixtures/invalid.yaml"),
    ).rejects.toThrow();
  });
});

describe("stringifyPlanYaml", () => {
  test("serializes PlanYamlDoc with planName and task status fields", () => {
    const doc: PlanYamlDoc = {
      planName: "test-fixture",
      tasks: [
        {
          id: "setup",
          command: "echo setup",
          timeoutMs: 5000,
        },
      ],
    };
    const output = stringifyPlanYaml(doc);
    expect(output).toContain("test-fixture");
    expect(output).toContain("setup");
    expect(output).toContain("echo setup");
  });

  test("round-trips through parsePlanYaml", async () => {
    const original = await parsePlanYaml(FIXTURE_PATH);
    const serialized = stringifyPlanYaml(original);
    const reparsed = await parsePlanYaml(serialized);
    expect(reparsed.planName).toBe(original.planName);
    expect(reparsed.tasks).toHaveLength(original.tasks.length);
  });

  test("serializes llm sub-fields", () => {
    const doc: PlanYamlDoc = {
      planName: "llm-test",
      tasks: [
        {
          id: "build",
          command: "echo build",
          llm: {
            mcpServer: "filesystem",
            tool: "write",
            prompt: "write artifact",
          },
        },
      ],
    };
    const output = stringifyPlanYaml(doc);
    expect(output).toContain("mcpServer: filesystem");
    expect(output).toContain("tool: write");
    expect(output).toContain("prompt: write artifact");
  });

  test("handles empty tasks array", () => {
    const doc: PlanYamlDoc = {
      planName: "empty-test",
      tasks: [],
    };
    const output = stringifyPlanYaml(doc);
    expect(output).toContain("planName: empty-test");
  });
});
