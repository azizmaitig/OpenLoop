/**
 * daemon-api.ts — seam interface between HTTP routes and Daemon internals.
 *
 * Routes only access Daemon state through this narrow interface,
 * never through the Daemon class directly.
 */

import type { ServerWebSocket } from 'bun';
import type { DaemonStatus, Task } from './types.js';
import type { TaskQueue } from './task-queue.js';
import type { TriggerManager } from './triggers.js';
import type { LoopOrchestrator } from './orchestrator.js';

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
  readonly taskQueue: TaskQueue;
  readonly orchestrator: LoopOrchestrator;
  readonly triggerManager: TriggerManager;
  readonly baseDir: string;
  readonly dashboardHtml: string;
  readonly startedAt: number;
  readonly server: ReturnType<typeof Bun.serve> | null;
  readonly wsClients: Set<ServerWebSocket<unknown>>;
}
