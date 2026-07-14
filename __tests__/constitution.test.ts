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
});
