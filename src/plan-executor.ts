/**
 * plan-executor.ts — OpenCode orchestrator plugin that reads .plan.yaml files
 * and executes tasks as loop phases.
 *
 * Custom YAML parser (no external lib). Exports parsePlanYaml, stringifyPlanYaml,
 * and the PluginModule entry point createPlugin().
 *
 * @module plan-executor
 */

import type { PhaseDef, PlanYamlDoc, PlanYamlTask, PhaseResult, LoopResult, LoopState } from './types.js';
import { loadCheckpoint, filterPendingTasks } from './checkpoint.js';

// ── Module-level state ────────────────────────────────────────────────────────

let activePlanPath = '';
let activePlanDoc: PlanYamlDoc | null = null;

// ── Plugin module entry point ─────────────────────────────────────────────────

export function createPlugin(): {
  name: string;
  beforeLoop: (planPath: string, resume?: boolean) => Promise<PhaseDef[]>;
  afterLoop: (result: LoopResult) => Promise<void>;
} {
  return { name: 'plan-executor', beforeLoop, afterLoop };
}

// ── Plugin hooks (named exports for pluginFromModule compat) ───────────────────

export async function beforeLoop(planPath: string, resume?: boolean): Promise<PhaseDef[]> {
  activePlanPath = planPath;
  const doc = await parsePlanYaml(planPath);
  activePlanDoc = doc;
  let phases = doc.tasks.map((task) => ({
    name: task.id,
    command: task.command,
    timeoutMs: task.timeoutMs ?? 30000,
    expectedExitCode: 0,
    llm: task.llm
      ? {
          mcpServer: task.llm.mcpServer ?? '',
          tool: task.llm.tool ?? '',
          prompt: task.llm.prompt ?? '',
        }
      : undefined,
  }));

  if (resume) {
    const cp = loadCheckpoint(doc.planName);
    if (cp) {
      const completed = new Set(cp.completedTaskIds);
      phases = phases.filter((p) => !completed.has(p.name));
    }
  }

  return phases;
}

