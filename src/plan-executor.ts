/**
 * plan-executor.ts — OpenCode orchestrator plugin that reads .plan.yaml files
 * and executes tasks as loop phases.
 */

import type { PhaseDef, PlanYamlDoc, PlanYamlTask, PhaseResult, LoopResult, LoopState, CompositeDef } from './types.js';
import { loadCheckpoint } from './checkpoint.js';
import { parseYaml, dumpYaml } from './yaml.js';

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
      // Expand into sub-phases inline
      for (const subPhase of composite.phases) {
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

function mapTasksToPhases(tasks: PlanYamlTask[]): PhaseDef[] {
  return tasks.map((task) => ({
    name: task.id,
    command: task.command,
    timeoutMs: task.timeoutMs ?? 30000,
    expectedExitCode: 0,
    healCommand: task.healCommand,
    maxRetries: task.maxRetries,
    produces: task.produces,
    producedMustHaveContent: task.producedMustHaveContent,
    dependsOn: task.dependsOn,
    use: task.use,
    atomicComposite: task.use != null,
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
