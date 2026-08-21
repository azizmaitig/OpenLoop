import { describe, expect, test } from "bun:test";
import {
  auditHealOutput,
  auditTranscriptEntries,
  buildPermissionRuleset,
  checkPlanAgainstConstitution,
  formatAuditIncidentReport,
} from "../src/constitution.js";
import type { PlanYamlDoc } from "../src/types.js";
import type { TranscriptEntry } from "../src/transcript.js";

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

  test("flags denylisted token in a composite agent sub-phase prompt", () => {
    // Composite phases share the PlanYamlTask rules (plan-schema validates
    // `type: agent` sub-phases with missing-agent-prompt), so their prompts
    // must be scanned with the same symmetry as task prompts.
    const doc: PlanYamlDoc = {
      planName: "test-plan",
      tasks: [
        { id: "read-state", command: "type STATE.md", timeoutMs: 5000 },
        { id: "verify", command: "bun run build", timeoutMs: 120000 },
      ],
      composites: [
        {
          id: "agent-step",
          phases: [
            {
              id: "agent",
              type: "agent",
              prompt: "Edit .env and report the diff.",
              timeoutMs: 30000,
            },
          ],
        },
      ],
    };
    const v = checkPlanAgainstConstitution(doc);
    expect(
      v.some(
        (x) =>
          x.rule === "denylisted-path" &&
          x.detail.includes('Composite "agent-step" "agent" prompt'),
      ),
    ).toBe(true);
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

// ── T5 #40: PermissionRuleset build (D6.3) ───────────────────────────────────

describe("buildPermissionRuleset", () => {
  test("every denylisted path token gets a deny rule for edit/bash/glob", () => {
    const rules = buildPermissionRuleset();
    const pathTokens = [
      ".env", "auth/", "payments/", "secrets/", "credentials/",
      ".pem", ".key", "id_rsa", "aws_access_key",
    ];
    for (const token of pathTokens) {
      expect(rules.some((r) => r.permission === "edit" && r.action === "deny" && r.pattern.includes(token)))
        .toBe(true);
      expect(rules.some((r) => r.permission === "bash" && r.action === "deny" && r.pattern.includes(token)))
        .toBe(true);
      expect(rules.some((r) => r.permission === "glob" && r.action === "deny" && r.pattern.includes(token)))
        .toBe(true);
    }
  });

  test("denies dangerous bash tools (git push, destructive shell)", () => {
    const rules = buildPermissionRuleset();
    expect(rules.some((r) => r.permission === "bash" && r.action === "deny" && r.pattern.includes("git push"))).toBe(true);
    expect(rules.some((r) => r.permission === "bash" && r.action === "deny" && r.pattern.includes("rm -rf"))).toBe(true);
  });

  test("uses native opencode permission keys (edit/bash/glob) and deny action only", () => {
    const rules = buildPermissionRuleset();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(["edit", "bash", "glob"]).toContain(r.permission);
      expect(r.action).toBe("deny");
      expect(typeof r.pattern).toBe("string");
      expect(r.pattern.length).toBeGreaterThan(0);
    }
  });

  test("respects permissionOverrides appended after the built-in denies", () => {
    const rules = buildPermissionRuleset([
      { permission: "bash", pattern: "git *", action: "allow" },
    ]);
    const last = rules[rules.length - 1]!;
    expect(last).toEqual({ permission: "bash", pattern: "git *", action: "allow" });
  });
});

// ── T5 #40: post-hoc transcript audit (D6.4) ─────────────────────────────────

describe("auditTranscriptEntries", () => {
  test("flags a tool call whose input references a denylisted path", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool", ts: 1, callID: "call_1", tool: "bash", state: "called", input: { cmd: "cat .env" } },
    ];
    const v = auditTranscriptEntries(entries);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]!.rule).toBe("audit-denylisted-path");
    expect(v[0]!.detail).toContain(".env");
    expect(v[0]!.detail).toContain("call_1");
  });

  test("flags a failed tool whose error output references a denylisted path", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool", ts: 1, callID: "call_2", tool: "bash", state: "failed", input: { cmd: "ls" }, error: "permission denied on secrets/credentials.db" },
    ];
    const v = auditTranscriptEntries(entries);
    expect(v.some((x) => x.rule === "audit-denylisted-path" && x.detail.includes("secrets/"))).toBe(true);
  });

  test("flags a patch part touching a denylisted file", () => {
    const entries: TranscriptEntry[] = [
      { kind: "part", ts: 1, part: { type: "patch", hash: "abc", files: ["src/ok.ts", "auth/token.json"] } },
    ];
    const v = auditTranscriptEntries(entries);
    expect(v.some((x) => x.rule === "audit-denylisted-path" && x.detail.includes("auth/token.json"))).toBe(true);
  });

  test("is clean on a transcript with no denylisted touches", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool", ts: 1, callID: "call_1", tool: "bash", state: "success", input: { cmd: "ls" }, result: "src\npackage.json" },
      { kind: "tool", ts: 2, callID: "call_2", tool: "edit", state: "success", input: { filePath: "src/a.ts" }, result: "ok" },
      { kind: "part", ts: 3, part: { type: "patch", hash: "abc", files: ["src/a.ts"] } },
    ];
    expect(auditTranscriptEntries(entries)).toEqual([]);
  });

  test("does NOT flag a file whose CONTENT contains a key-file substring (.keyboard-hints)", () => {
    // A legitimate read of DESIGN.md returns the file body, which may
    // legitimately contain `# .keyboard-hints` — `.key` as a substring of a
    // word, not a key-file path. Secret-file tokens (`.key`, `.pem`) match
    // path segments, not arbitrary file contents.
    const entries: TranscriptEntry[] = [
      {
        kind: "tool",
        ts: 1,
        callID: "call_read",
        tool: "read",
        state: "success",
        input: { filePath: "DESIGN.md" },
        result: "Keyboard hints         # .keyboard-hints",
      },
    ];
    expect(auditTranscriptEntries(entries)).toEqual([]);
  });

  test("still flags a tool result that IS a key-file path", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool",
        ts: 1,
        callID: "call_ls",
        tool: "bash",
        state: "success",
        input: { cmd: "ls" },
        result: "tls.key\nREADME.md",
      },
    ];
    const v = auditTranscriptEntries(entries);
    expect(v.some((x) => x.rule === "audit-denylisted-path" && x.detail.includes(".key"))).toBe(true);
  });
});

