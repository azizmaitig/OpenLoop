/**
 * task-processor.ts — extracted task execution logic from daemon.ts
 *
 * Provides processTask() for single-task execution and processQueue() for
 * the queue processing loop, behind a TaskContext seam.
 *
 * @module task-processor
 */

import type { Task, LLMConfig, LLMProvider } from './types.js';
import { TaskQueue } from './task-queue.js';
import type { StateMdFrontmatter } from './state.js';
import { checkBudget } from './budget.js';
import { runCommand } from './shell.js';
import { Guard, RecoveryStrategy, type RecoveryContext } from './recovery.js';

/**
 * Dependencies injected into every task-processing operation.
 * Routes and the processor never reach into Daemon internals.
 */
export interface TaskContext {
  taskQueue: TaskQueue;
  baseDir: string;
  getState: () => { status: string };
  isPaused: () => Promise<boolean>;
  broadcast: (type: string, data: unknown) => void;
  callLLM: (config: LLMConfig, prompt: string, system?: string) => Promise<string>;
  isSafeCommand: (command: string) => boolean;
  saveTaskHistory: (task: Task) => Promise<string>;
  updateStateMd: (fm: StateMdFrontmatter) => Promise<void>;
}

/**
 * Execute a single task (LLM or shell command) and update the task queue.
 */
export async function executeTask(task: Task, ctx: TaskContext): Promise<void> {
  const { taskQueue, baseDir, broadcast } = ctx;

  // Post-execution recovery for a failed task routes through RecoveryStrategy
  // (ADR-0009). failTerminal marks the task failed and broadcasts completion.
  const recovery: RecoveryContext = { taskQueue, broadcast };

  // LLM task — call the LLM provider directly instead of spawning a shell command
  if (task.llm && 'prompt' in task.llm) {
    const startTime = Date.now();
    try {
      const config: LLMConfig = {
        provider: (Bun.env.LLM_PROVIDER as LLMProvider) ?? 'openai',
        apiKey: Bun.env.LLM_API_KEY ?? '',
        model: Bun.env.LLM_MODEL ?? 'gpt-4o',
      };
      const llmInfo = task.llm as { prompt: string; system?: string; mcpServer?: string; tool?: string };
      const response = await ctx.callLLM(config, llmInfo.prompt, llmInfo.system);
      taskQueue.complete(task.id, {
        exitCode: 0,
        stdout: response,
        stderr: '',
        durationMs: Date.now() - startTime,
      });
      broadcast('task_completed', taskQueue.get(task.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      RecoveryStrategy.failTerminal(recovery, task, msg);
    }
    return;
  }

  if (!ctx.isSafeCommand(task.command)) {
    RecoveryStrategy.failTerminal(recovery, task, 'Command rejected: unsafe shell metacharacters detected');
    return;
  }

  // Special spawn paths: opencode (direct binary, no shell) and .ps1 (powershell)
  const isOpencode = task.command.startsWith('opencode');
  const parts = task.command.split(/\s+/).filter(Boolean);
  const isPs1 = parts.length > 0 && parts[0].toLowerCase().endsWith('.ps1');
  console.error('[SISYPHUS-DEBUG] isOpencode:', isOpencode, 'isPs1:', isPs1, 'parts:', JSON.stringify(parts));
  const timeoutMs = isOpencode ? (task.timeoutMs ?? 300000) : (task.timeoutMs ?? 60000);

  try {
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    let durationMs: number;

    if (isOpencode) {
      const startTime = Date.now();
      const proc = Bun.spawn(parts, { stdio: ['ignore', 'pipe', 'pipe'] });
      [stdout, stderr] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
      ]);
      exitCode = await proc.exited;
      durationMs = Date.now() - startTime;
    } else if (isPs1) {
      const startTime = Date.now();
      const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-File', ...parts], { stdio: ['ignore', 'pipe', 'pipe'] });
      [stdout, stderr] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
      ]);
      exitCode = await proc.exited;
      durationMs = Date.now() - startTime;
    } else {
      const result = await runCommand(task.command, { timeoutMs });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      durationMs = result.durationMs;
    }

    taskQueue.complete(task.id, { exitCode, stdout, stderr, durationMs });
    broadcast('task_completed', taskQueue.get(task.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    RecoveryStrategy.failTerminal(recovery, task, msg);
  }
}

/**
 * Process the task queue: dequeue tasks, execute them, save history,
 * update STATE.md, and enforce budget/pause guards.
 *
 * Returns the number of tasks processed (0 if none or stopped).
 */
export async function processQueue(ctx: TaskContext): Promise<number> {
  const { taskQueue, baseDir, getState, isPaused, broadcast } = ctx;

  // Single pre-execution gate (ADR-0009): budget, pause, and command safety all
  // flow through Guard.shouldRun — no inline budget branching. A "no" decision
  // means tasks never run. isPaused is stubbed here so the budget gate only
  // gates budget; pause is still checked per-iteration in the loop below.
  const budget = await checkBudget(baseDir);
  const pct = Math.round((budget.runsToday / budget.cap) * 100);
  const sentinel: Task = { id: '__guard_probe__', command: '', lifecycle: 'queued', createdAt: '' };
  const decision = await Guard.shouldRun(
    { baseDir, isPaused: async () => false, isSafeCommand: ctx.isSafeCommand },
    sentinel,
    budget.status,
  );

  if (!decision.run) {
    if (budget.status === 'exceeded') {
      console.error(`[daemon] Daily run cap exceeded (${budget.runsToday}/${budget.cap}), stopping`);
      return 0;
    }
    // report_only → cancel-report: cancel all queued tasks (they never ran).
    console.error(`[daemon] Run budget at ${pct}% (${budget.runsToday}/${budget.cap}), report-only mode`);
    let cancelledCount = 0;
    while (getState().status === 'running') {
      const task = taskQueue.dequeue();
      if (!task) break;
      const cancelled = taskQueue.cancel(task.id);
      if (cancelled) {
        cancelled.error = decision.reason ?? 'budget: report-only mode, task skipped';
        ctx.saveTaskHistory(cancelled).catch(() => {});
        cancelledCount++;
      }
    }
    return cancelledCount;
  }

  let processed = 0;

  while (getState().status === 'running') {
    // If paused, don't dequeue — tasks stay in the queue
    if (await isPaused()) {
      console.error('[daemon] Daemon paused, skipping task execution');
      break;
    }

    const task = taskQueue.dequeue();
    if (!task) break;

    await executeTask(task, ctx);

    // Save history (best-effort, non-blocking)
    // ponytail: use task directly — taskQueue.get() returns undefined after complete() nulls currentTask
    ctx.saveTaskHistory(task).catch(() => {});

    // Auto-update STATE.md frontmatter after each task
    const paused = await isPaused();
    const fm: StateMdFrontmatter = {
      last_run: new Date().toISOString(),
      current_state: getState().status,
      iteration: taskQueue.history.length,
      active_children: 0,
      high_priority: 0,
      watch_items: 0,
      task_count: taskQueue.history.length,
      paused: paused || undefined,
    };
    ctx.updateStateMd(fm).catch(() => {});
    processed++;
  }

  return processed;
}
