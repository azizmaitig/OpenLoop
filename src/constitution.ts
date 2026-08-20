/**
 * constitution.ts — the agent-loop constitution, enforced as a pre-flight gate.
 *
 * Borrowed from the spec-kit "constitution" concept: a versioned,
 * machine-checkable set of non-negotiable plan-shape rules. The loop
 * reads this at plan load (beforeLoop) and refuses to run a plan that
 * violates it — instead of depending on the external spec-kit repo.
 *
 * Human-faced governance (one concern per plan, L1/L2 mode, no
 * push/merge) lives in AGENTS.md + PLAN-WRITING-GUIDE.md. This
 * module enforces only the subset that is unambiguous to check
 * mechanically.
 */

import type { PlanYamlDoc, PlanYamlTask } from './types.js';
import type { PermissionRule } from './opencode-client.js';
import type { TranscriptEntry } from './transcript.js';

// Path tokens that must never appear in any task command, healCommand, or
// agent prompt (AGENTS.md). Substring match on the field only (YAML comments
// are not parsed into `command`, so a `PREREQUISITE: set .env` comment is
// safe). `auth/` is used (not `author/`) so "author/" does not false-positive.
// The glob-like secret patterns `*.pem` / `*.key` are stored as `.pem` / `.key`
// (leading dot, no `*`): the matcher is substring-based, so the `*` is dropped,
// and the leading dot avoids false positives — "monkey" and "keyboard" contain
// "key" but not ".key".
const DENYLISTED_PATH_TOKENS = [
  '.env',
  'auth/',
  'payments/',
  'secrets/',
  'credentials/',
  '.pem',
  '.key',
  'id_rsa',
  'aws_access_key',
];

/** Dangerous shell commands denied at runtime for the agent (git push, destructive ops). */
const DANGEROUS_BASH_PATTERNS = [
  'git push*',
  'rm -rf*',
  'rm -fr*',
  'shred*',
  'mkfs*',
  'dd if=*',
  'dd of=*',
];

function findDenylistedToken(value: string): string | null {
  const lower = value.toLowerCase();
  for (const token of DENYLISTED_PATH_TOKENS) {
    if (lower.includes(token)) {
      return token;
    }
  }
  return null;
}

/**
 * Trust-tier soft control (ADR-0023 decision 7): agent actions bypass the
 * command guard, so the denylist is injected into every agent prompt as a
 * binding instruction. Hard enforcement is the docker workspace (T5).
 */
export function buildDenylistPromptInstruction(workingDir: string): string {
  const tokens = DENYLISTED_PATH_TOKENS.map((t) => `\`${t}\``).join(', ');
  return [
    'SAFETY CONSTRAINT (binding — agent trust tier, ADR-0023):',
    "The loop's command guard cannot see agent actions, so this instruction is the enforced soft control.",
    `You MUST NOT access, create, modify, or delete any path containing: ${tokens}.`,
    `Working directory: ${workingDir}.`,
    'If the task requires any of these paths, STOP and report the conflict instead of proceeding.',
  ].join('\n');
}

function checkFieldForDenylistedPath(
  value: string | undefined,
  taskId: string,
  source: string,
  field: string,
  violations: ConstitutionViolation[],
): void {
  if (!value) return;
  const token = findDenylistedToken(value);
  if (token !== null) {
    violations.push({
      rule: 'denylisted-path',
      detail: `${source} "${taskId}" ${field} references denylisted path token "${token}".`,
    });
  }
}

export interface ConstitutionViolation {
  rule: string;
  detail: string;
}

/**
 * Check a parsed plan against the constitution's enforceable rules.
 * Returns an empty array when the plan is clean.
 */
export function checkPlanAgainstConstitution(
  doc: PlanYamlDoc,
): ConstitutionViolation[] {
  const violations: ConstitutionViolation[] = [];
  const tasks = doc.tasks ?? [];

  if (tasks.length === 0) {
    violations.push({ rule: 'non-empty', detail: 'Plan has no tasks.' });
    return violations;
  }

  // Rule: first task must ground the run by reading STATE.md.
  const first = tasks[0];
  if (!first.command || !/STATE\.md/i.test(first.command)) {
    violations.push({
      rule: 'read-state-first',
      detail: `First task "${first.id}" must read STATE.md (e.g. \`type STATE.md\`).`,
    });
  }

  // Rule: last task must be a verification gate (build/test/lint/verify).
  const last = tasks[tasks.length - 1];
  if (!last.command || !/\b(build|test|lint|verify)\b/i.test(last.command)) {
    violations.push({
      rule: 'verify-last',
      detail: `Last task "${last.id}" must be a verify step (build/test/lint/verify) that exits 0.`,
    });
  }

  // Rule: denylisted paths must never appear in any command, healCommand,
  // or agent prompt — for tasks AND composite sub-phases (composite phases
  // share the PlanYamlTask rules, so `type: agent` sub-phases are valid and
  // their prompts must be scanned identically).
  for (const task of tasks) {
    checkFieldForDenylistedPath(task.command, task.id, 'Task', 'command', violations);
    checkFieldForDenylistedPath(task.healCommand, task.id, 'Task', 'healCommand', violations);
    checkFieldForDenylistedPath(task.prompt, task.id, 'Task', 'prompt', violations);
  }
  if (doc.composites) {
    for (const composite of doc.composites) {
      for (const phase of composite.phases) {
        const label = `Composite "${composite.id}"`;
        checkFieldForDenylistedPath(phase.command, phase.id, label, 'command', violations);
        checkFieldForDenylistedPath(phase.healCommand, phase.id, label, 'healCommand', violations);
        checkFieldForDenylistedPath(phase.prompt, phase.id, label, 'prompt', violations);
      }
    }
  }

  return violations;
}

