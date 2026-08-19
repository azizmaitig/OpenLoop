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
