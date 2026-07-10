/**
 * daemon-api.ts — seam interface between HTTP routes and Daemon internals.
 *
 * Routes only access Daemon state through this narrow interface,
 * never through the Daemon class directly.
 */

import type { ServerWebSocket } from 'bun';
import type { DaemonStatus, Task, LLMConfig, HistoryEntry, HistoryListResponse } from './types.js';
import type { TaskQueue } from './task-queue.js';
import type { TriggerManager } from './triggers.js';
import type { LoopOrchestrator } from './orchestrator.js';
import type { StateMdFrontmatter } from './state.js';

/**
 * Narrow interface exposed to HTTP/WS route handlers.
 * Routes never touch Daemon internals directly.
 */
export interface DaemonAPI {
  getState(): DaemonStatus & { queueLength: number; currentTask: Task | null };
  stop(): void;
  isAuthorized(req: Request): boolean;
  isPaused(): Promise<boolean>;
  broadcast(type: string, data: unknown): void;
  maybeProcessQueue(): void;
  callLLM(config: LLMConfig, prompt: string, system?: string): Promise<string>;
  saveTaskHistory(task: Task): Promise<string>;
  readTaskHistory(taskId: string): Promise<HistoryEntry | null>;
  listTaskHistory(page?: number, pageSize?: number): Promise<HistoryListResponse>;
  updateStateMd(fm: StateMdFrontmatter): Promise<void>;
  isSafeCommand(command: string): boolean;
  readonly taskQueue: TaskQueue;
  readonly orchestrator: LoopOrchestrator;
  readonly triggerManager: TriggerManager;
  readonly baseDir: string;
  readonly dashboardHtml: string;
  readonly startedAt: number;
  readonly server: ReturnType<typeof Bun.serve> | null;
  readonly wsClients: Set<ServerWebSocket<unknown>>;
}
