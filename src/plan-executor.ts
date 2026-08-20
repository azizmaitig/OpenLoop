/**
 * plan-executor.ts — OpenCode orchestrator plugin that reads .plan.yaml files
 * and executes tasks as loop phases.
 */

import type { PhaseDef, PlanYamlDoc, PlanYamlTask, PhaseResult, LoopResult, LoopState, CompositeDef } from './types.js';
import { loadCheckpoint } from './checkpoint.js';
import { parseYaml, dumpYaml } from './yaml.js';
import { checkPlanAgainstConstitution, type ConstitutionViolation } from './constitution.js';
import { validatePlanSchema } from './plan-schema.js';

let activePlanPath = '';
let activePlanDoc: PlanYamlDoc | null = null;

export function createPlugin(): {
  name: string;
  beforeLoop: (planPath: string, resume?: boolean) => Promise<PhaseDef[]>;
  afterLoop: (result: LoopResult) => Promise<void>;
} {
  return { name: 'plan-executor', beforeLoop, afterLoop };
}

/**
 * Expand composite phases in the task list.
 * - atomic composites are inlined as a single PhaseDef (combined command).
 * - non-atomic composites are expanded into sub-phases inline.
 * - tasks without `use` pass through as-is.
 */
export function expandComposites(
  tasks: PlanYamlTask[],
  composites: CompositeDef[],
): PlanYamlTask[] {
  const compositeMap = new Map(composites.map((c) => [c.id, c]));

  const expanded: PlanYamlTask[] = [];
  for (const task of tasks) {
    if (!task.use) {
      expanded.push(task);
      continue;
    }

    const composite = compositeMap.get(task.use);
    if (!composite) {
      throw new Error(
        `Unknown composite id "${task.use}" referenced by task "${task.id}"`,
      );
    }

    if (composite.atomic) {
      // Inline as a single phase with combined command
      const combinedCommand = composite.phases
        .map((p) => p.command)
        .join(' && ');
      expanded.push({
        ...task,
        command: combinedCommand,
        // Merge timeout: use the max of all sub-phase timeouts, or fallback
        timeoutMs: composite.phases.reduce(
          (max, p) => Math.max(max, p.timeoutMs ?? 30000),
          0,
        ),
        // Atomic composites get a marker for downstream inspection
      });
    } else {
      // Expand into sub-phases inline; strip sub-phase dependsOn
      // since expanded IDs are prefixed and original refs become dangling
      for (const subPhase of composite.phases) {
        const { dependsOn: _, ...cleanSub } = subPhase;
        expanded.push({
          ...subPhase,
          id: `${task.id}:${subPhase.id}`,
        });
      }
    }
  }

  return expanded;
}

export async function beforeLoop(planPath: string, resume?: boolean): Promise<PhaseDef[]> {
  activePlanPath = planPath;
  const doc = await parsePlanYaml(planPath);

  // Schema pre-flight gate first — field contract (v10: agent task rules + trust tier).
  const schemaErrors = validatePlanSchema(doc);
  if (schemaErrors.length > 0) {
    const lines = schemaErrors
      .map((v) => `  - [${v.rule}] ${v.detail}`)
      .join('\n');
    throw new Error(`Plan schema violation in ${planPath}:\n${lines}`);
  }

  // Constitution pre-flight gate — borrowed spec-kit concept.
  const violations = checkPlanAgainstConstitution(doc);
  if (violations.length > 0) {
    const lines = violations
      .map((v) => `  - [${v.rule}] ${v.detail}`)
      .join('\n');
    throw new Error(`Constitution violation in ${planPath}:\n${lines}`);
  }

  // L2 readiness gate (v11 D5) — refuses to spawn agent tasks until the
  // human declares `l2.checklist: done` in the plan YAML. Command-only
  // (L1) plans never spawn agent tasks, so they pass without the flag.
  const l2Violations = checkPlanL2Gate(doc);
  if (l2Violations.length > 0) {
    const lines = l2Violations
      .map((v) => `  - [${v.rule}] ${v.detail}`)
      .join('\n');
    throw new Error(`L2 gate violation in ${planPath}:\n${lines}`);
  }

  activePlanDoc = doc;

  let tasks = doc.tasks;

  // Expand composites if defined
  if (doc.composites && doc.composites.length > 0) {
    tasks = expandComposites(tasks, doc.composites);
  }

  let phases = mapTasksToPhases(tasks);

  if (resume) {
    const cp = loadCheckpoint(doc.planName);
    if (cp) {
      const completed = new Set(cp.completedTaskIds);
      phases = phases.filter((p) => !completed.has(p.name));
    }
  }

  return phases;
}

