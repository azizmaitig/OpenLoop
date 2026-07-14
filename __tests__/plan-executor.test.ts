import { describe, expect, test } from "bun:test";
// These imports will FAIL — ../src/plan-executor.js does not exist yet
// PlanYamlTask and PlanYamlDoc are not yet defined in types.ts
// These tests are structural stubs describing the expected API before implementation
import { parsePlanYaml, dumpPlanYaml, expandComposites } from "../src/plan-executor.js";
import type { PlanYamlTask, PlanYamlDoc, CompositeDef } from "../src/types.js";

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

describe("dumpPlanYaml", () => {
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
    const output = dumpPlanYaml(doc);
    expect(output).toContain("test-fixture");
    expect(output).toContain("setup");
    expect(output).toContain("echo setup");
  });

  test("round-trips through parsePlanYaml", async () => {
    const original = await parsePlanYaml(FIXTURE_PATH);
    const serialized = dumpPlanYaml(original);
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
    const output = dumpPlanYaml(doc);
    expect(output).toContain("mcpServer: filesystem");
    expect(output).toContain("tool: write");
    expect(output).toContain("prompt: write artifact");
  });

  test("handles empty tasks array", () => {
    const doc: PlanYamlDoc = {
      planName: "empty-test",
      tasks: [],
    };
    const output = dumpPlanYaml(doc);
    expect(output).toContain("planName: empty-test");
  });
});

// ── Composite expansion (Feature B) ─────────────────────────────────────────

describe("expandComposites", () => {
  const simpleComposite: CompositeDef = {
    id: "build-all",
    phases: [
      { id: "compile", command: "echo compile" },
      { id: "test", command: "echo test" },
    ],
  };

  test("atomic composite becomes a single task with combined command", () => {
    const composites: CompositeDef[] = [
      { ...simpleComposite, atomic: true },
    ];
    const tasks: PlanYamlTask[] = [
      { id: "do-build", command: "placeholder", use: "build-all" },
    ];

    const result = expandComposites(tasks, composites);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("do-build");
    expect(result[0].command).toBe("echo compile && echo test");
    expect(result[0].use).toBe("build-all");
  });

  test("non-atomic composite expands into sub-phases with prefixed ids", () => {
    const composites: CompositeDef[] = [
      { ...simpleComposite, atomic: false },
    ];
    const tasks: PlanYamlTask[] = [
      { id: "build-step", command: "placeholder", use: "build-all" },
    ];

    const result = expandComposites(tasks, composites);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("build-step:compile");
    expect(result[0].command).toBe("echo compile");
    expect(result[1].id).toBe("build-step:test");
    expect(result[1].command).toBe("echo test");
  });

  test("task without use passes through unchanged", () => {
    const tasks: PlanYamlTask[] = [
      { id: "plain", command: "echo hi" },
    ];

    const result = expandComposites(tasks, []);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("plain");
    expect(result[0].command).toBe("echo hi");
  });

  test("unknown composite id throws", () => {
    const tasks: PlanYamlTask[] = [
      { id: "task-a", command: "echo a", use: "nonexistent" },
    ];

    expect(() => expandComposites(tasks, [])).toThrow("Unknown composite id");
    expect(() => expandComposites(tasks, [])).toThrow("nonexistent");
  });

  test("mixed: some tasks use composite, some pass through", () => {
    const composites: CompositeDef[] = [
      { ...simpleComposite, atomic: true },
    ];
    const tasks: PlanYamlTask[] = [
      { id: "setup", command: "echo setup" },
      { id: "build-all", command: "placeholder", use: "build-all" },
    ];

    const result = expandComposites(tasks, composites);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("setup");
    expect(result[0].command).toBe("echo setup");
    expect(result[1].id).toBe("build-all");
    expect(result[1].command).toBe("echo compile && echo test");
  });
});
