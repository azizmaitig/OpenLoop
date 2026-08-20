import { describe, expect, test } from "bun:test";
import { validatePlanSchema } from "../src/plan-schema.js";
import type { PlanYamlDoc } from "../src/types.js";

function plan(tasks: PlanYamlDoc["tasks"], extras: Partial<PlanYamlDoc> = {}): PlanYamlDoc {
  return { planName: "test-plan", tasks: tasks ?? [], ...extras };
}

describe("validatePlanSchema", () => {
  test("accepts a minimal valid plan", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "verify", command: "bun test" },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("accepts a valid LLM provider and MCP llm form", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "judge", command: "type out.txt", llm: { provider: "opencode", prompt: "return {passed, reason, confidence}" } },
      { id: "mcp", command: "type out.txt", llm: { mcpServer: "fs", tool: "write", prompt: "x" } },
      { id: "verify", command: "bun test" },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("flags empty command", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "noop", command: "   " },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "empty-command")).toBe(true);
  });

  test("flags missing command", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      // @ts-expect-error intentionally omitting command
      { id: "nocmd" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "empty-command")).toBe(true);
  });

  test("flags duplicate ids", () => {
    const doc = plan([
      { id: "step", command: "echo a" },
      { id: "step", command: "echo b" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "duplicate-id")).toBe(true);
  });

  test("flags unknown llm provider", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "judge", command: "type out.txt", llm: { provider: "gemini", prompt: "x" } },
      { id: "verify", command: "bun test" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "unknown-llm-provider")).toBe(true);
  });

  test("flags llm block without prompt but NOT a valid provider", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "judge", command: "type out.txt", llm: { provider: "opencode", prompt: "" } },
      { id: "verify", command: "bun test" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "missing-llm-prompt")).toBe(true);
    // provider is valid, so unknown-llm-provider must NOT fire
    expect(errs.some((e) => e.rule === "unknown-llm-provider")).toBe(false);
  });

  test("flags MCP llm form without tool (reaches the MCP branch)", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "mcp", command: "type out.txt", llm: { mcpServer: "fs", tool: "", prompt: "x" } },
      { id: "verify", command: "bun test" },
    ]);
    const errs = validatePlanSchema(doc);
    const toolErr = errs.find((e) => e.rule === "missing-llm-tool");
    expect(toolErr).toBeDefined();
    // detail must identify the MCP form, proving the discriminated-union branch was taken
    expect(toolErr!.detail).toContain("MCP form");
    // an mcpServer-only object is not a provider form, so unknown-llm-provider must NOT fire
    expect(errs.some((e) => e.rule === "unknown-llm-provider")).toBe(false);
  });

  test("flags validator without criteria", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "gen", command: "type out.txt", validator: { criteria: "" } },
      { id: "verify", command: "bun test" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "validator-without-criteria")).toBe(true);
  });

  test("flags errors inside composites", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }, { id: "verify", command: "bun test" }],
      { composites: [{ id: "build-and-test", phases: [{ id: "compile", command: "" }] }] },
    );
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "empty-command" && e.detail.includes('Composite "build-and-test"'))).toBe(true);
  });

  test("tolerates a composite with no phases (the ?. guard)", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }, { id: "verify", command: "bun test" }],
      // @ts-expect-error intentionally omitting phases to exercise the optional-chain guard
      { composites: [{ id: "empty-composite" }] },
    );
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("rejects an l2.checklist value other than 'done' (D5 L2 gate)", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }],
      { l2: { checklist: "pending" as unknown as "done" } },
    );
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "invalid-l2-checklist");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("done");
  });

  test("rejects a non-object l2 field (D5 L2 gate)", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }],
      // @ts-expect-error intentionally invalid l2 shape
      { l2: "done" },
    );
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "invalid-l2-checklist")).toBe(true);
  });

  test("rejects an empty l2 object (checklist missing, D5 L2 gate)", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }],
      { l2: {} },
    );
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "invalid-l2-checklist")).toBe(true);
  });

  test("accepts l2.checklist: done (D5 L2 gate)", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }],
      { l2: { checklist: "done" } },
    );
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("collects multiple distinct errors at once", () => {
    const doc = plan([
      { id: "dup", command: "echo a" },
      { id: "dup", command: "echo b" },
      { id: "bad", command: "", llm: { provider: "nope", prompt: "" } },
    ]);
    const errs = validatePlanSchema(doc);
    const rules = new Set(errs.map((e) => e.rule));
    expect(rules.has("duplicate-id")).toBe(true);
    expect(rules.has("empty-command")).toBe(true);
    expect(rules.has("unknown-llm-provider")).toBe(true);
    expect(rules.has("missing-llm-prompt")).toBe(true);
  });
});

