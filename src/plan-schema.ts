/**
 * plan-schema.ts — structural schema validator for .plan.yaml files.
 *
 * This is the FIELD-CONTRACT layer. It catches shape/value errors that the
 * executor does NOT check at load time but which cause silent no-op runs
 * or misleading defaults:
 *
 *   - empty / missing `command`        (executor runs nothing, phase "passes")
 *   - duplicate task `id`s            (breaks resume + checkpoint keys)
 *   - `llm.provider` outside the allowed set (executor silently defaults to 'openai')
 *   - `validator` block without `criteria` (guide: required-if-present)
 *   - `llm` in MCP form (`mcpServer`+`tool`) with a missing `tool` (defaults to '')
 *
 * It deliberately does NOT duplicate what is already enforced elsewhere:
 *   - `constitution.ts`      → read-state-first, verify-last, denylisted paths, non-empty
 *   - `phase-graph.ts`       → dangling `dependsOn` + cycles (throws at DAG build)
 *   - `expandComposites`     → unknown `use` ref (throws at load)
 *
 * Run it standalone via `bun run loop.ts validate --plan <path>`, or import
 * `validatePlanSchema` to gate plan load the same way `checkPlanAgainstConstitution`
 * does.
 * EXCEPTION — trust tier (v10, ADR-0023 d7): `agent-grounding` and
 * `agent-verify-gate` restate the constitution's read-state-first / verify-last
 * invariants with trust-tier-specific messages, because agent tasks carry no
 * command and deserve a clear reason instead of the generic constitution text.
 */

import type { PlanYamlDoc, PlanYamlTask } from './types.js';

/** Providers the executor actually recognizes (src/types.ts: LLMProvider). */
const KNOWN_LLM_PROVIDERS = new Set(['openai', 'anthropic', 'opencode']);

export interface PlanSchemaError {
  rule: string;
  detail: string;
}

/**
 * Validate a parsed plan's structural contract.
 * Returns an empty array when the plan is structurally sound.
 */
export function validatePlanSchema(doc: PlanYamlDoc): PlanSchemaError[] {
  const errors: PlanSchemaError[] = [];
  const tasks = doc.tasks ?? [];

  const seenIds = new Map<string, number>();
  tasks.forEach((task, idx) => {
    seenIds.set(task.id, (seenIds.get(task.id) ?? 0) + 1);
    validateTask(task, idx, errors);
  });

  // Duplicate id check (breaks resume/checkpoint keying).
  for (const [id, count] of seenIds) {
    if (count > 1) {
      errors.push({
        rule: 'duplicate-id',
        detail: `Task id "${id}" is used ${count} times; ids must be unique.`,
      });
    }
  }

  // Trust tier (ADR-0023 decision 7): the loop's own guards must bracket agent
  // work — an agent task can neither ground the run nor self-verify. Composite
  // `use` tasks are resolved so an agent sub-phase cannot smuggle into a
  // boundary position (gates run before expandComposites).
  const first = tasks[0];
  if (first && edgeTaskIsAgent(first, doc, 'first')) {
    errors.push({
      rule: 'agent-grounding',
      detail: `First task "${first.id}" resolves to a type: agent task. Agent tasks cannot ground the run — the first task must be a command task (e.g. \`type STATE.md\`) so the loop's own guard is the plan's entry point.`,
    });
  }
  const last = tasks[tasks.length - 1];
  if (last && edgeTaskIsAgent(last, doc, 'last')) {
    errors.push({
      rule: 'agent-verify-gate',
      detail: `Last task "${last.id}" resolves to a type: agent task. Agent tasks cannot self-verify — the verify gate must be a command task (build/test/lint/verify).`,
    });
  }

  // Composites: validate their sub-phases too (they share the same field rules).
  if (doc.composites) {
    for (const composite of doc.composites) {
      composite.phases?.forEach((phase, idx) => {
        validateTask(phase, idx, errors, `Composite "${composite.id}"`);
      });
    }
  }

  return errors;
}