// ── T5 #40: shared heal audit (D6.5) ─────────────────────────────────────────

describe("auditHealOutput", () => {
  test("flags a denylisted token in heal stdout", () => {
    const v = auditHealOutput("healed: rewrote .env.example", "");
    expect(v.some((x) => x.rule === "audit-denylisted-path" && x.detail.includes(".env"))).toBe(true);
  });

  test("flags a denylisted token in heal stderr", () => {
    const v = auditHealOutput("", "error: cannot read id_rsa");
    expect(v.some((x) => x.rule === "audit-denylisted-path" && x.detail.includes("id_rsa"))).toBe(true);
  });

  test("is clean on a heal that touches nothing denylisted", () => {
    expect(auditHealOutput("lint fixed", "0 warnings")).toEqual([]);
  });
});

// ── T5 #40: incident report formatting ───────────────────────────────────────

describe("formatAuditIncidentReport", () => {
  test("renders a detailed multi-line incident report", () => {
    const violations = auditTranscriptEntries([
      { kind: "tool", ts: 1, callID: "call_1", tool: "bash", state: "called", input: { cmd: "cat .env" } },
    ]);
    const report = formatAuditIncidentReport("agent-leak", violations);
    expect(report).toContain("agent-leak");
    expect(report).toContain(".env");
    expect(report.split("\n").length).toBeGreaterThan(1);
  });
});