describe("agent task rules (v10, ADR-0023)", () => {
  test("accepts a valid type: agent task", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      {
        id: "analyze",
        type: "agent",
        prompt: "Analyze the auth module and report security issues.",
        workspace: { type: "docker" },
      },
      { id: "verify", command: "bun test" },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("accepts an agent task with optional agent/model fields", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      {
        id: "analyze",
        type: "agent",
        prompt: "x",
        agent: "openhands",
        model: { provider: "ollama", model: "qwen2.5-coder" },
      },
      { id: "verify", command: "bun test" },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("rejects type: agent combined with command (mutually exclusive)", () => {
    const doc = plan([
      { id: "bad", type: "agent", command: "echo hi", prompt: "x" },
    ]);
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "agent-with-command");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("mutually exclusive");
    // empty-command must NOT fire for agent tasks — the agent rule governs
    expect(errs.some((e) => e.rule === "empty-command")).toBe(false);
  });

  test("rejects an agent task without a prompt", () => {
    const doc = plan([
      { id: "bad", type: "agent" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "missing-agent-prompt")).toBe(true);
    // a command-less agent task must not trip the command-task rule
    expect(errs.some((e) => e.rule === "empty-command")).toBe(false);
  });

  test("rejects an unknown workspace.type", () => {
    const doc = plan([
      { id: "bad", type: "agent", prompt: "x", workspace: { type: "vm" } },
    ]);
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "unknown-workspace-type");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("local | docker");
  });

  test("accepts worktree: true on agent and command tasks (T6 isolation)", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "analyze", type: "agent", prompt: "x", worktree: true },
      { id: "verify", command: "bun test", worktree: true },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("rejects a non-boolean worktree field (T6 isolation)", () => {
    const doc = plan([
      { id: "analyze", type: "agent", prompt: "x", worktree: "yes" as unknown as boolean },
    ]);
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "invalid-worktree-flag");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("worktree");
  });

  test("rejects an unknown task type", () => {
    const doc = plan([
      // @ts-expect-error intentionally invalid type value
      { id: "bad", type: "robot", command: "echo hi" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "unknown-task-type")).toBe(true);
  });

  test("explicit type: command keeps the legacy command requirement", () => {
    const doc = plan([
      { id: "bad", type: "command" },
    ]);
    const errs = validatePlanSchema(doc);
    expect(errs.some((e) => e.rule === "empty-command")).toBe(true);
    expect(errs.some((e) => e.rule === "missing-agent-prompt")).toBe(false);
  });

  test("flags agent rule violations inside composites", () => {
    const doc = plan(
      [{ id: "read-state", command: "type STATE.md" }],
      {
        composites: [
          { id: "agent-step", phases: [{ id: "sub", type: "agent", command: "echo hi" }] },
        ],
      },
    );
    const errs = validatePlanSchema(doc);
    expect(
      errs.some((e) => e.rule === "agent-with-command" && e.detail.includes('Composite "agent-step"')),
    ).toBe(true);
  });

  test("rejects an agent task as the plan's first (grounding) task — trust tier (AC4)", () => {
    const doc = plan([
      { id: "analyze", type: "agent", prompt: "analyze the auth module" },
      { id: "verify", command: "bun test" },
    ]);
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "agent-grounding");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("cannot ground");
  });

  test("rejects an agent task as the plan's last (verify) task — trust tier (AC4)", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "analyze", type: "agent", prompt: "analyze the auth module" },
    ]);
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "agent-verify-gate");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("self-verify");
  });

  test("accepts an agent task bracketed by command grounding and verify tasks (AC4)", () => {
    const doc = plan([
      { id: "read-state", command: "type STATE.md" },
      { id: "analyze", type: "agent", prompt: "analyze the auth module" },
      { id: "verify", command: "bun test" },
    ]);
    expect(validatePlanSchema(doc)).toEqual([]);
  });

  test("rejects a composite use-task whose first sub-phase is an agent task (AC4 bypass)", () => {
    const doc = plan(
      [
        { id: "ground", use: "agent-step", command: "type STATE.md" },
        { id: "verify", command: "bun test" },
      ],
      {
        composites: [
          {
            id: "agent-step",
            phases: [
              { id: "sub", type: "agent", prompt: "x" },
              { id: "sub2", command: "echo ok" },
            ],
          },
        ],
      },
    );
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "agent-grounding");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("resolves to a type: agent task");
  });

  test("rejects a composite use-task whose last sub-phase is an agent task (AC4 bypass)", () => {
    const doc = plan(
      [
        { id: "read-state", command: "type STATE.md" },
        { id: "finish", use: "agent-step" },
      ],
      {
        composites: [
          {
            id: "agent-step",
            phases: [
              { id: "sub", command: "echo ok" },
              { id: "sub2", type: "agent", prompt: "x" },
            ],
          },
        ],
      },
    );
    const errs = validatePlanSchema(doc);
    const err = errs.find((e) => e.rule === "agent-verify-gate");
    expect(err).toBeDefined();
    expect(err!.detail).toContain("resolves to a type: agent task");
  });
});
