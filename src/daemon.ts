import { resolve } from 'node:path';
import type { DaemonStatus, Task } from './types.js';
import { TaskQueue } from './task-queue.js';
import { saveTaskHistory, readTaskHistory, listTaskHistory } from './history.js';
import { updateStateMd } from './state.js';
import type { StateMdFrontmatter } from './state.js';
import { CronTrigger, FileWatchTrigger, TriggerManager } from './triggers.js';
import { LoopOrchestrator } from './orchestrator.js';
import { startHttpServer } from './http-server.js';
import type { HttpServerHandlers, HttpServerInstance } from './http-server.js';
import { loadDashboardHtml } from './dashboard.js';

export class Daemon {
  private _status: DaemonStatus;
  private httpServer: HttpServerInstance | null = null;
  private _stateInterval: ReturnType<typeof setInterval> | null = null;
  private _childInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt: number = 0;
  private stopResolve: (() => void) | null = null;
  private processing = false;
  private _loopsConfigPath: string | undefined;
  readonly taskQueue = new TaskQueue();
  readonly triggerManager = new TriggerManager();
  readonly orchestrator: LoopOrchestrator;
  readonly baseDir: string;

  constructor(
    private _port: number = 3000,
    baseDir?: string,
    opts?: { cron?: string; watchDir?: string; loopsConfig?: string },
  ) {
    this._loopsConfigPath = opts?.loopsConfig;
    this.orchestrator = new LoopOrchestrator(this.taskQueue, this.triggerManager);
    this.orchestrator.onTaskEnqueued = () => this.maybeProcessQueue();
    this._status = {
      status: 'idle',
      uptime: 0,
      startTime: '',
      version: '0.6.0',
      pid: process.pid,
      port: _port,
    };
    this.baseDir = baseDir ?? resolve('.');

    // Register triggers from CLI options
    if (opts?.cron) {
      const cronExpr = opts.cron;
      try {
        const trigger = new CronTrigger(cronExpr, () => {
          this.taskQueue.enqueue(cronExpr, { timeoutMs: 60000 });
          this.maybeProcessQueue();
        });
        this.triggerManager.register('cron-cli', trigger);
      } catch (err) {
        console.error(`[daemon] Invalid cron expression "${cronExpr}":`, err instanceof Error ? err.message : String(err));
      }
    }

    if (opts?.watchDir) {
      const trigger = new FileWatchTrigger(opts.watchDir, () => {
        this.taskQueue.enqueue(`process-plan`, { timeoutMs: 60000 });
        this.maybeProcessQueue();
      });
      this.triggerManager.register('watch-cli', trigger);
    }
  }

