/**
 * task-processor.ts — extracted task execution logic from daemon.ts
 *
 * Provides processTask() for single-task execution and processQueue() for
 * the queue processing loop, behind a TaskContext seam.
 *
 * @module task-processor
 */

import { resolve } from 'node:path';
import type { Task, LLMConfig, LLMProvider } from './types.js';
import { callLLM } from './llm.js';
import { TaskQueue } from './task-queue.js';
import { saveTaskHistory } from './history.js';
import { updateStateMd } from './state.js';
import type { StateMdFrontmatter } from './state.js';
import { checkBudget } from './budget.js';

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
}

/**
 * Check whether a shell command string contains unsafe metacharacters.
 * Same guard used by daemon.ts — extracted here for the processor.
 */
export function isSafeCommand(cmd: string): boolean {
  return !/[;&|`$\n\r]/.test(cmd);
}

/**
 * Execute a single task (LLM or shell command) and update the task queue.
 */
export async function executeTask(task: Task, ctx: TaskContext): Promise<void> {
  const { taskQueue, baseDir, broadcast } = ctx;

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
      const response = await callLLM(config, llmInfo.prompt, llmInfo.system);
      taskQueue.complete(task.id, {
        exitCode: 0,
        stdout: response,
        stderr: '',
        durationMs: Date.now() - startTime,
      });
      broadcast('task_completed', taskQueue.get(task.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      taskQueue.fail(task.id, msg);
      broadcast('task_completed', taskQueue.get(task.id));
    }
    return;
  }

  if (!isSafeCommand(task.command)) {
    taskQueue.fail(task.id, 'Command rejected: unsafe shell metacharacters detected');
    broadcast('task_completed', taskQueue.get(task.id));
    return;
  }

  // ponytail: opencode commands spawned directly (not via cmd.exe) for proper stdio capture
  const isOpencode = task.command.startsWith('opencode');
  const timeoutMs = isOpencode ? (task.timeoutMs ?? 300000) : (task.timeoutMs ?? 60000);
  const startTime = Date.now();

  try {
    const proc = isOpencode
      ? Bun.spawn(task.command.split(/\s+/).filter(Boolean), {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : Bun.spawn(['cmd.exe', '/c', task.command], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    const [stdout, stderr] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
    ]);

    const exitCode = await proc.exited;

    taskQueue.complete(task.id, {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startTime,
    });
    broadcast('task_completed', taskQueue.get(task.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    taskQueue.fail(task.id, msg);
    broadcast('task_completed', taskQueue.get(task.id));
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

  // Budget guard: check daily run cap before processing
  const budget = await checkBudget(baseDir);
  if (budget.status === 'exceeded') {
    console.error(`[daemon] Daily run cap exceeded (${budget.runsToday}/${budget.cap}), stopping`);
    return 0;
  }
  if (budget.status === 'report_only') {
    const pct = Math.round((budget.runsToday / budget.cap) * 100);
    console.error(`[daemon] Run budget at ${pct}% (${budget.runsToday}/${budget.cap}), report-only mode`);
    // Dequeue tasks and skip execution, but still log to history
    let cancelledCount = 0;
    while (getState().status === 'running') {
      const task = taskQueue.dequeue();
      if (!task) break;
      const cancelled = taskQueue.cancel(task.id);
      if (cancelled) {
        cancelled.error = 'budget: report-only mode, task skipped';
        saveTaskHistory(baseDir, cancelled).catch(() => {});
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
    saveTaskHistory(baseDir, task).catch(() => {});

    // Auto-update STATE.md frontmatter after each task
    const stateMdPath = resolve(baseDir, 'STATE.md');
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
    updateStateMd(stateMdPath, fm).catch(() => {});
    processed++;
  }

  return processed;
}
