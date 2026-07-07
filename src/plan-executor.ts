/**
 * plan-executor.ts — OpenCode orchestrator plugin that reads .plan.yaml files
 * and executes tasks as loop phases.
 */

import type { PhaseDef, PlanYamlDoc, PlanYamlTask, PhaseResult, LoopResult, LoopState } from './types.js';
import { parseYaml, dumpYaml } from './yaml.js';

let activePlanPath = '';

export function createPlugin(): {
  name: string;
  beforeLoop: (planPath: string) => Promise<PhaseDef[]>;
  afterLoop: (result: LoopResult) => Promise<void>;
} {
  return { name: 'plan-executor', beforeLoop, afterLoop };
}

export async function beforeLoop(planPath: string): Promise<PhaseDef[]> {
  activePlanPath = planPath;
  const doc = await parsePlanYaml(planPath);
  return doc.tasks.map((task) => ({
    name: task.id,
    command: task.command,
    timeoutMs: task.timeoutMs ?? 30000,
    expectedExitCode: 0,
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