  getState(): DaemonStatus & { queueLength: number; currentTask: Task | null } {
    const uptime = this.startedAt > 0
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    return {
      ...this._status,
      uptime,
      queueLength: this.taskQueue.length,
      currentTask: this.taskQueue.current,
    };
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this._status = {
      ...this._status,
      status: 'running',
      startTime: new Date().toISOString(),
    };

    // Build handlers for the HTTP server
    const handlers: HttpServerHandlers = {
      getState: () => this.getState(),
      stopDaemon: () => this.stop(),
      enqueueTask: (command, timeoutMs, llm) =>
        this.taskQueue.enqueue(command, { timeoutMs, llm: llm ? { mcpServer: '', tool: '', prompt: llm } : undefined }),
      onTaskEnqueued: () => this.maybeProcessQueue(),
      listChildren: () => this.orchestrator.listChildren(),
      startChild: (id) => this.orchestrator.startChild(id),
      stopChild: (id) => this.orchestrator.stopChild(id),
      addChild: (def) => this.orchestrator.addChild(def),
      removeChild: (id) => this.orchestrator.removeChild(id),
      getChildState: (id) => this.orchestrator.getChildState(id) ?? undefined,
      listTaskHistory: (dir, page, pageSize) => listTaskHistory(dir, page, pageSize),
      readTaskHistory: (dir, id) => readTaskHistory(dir, id),
      baseDir: this.baseDir,
    };

    const dashboardHtml = loadDashboardHtml();
    this.httpServer = startHttpServer(this._port, handlers, dashboardHtml);

    this._port = this.httpServer.port;
    this._status.port = this.httpServer.port;

    console.error(`Daemon v${this._status.version} listening on port ${this.httpServer.port}`);

    // Start triggers
    if (this.triggerManager.count > 0) {
      this.triggerManager.startAll();
      console.error(`Started ${this.triggerManager.count} trigger(s)`);
    }

    const loopsConfig = this._loopsConfigPath;
    if (loopsConfig) {
      await this.orchestrator.loadFromConfig(loopsConfig);
    }

    // Broadcast state every 2s
    this._stateInterval = setInterval(() => {
      if (this._status.status !== 'running' || !this.httpServer) return;
      this.httpServer.broadcast('state_change', { ...this.getState(), children: this.orchestrator.listChildren() });
    }, 2000);

    // Check child status changes every 1s
    let prevChildrenJson = JSON.stringify(this.orchestrator.listChildren());
    this._childInterval = setInterval(() => {
      if (this._status.status !== 'running' || !this.httpServer) return;
      const current = this.orchestrator.listChildren();
      const currentJson = JSON.stringify(current);
      if (currentJson !== prevChildrenJson) {
        prevChildrenJson = currentJson;
        this.httpServer.broadcast('child_status_change', current);
      }
    }, 1000);

    await new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  stop(): void {
    if (this._status.status === 'stopped') return;
    this._status.status = 'stopped';
    if (this._stateInterval) clearInterval(this._stateInterval);
    if (this._childInterval) clearInterval(this._childInterval);
    this.triggerManager.stopAll();
    this.httpServer?.stop();
    this.stopResolve?.();
    console.error('Daemon stopped gracefully');
  }

  private async executeTask(task: Task): Promise<void> {
    if (!isSafeCommand(task.command)) {
      this.taskQueue.fail(task.id, 'Command rejected: unsafe shell metacharacters detected');
      this.httpServer?.broadcast('task_completed', this.taskQueue.get(task.id));
      return;
    }

    const timeoutMs = task.timeoutMs ?? 60000;
    const startTime = Date.now();

    try {
      const proc = Bun.spawn(['cmd.exe', '/c', task.command], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = AbortSignal.timeout(timeoutMs);
      const [stdout, stderr] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
      ]);

      const exitCode = await proc.exited;

      this.taskQueue.complete(task.id, {
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startTime,
      });
      this.httpServer?.broadcast('task_completed', this.taskQueue.get(task.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.taskQueue.fail(task.id, msg);
      this.httpServer?.broadcast('task_completed', this.taskQueue.get(task.id));
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this._status.status === 'running') {
      const task = this.taskQueue.dequeue();
      if (!task) break;

      await this.executeTask(task);

      // Save history (best-effort, non-blocking)
      const completedTask = this.taskQueue.get(task.id);
      if (completedTask) {
        saveTaskHistory(this.baseDir, completedTask).catch(() => {});

        // Auto-update STATE.md frontmatter after each task
        const stateMdPath = resolve(this.baseDir, 'STATE.md');
        const taskCount = this.taskQueue.history.length;
        const fm: StateMdFrontmatter = {
          last_run: new Date().toISOString(),
          current_state: this._status.status,
          iteration: taskCount,
          active_children: this.orchestrator.listChildren().filter(c => c.status === 'running').length,
          high_priority: 0,
          watch_items: 0,
          task_count: taskCount,
        };
        updateStateMd(stateMdPath, fm).catch(() => {});
      }
    }

    this.processing = false;
  }

  private maybeProcessQueue(): void {
    this.processQueue().catch(() => {});
  }
}

const SHELL_METACHARS = /[;&|`$\n\r]/;

function isSafeCommand(cmd: string): boolean {
  return !SHELL_METACHARS.test(cmd);
}
