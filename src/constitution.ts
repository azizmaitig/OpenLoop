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

// Path tokens that must never appear in any task command (AGENTS.md).
// Substring match on the command only (YAML comments are not parsed
// into `command`, so a `PREREQUISITE: set .env` comment is safe).
// `auth/` is used (not `author/`) so "author/" does not false-positive.
const DENYLISTED_PATH_TOKENS = [
  '.env',
  'auth/',
  'payments/',
  'secrets/',
  'credentials/',
];

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

  // Rule: denylisted paths must never appear in any task command.
  for (const task of tasks) {
    for (const token of DENYLISTED_PATH_TOKENS) {
      if (task.command && task.command.includes(token)) {
        violations.push({
          rule: 'denylisted-path',
          detail: `Task "${task.id}" command references denylisted path token "${token}".`,
        });
      }
    }
  }

  return violations;
}
