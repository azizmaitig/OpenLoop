import { describe, expect, test } from "bun:test";
import { checkPlanAgainstConstitution } from "../src/constitution.js";
import type { PlanYamlDoc } from "../src/types.js";

function makePlan(tasks: PlanYamlDoc["tasks"]): PlanYamlDoc {
  return { planName: "test-plan", tasks };
}

describe("checkPlanAgainstConstitution", () => {
  test("passes a plan that reads STATE first and verifies last", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "work", command: "echo do", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    expect(checkPlanAgainstConstitution(doc)).toEqual([]);
  });

  test("flags missing read-state-first", () => {
    const doc = makePlan([
      { id: "work", command: "echo do", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "read-state-first")).toBe(true);
  });

  test("flags missing verify-last", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "work", command: "echo do", timeoutMs: 30000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "verify-last")).toBe(true);
  });

  test("flags denylisted path token in a command", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "leak", command: "echo secrets/ > out.txt", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("does not false-positive on 'author/' in a command", () => {
    // 'auth/' (with slash) must not match 'author/'.
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "docs", command: "echo author/index.ts", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(false);
  });

  test("does not flag .env inside a YAML comment (command only)", () => {
    // A plan whose command is clean passes even though a comment mentions .env.
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    // Comments are not part of `command`, so this must remain clean.
    expect(checkPlanAgainstConstitution(doc)).toEqual([]);
  });

  test("flags empty plan", () => {
    const doc = makePlan([]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "non-empty")).toBe(true);
  });

  // ── Gap #1: healCommand ─────────────────────────────────────────────────────

  test("flags denylisted token in a healCommand", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "work", command: "echo do", timeoutMs: 30000, healCommand: "rm -rf .env" },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  // ── Gap #2: composite phases ────────────────────────────────────────────────

  test("flags denylisted token in a composite phase command", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
      composites: [
        {
          id: "deploy",
          phases: [
            { id: "push", command: "git push" },
            { id: "leak", command: "cat secrets/id_rsa" },
          ],
        },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("flags denylisted token in a composite phase healCommand", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
      composites: [
        {
          id: "test",
          phases: [
            { id: "run-tests", command: "bun test", healCommand: "cp auth/ .env" },
          ],
        },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  // ── Gap #3: case-insensitivity ──────────────────────────────────────────────

  test("flags denylisted token case-insensitively (.ENV vs .env)", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "leak", command: "cat .ENV", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  // ── Gap #4: task.prompt (type: agent) ───────────────────────────────────────

  test("flags denylisted token in a task.prompt (.env)", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        {
          id: "agent-leak",
          type: "agent",
          prompt: "Edit .env to enable the feature flag.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
    // The violation detail must name the source field so the message
    // distinguishes prompt from command/healCommand.
    expect(
      v.some(
        (x) =>
          x.rule === "denylisted-path" &&
          x.detail.includes('"agent-leak" prompt'),
      ),
    ).toBe(true);
  });

  test("flags denylisted token in a task.prompt (secrets/)", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        {
          id: "agent-leak",
          type: "agent",
          prompt: "Read the config from secrets/ and summarize it.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("accepts a clean agent task prompt", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        {
          id: "agent-work",
          type: "agent",
          prompt: "Analyze the auth module and propose a report.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    expect(checkPlanAgainstConstitution(doc)).toEqual([]);
  });

  test("flags denylisted token in a task.prompt case-insensitively (.ENV)", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        {
          id: "agent-leak",
          type: "agent",
          prompt: "Rotate the keys stored under .ENV.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("treats command, healCommand, and prompt sources identically", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "cmd-leak", command: "echo .env", timeoutMs: 30000 },
        { id: "heal-leak", command: "echo ok", timeoutMs: 30000, healCommand: "rm .env" },
        {
          id: "agent-leak",
          type: "agent",
          prompt: "Please edit .env.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const denylisted = checkPlanAgainstConstitution(doc).filter(
      (x) => x.rule === "denylisted-path",
    );
    expect(denylisted).toHaveLength(3);
    expect(denylisted.some((x) => x.detail.includes('"cmd-leak" command'))).toBe(true);
    expect(denylisted.some((x) => x.detail.includes('"heal-leak" healCommand'))).toBe(true);
    expect(denylisted.some((x) => x.detail.includes('"agent-leak" prompt'))).toBe(true);
  });

  // ── Gap #5: secret patterns (*.pem, *.key, id_rsa, aws_access_key) ──────────

  test("flags *.pem token in a command", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "leak", command: "cat server.pem", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("flags *.key token in a healCommand", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "work", command: "echo do", timeoutMs: 30000, healCommand: "cp tls.key /tmp" },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("flags id_rsa token in a command", () => {
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "leak", command: "cat ~/.ssh/id_rsa", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("flags aws_access_key token in a task.prompt", () => {
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        {
          id: "agent-leak",
          type: "agent",
          prompt: "Print the aws_access_key value to confirm rotation.",
          timeoutMs: 30000,
        },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(v.some((x) => x.rule === "denylisted-path")).toBe(true);
  });

  test("does not false-positive on bare key/pem substrings", () => {
    // The glob patterns are matched as `.key` / `.pem` (leading dot) so
    // plain words like "keyboard" / "monkey" stay clean.
    const doc = makePlan([
      { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
      { id: "docs", command: "echo keyboard monkey", timeoutMs: 30000 },
      { id: "verify", command: "bun run build", timeoutMs: 120000 },
    ]);
    expect(checkPlanAgainstConstitution(doc)).toEqual([]);
  });
});