export async function afterLoop(result: LoopResult): Promise<void> {
  if (!activePlanPath) return;

  try {
    const doc = await parsePlanYaml(activePlanPath);
    const extended = result as unknown as Record<string, unknown>;
    const phaseResults = extended.phaseResults as Record<string, PhaseResult> | undefined;

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

    const content = stringifyPlanYaml(doc);
    await Bun.write(activePlanPath, content);
  } catch (err) {
    console.error('[plan-executor] afterLoop:', err instanceof Error ? err.message : String(err));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a .plan.yaml file or raw YAML string into a PlanYamlDoc.
 *
 * Heuristic: if the input contains newlines it is treated as YAML content;
 * otherwise it is treated as a file path.
 */
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

  const doc = parseYamlContent(content);

  // Validate required fields
  if (!doc.planName) {
    throw new Error('Missing required field: planName');
  }

  return doc;
}

/**
 * Serialize a PlanYamlDoc to a YAML string.
 */
export function stringifyPlanYaml(doc: PlanYamlDoc): string {
  const lines: string[] = [];
  lines.push(`planName: ${doc.planName}`);

  if (doc.tasks.length === 0) {
    lines.push('tasks:');
    return lines.join('\n');
  }

  lines.push('tasks:');

  for (const task of doc.tasks) {
    lines.push(`  - id: ${task.id}`);
    lines.push(`    command: ${task.command}`);
    if (task.timeoutMs !== undefined) {
      lines.push(`    timeoutMs: ${task.timeoutMs}`);
    }
    if (task.llm) {
      lines.push('    llm:');
      if (task.llm.mcpServer !== undefined) {
        lines.push(`      mcpServer: ${task.llm.mcpServer}`);
      }
      if (task.llm.tool !== undefined) {
        lines.push(`      tool: ${task.llm.tool}`);
      }
      if (task.llm.prompt !== undefined) {
        lines.push(`      prompt: ${task.llm.prompt}`);
      }
    }
    if (task.healCommand !== undefined) {
      lines.push(`    healCommand: ${task.healCommand}`);
    }
    if (task.maxRetries !== undefined) {
      lines.push(`    maxRetries: ${task.maxRetries}`);
    }

    // Extra fields added by afterLoop (status, durationMs, completedAt)
    const extra = task as unknown as Record<string, unknown>;
    for (const key of ['status', 'durationMs', 'completedAt'] as const) {
      if (extra[key] !== undefined) {
        lines.push(`    ${key}: ${extra[key]}`);
      }
    }
  }

  return lines.join('\n');
}

export function getPlanDoc(): PlanYamlDoc | null {
  return activePlanDoc;
}

// ── Custom YAML Parser ───────────────────────────────────────────────────────

enum ParseState {
  Root,
  InTaskList,
  InTask,
  InLlm,
}

function parseYamlContent(content: string): PlanYamlDoc {
  const doc: PlanYamlDoc = { planName: '', tasks: [] };
  let state = ParseState.Root;
  let currentTask: Partial<PlanYamlTask> & Record<string, unknown> | null = null;
  let currentLlm: Record<string, string> | null = null;

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    // ── Root level (indent 0) ─────────────────────────────────────────────
    if (indent === 0) {
      // Flush any in-progress task before switching context
      flushTask(doc, currentTask, currentLlm);
      currentTask = null;
      currentLlm = null;
      state = ParseState.Root;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        if (key === 'planName') {
          const value = trimmed.slice(colonIdx + 1).trim();
          doc.planName = stripQuotes(value);
          continue;
        }
        if (key === 'tasks') {
          state = ParseState.InTaskList;
          continue;
        }
      }

      throw new Error(`Unexpected root-level content: "${trimmed}"`);
    }

    // ── Task list item (indent 2, starts with -) ──────────────────────────
    if (indent === 2 && trimmed.startsWith('- ')) {
      flushTask(doc, currentTask, currentLlm);
      currentTask = {};
      currentLlm = null;
      state = ParseState.InTask;

      const itemContent = trimmed.slice(2).trim();
      const colonIdx = itemContent.indexOf(':');
      if (colonIdx > 0) {
        const key = itemContent.slice(0, colonIdx).trim();
        const value = itemContent.slice(colonIdx + 1).trim();
        if (key === 'id') {
          currentTask.id = stripQuotes(value);
        }
      }
      continue;
    }

    // ── In a task block (indent >= 4, or indent === 2 for non-list) ──────
    if (currentTask && (indent >= 4 || (indent === 2 && state === ParseState.InTask))) {
      // Transition from InLlm back to task fields when indent shrinks
      if (state === ParseState.InLlm && indent <= 4) {
        state = ParseState.InTask;
      }

      // LLM sub-field (indent >= 6 when in LLM state)
      if (state === ParseState.InLlm) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim();
          if (currentLlm) {
            currentLlm[key] = stripQuotes(value);
          }
        }
        continue;
      }

      // Task field: llm key
      if (trimmed === 'llm:') {
        state = ParseState.InLlm;
        currentLlm = {};
        continue;
      }

      // Regular task field
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        if (key === 'id') {
          currentTask.id = stripQuotes(value);
        } else if (key === 'command') {
          currentTask.command = stripQuotes(value);
        } else if (key === 'timeoutMs') {
          currentTask.timeoutMs = parseInt(value, 10);
        } else if (key === 'healCommand') {
          currentTask.healCommand = stripQuotes(value);
        } else if (key === 'maxRetries') {
          currentTask.maxRetries = parseInt(value, 10);
        } else {
          // Store unknown fields for round-trip (status, durationMs, etc.)
          const num = Number(value);
          currentTask[key] = Number.isNaN(num) ? stripQuotes(value) : num;
        }
      }
      continue;
    }
  }

  // Don't forget the last task
  flushTask(doc, currentTask, currentLlm);

  return doc;
}

function flushTask(
  doc: PlanYamlDoc,
  task: (Partial<PlanYamlTask> & Record<string, unknown>) | null,
  llm: Record<string, string> | null,
): void {
  if (!task || !task.id) return;
  if (llm) {
    task.llm = {
      mcpServer: llm.mcpServer ?? '',
      tool: llm.tool ?? '',
      prompt: llm.prompt ?? '',
    };
  }
  doc.tasks.push(task as PlanYamlTask);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