function edgeTaskIsAgent(task: PlanYamlTask, doc: PlanYamlDoc, position: 'first' | 'last'): boolean {
  if (task.type === 'agent') return true;
  if (!task.use) return false;
  const composite = doc.composites?.find((c) => c.id === task.use);
  const phases = composite?.phases;
  if (!phases || phases.length === 0) return false;
  const edge = position === 'first' ? phases[0] : phases[phases.length - 1];
  return edge.type === 'agent';
}

function validateTask(
  task: PlanYamlTask,
  idx: number,
  errors: PlanSchemaError[],
  label = 'Task',
): void {
  const where = `${label} "${task.id ?? `#${idx}`}"`;

  // Rule: unknown task-kind discriminator (v10).
  if (task.type !== undefined && task.type !== 'command' && task.type !== 'agent') {
    errors.push({
      rule: 'unknown-task-type',
      detail: `${where} has type "${task.type}" which is not one of command | agent.`,
    });
  }

  const isAgentTask = task.type === 'agent';

  // Rule: type: agent and command are mutually exclusive (ADR-0023 decision 3).
  if (isAgentTask && task.command !== undefined && task.command !== null) {
    errors.push({
      rule: 'agent-with-command',
      detail: `${where} is a type: agent task but also declares a command — command and type: agent are mutually exclusive.`,
    });
  }

  // Rule: command must be a non-empty string for command tasks. The executor maps
  // command -> name and runs it verbatim; an empty command produces no work and
  // "passes". Agent tasks are exempt — they run a prompt instead (checked below).
  if (!isAgentTask && (task.command === undefined || task.command === null || task.command.trim() === '')) {
    errors.push({
      rule: 'empty-command',
      detail: `${where} has an empty or missing command. Every task must run a real shell command (even LLM tasks — the command produces the stdout the LLM judges).`,
    });
  }

  // Rule: agent tasks require a prompt — never burn tokens on an empty conversation.
  if (isAgentTask && (!task.prompt || task.prompt.trim() === '')) {
    errors.push({
      rule: 'missing-agent-prompt',
      detail: `${where} is a type: agent task without a prompt. The prompt is what the agent executes — it is required.`,
    });
  }

  // Rule: workspace.type must be local | docker (ADR-0023 decision 5).
  if (task.workspace && task.workspace.type !== 'local' && task.workspace.type !== 'docker') {
    errors.push({
      rule: 'unknown-workspace-type',
      detail: `${where} has workspace.type "${task.workspace.type}" which is not one of local | docker.`,
    });
  }

  // Rule: worktree flag must be boolean (T6 isolation).
  if (task.worktree !== undefined && typeof task.worktree !== 'boolean') {
    errors.push({
      rule: 'invalid-worktree-flag',
      detail: `${where} has worktree "${String(task.worktree)}" which is not a boolean. Declare worktree: true to isolate this task in a git worktree.`,
    });
  }

  // Rule: llm block, if present, must be well-formed.
  if (task.llm) {
    if ('provider' in task.llm) {
      const provider = task.llm.provider;
      if (!provider || !KNOWN_LLM_PROVIDERS.has(provider)) {
        errors.push({
          rule: 'unknown-llm-provider',
          detail: `${where} llm.provider "${provider ?? ''}" is not one of openai | anthropic | opencode. The executor would silently default to 'openai'.`,
        });
      }
      if (!task.llm.prompt || task.llm.prompt.trim() === '') {
        errors.push({
          rule: 'missing-llm-prompt',
          detail: `${where} has an llm block but no prompt. The prompt must instruct the model to return {passed, reason, confidence}.`,
        });
      }
    } else {
      // MCP form: requires both mcpServer and tool.
      if (!task.llm.tool || task.llm.tool.trim() === '') {
        errors.push({
          rule: 'missing-llm-tool',
          detail: `${where} uses the MCP form of llm (mcpServer+tool) but omits tool. The executor would default tool to '' and the call would no-op.`,
        });
      }
    }
  }

  // Rule: validator block, if present, requires criteria.
  if (task.validator) {
    if (!task.validator.criteria || task.validator.criteria.trim() === '') {
      errors.push({
        rule: 'validator-without-criteria',
        detail: `${where} has a validator block but no criteria. The validator grades output against this rubric; without it the gate is meaningless.`,
      });
    }
  }
}