// ── T5 #40: runtime permission ruleset (D6.3) ────────────────────────────────

/**
 * Glob used for edit/glob permission rules: matches any path whose last
 * segment contains the token (`.env*` covers `.env` and `.env.local`; the
 * leading dot keeps "monkey"/"keyboard" out of `.pem`/`.key`).
 */
function pathGlobForToken(token: string): string {
  const core = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `**/*${core}*`;
}

/**
 * Build the opencode session PermissionRuleset from the denylisted path
 * tokens + dangerous shell commands. Wire shape (verified against the live
 * server OpenAPI /doc, 2026-08-19): `{ permission, pattern, action }` with
 * `action: 'deny'`; last matching rule wins, so built-in denies come first
 * and any `overrides` (config `opencodeServer.permissionOverrides`) are
 * appended after — an override can re-allow something the default denies.
 */
export function buildPermissionRuleset(overrides?: PermissionRule[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const token of DENYLISTED_PATH_TOKENS) {
    const glob = pathGlobForToken(token);
    rules.push({ permission: 'edit', pattern: glob, action: 'deny' });
    rules.push({ permission: 'bash', pattern: glob, action: 'deny' });
    rules.push({ permission: 'glob', pattern: glob, action: 'deny' });
  }
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    rules.push({ permission: 'bash', pattern, action: 'deny' });
  }
  if (overrides) rules.push(...overrides);
  return rules;
}

// ── T5 #40: post-hoc transcript audit (D6.4) ─────────────────────────────────

/** Violation emitted by the post-hoc transcript/heal audit (D6.4/D6.5). */
export interface AuditViolation {
  rule: 'audit-denylisted-path';
  detail: string;
}

function stringifyAuditValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function auditValue(value: unknown, source: string, violations: AuditViolation[]): void {
  const text = stringifyAuditValue(value);
  if (!text) return;
  const token = findDenylistedToken(text);
  if (token !== null) {
    violations.push({
      rule: 'audit-denylisted-path',
      detail: `${source} references denylisted path token "${token}".`,
    });
  }
}

/**
 * Scan the collected transcript (ToolParts + PatchParts) for denylisted
 * tokens — a task that touched a denylisted path is REJECTED with an
 * incident report, even when the agent otherwise finished cleanly.
 */
export function auditTranscriptEntries(entries: TranscriptEntry[]): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      const source = `Tool "${entry.tool}" (${entry.callID})`;
      auditValue(entry.input, `${source} input`, violations);
      auditValue(entry.result, `${source} result`, violations);
      auditValue(entry.error, `${source} error`, violations);
    } else if (entry.kind === 'part' && entry.part.type === 'patch') {
      for (const file of entry.part.files ?? []) {
        auditValue(file, `Patch "${entry.part.hash ?? ''}" touches file "${file}"`, violations);
      }
    }
  }
  return violations;
}

// ── T5 #40: shared heal audit (D6.5) ─────────────────────────────────────────

/**
 * Same denylist scan applied to healCommand runs: the heal has the
 * pre-execution Guard but no post-execution audit — this closes that gap
 * with the same shared matcher used for agent transcripts.
 */
export function auditHealOutput(stdout: string, stderr: string): AuditViolation[] {
  const violations: AuditViolation[] = [];
  auditValue(stdout, 'heal stdout', violations);
  auditValue(stderr, 'heal stderr', violations);
  return violations;
}

/** Human-readable incident report for a REJECTED task (D6.4). */
export function formatAuditIncidentReport(
  taskName: string,
  violations: AuditViolation[],
): string {
  const lines = violations.map((v, i) => `${i + 1}. ${v.detail}`);
  return [
    `Constitution audit REJECTED task "${taskName}" — ${violations.length} denylisted path touch(es):`,
    ...lines,
  ].join('\n');
}