/**
 * Plan-level L2 gate (v11 D5): a plan that would spawn a `type: agent`
 * task — directly or through a composite `use` — must declare the
 * human-written `l2.checklist: done` flag first. Command-only (L1) plans
 * contain no agent tasks, so they pass without the flag.
 */
export function checkPlanL2Gate(doc: PlanYamlDoc): ConstitutionViolation[] {
  if (doc.l2?.checklist === 'done') return [];

  const agentTaskIds = doc.tasks
    .filter((t) => taskSpawnsAgent(t, doc))
    .map((t) => t.id);
  if (agentTaskIds.length === 0) return [];

  return [
    {
      rule: 'l2-checklist',
      detail: `Plan "${doc.planName}" spawns agent task(s) [${agentTaskIds.join(', ')}] but does not declare l2.checklist: done. Complete docs/l2-readiness-checklist.md and declare the flag in the plan YAML (human-written) before any L2 agent run.`,
    },
  ];
}

function taskSpawnsAgent(task: PlanYamlTask, doc: PlanYamlDoc): boolean {
  if (task.type === 'agent') return true;
  if (!task.use) return false;
  const composite = doc.composites?.find((c) => c.id === task.use);
  return composite?.phases?.some((p) => p.type === 'agent') ?? false;
}

function mapTasksToPhases(tasks: PlanYamlTask[]): PhaseDef[] {
  return tasks.map((task) => ({
    name: task.id,
    type: task.type,
    command: task.command,
    prompt: task.prompt,
    agent: task.agent,
    model: task.model,
    workspace: task.workspace,
    worktree: task.worktree,
    timeoutMs: task.timeoutMs ?? 30000,
    expectedExitCode: 0,
    healCommand: task.healCommand,
    maxRetries: task.maxRetries,
    produces: task.produces,
    producedMustHaveContent: task.producedMustHaveContent,
    dependsOn: task.dependsOn,
    use: task.use,
    validator: task.validator,
    llm: task.llm
      ? 'provider' in task.llm
        ? { provider: task.llm.provider ?? 'openai', prompt: task.llm.prompt ?? '' }
        : {
            mcpServer: task.llm.mcpServer ?? '',
            tool: task.llm.tool ?? '',
            prompt: task.llm.prompt ?? '',
          }
      : undefined,
  }));
}

export async function afterLoop(result: LoopResult): Promise<void> {
  if (!activePlanPath) return;
  try {
    const doc = await parsePlanYaml(activePlanPath);
    const phaseResults = (result as unknown as Record<string, unknown>).phaseResults as Record<string, PhaseResult> | undefined;
    for (const task of doc.tasks) {
      const pr = phaseResults?.[task.id];
      const extra = task as unknown as Record<string, unknown>;
      if (pr) {
        extra.status = pr.status;
        extra.durationMs = pr.durationMs;
      } else {
        extra.status = result.allPhasesPassed ? 'pass' : 'fail';
        extra.durationMs = result.totalDurationMs;
      }
      extra.completedAt = new Date().toISOString();
    }
    await Bun.write(activePlanPath, dumpPlanYaml(doc));

    // Write triage report: extract judgment.reason from the LLM phase
    const llmPhase = doc.tasks.find(t => t.llm);
    if (llmPhase && phaseResults?.[llmPhase.id]?.judgment?.reason) {
      const reason = phaseResults[llmPhase.id].judgment!.reason;
      const reportPath = activePlanPath.replace(/\.yaml$/, '-report.md');
      const timestamp = new Date().toISOString();
      await Bun.write(reportPath, `# Triage Report — ${doc.planName}\n\n**Generated**: ${timestamp}\n**Iterations**: ${result.iterationsCompleted}\n**All passed**: ${result.allPhasesPassed}\n**Duration**: ${result.totalDurationMs}ms\n\n---\n\n${reason}\n`);
    }
  } catch (err) {
    console.error('[plan-executor] afterLoop:', err instanceof Error ? err.message : String(err));
  }
}

export async function parsePlanYaml(input: string): Promise<PlanYamlDoc> {
  let content: string;
  if (input.includes('\n')) {
    content = input;
  } else {
    try {
      content = await Bun.file(input).text();
    } catch {
      throw new Error(`Failed to read plan file: ${input}`);
    }
  }

  const parsed = parseYaml<PlanYamlDoc>(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid plan YAML: empty or not an object');
  }
  const doc = parsed as PlanYamlDoc;
  if (!doc.planName) {
    throw new Error('Missing required field: planName');
  }
  doc.tasks ??= [];
  return doc;
}

export function dumpPlanYaml(doc: PlanYamlDoc): string {
  return dumpYaml(doc);
}

export function getPlanDoc(): PlanYamlDoc | null {
  return activePlanDoc;
}
