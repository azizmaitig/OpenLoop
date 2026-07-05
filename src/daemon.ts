import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import type { DaemonStatus, Task } from './types.js';
import { TaskQueue } from './task-queue.js';
import { saveTaskHistory, readTaskHistory, listTaskHistory } from './history.js';
import { CronTrigger, FileWatchTrigger, TriggerManager } from './triggers.js';
import { LoopOrchestrator } from './orchestrator.js';

export class Daemon {
  private _status: DaemonStatus;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private dashboardHtml = '';
  private wsClients = new Set<ServerWebSocket<unknown>>();
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
      try {
        const trigger = new CronTrigger(opts.cron, () => {
          this.taskQueue.enqueue(opts.cron, { timeoutMs: 60000 });
          // ponytail: triggers enqueue tasks, processQueue picks them up
          this.maybeProcessQueue();
        });
        this.triggerManager.register('cron-cli', trigger);
      } catch (err) {
        console.error(`[daemon] Invalid cron expression "${opts.cron}":`, err instanceof Error ? err.message : String(err));
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

    // Cache dashboard HTML
    try {
      this.dashboardHtml = readFileSync(resolve(import.meta.dirname, 'dashboard', 'index.html'), 'utf-8');
    } catch {
      console.error('[daemon] dashboard/index.html not found — /dashboard route will return 404');
    }

    this.server = Bun.serve({
      port: this._port,
      websocket: {
        open: (ws) => {
          this.wsClients.add(ws);
          ws.send(JSON.stringify({
            type: 'state_change',
            data: { ...this.getState(), children: this.orchestrator.listChildren() },
            timestamp: new Date().toISOString(),
          }));
        },
        close: (ws) => {
          this.wsClients.delete(ws);
        },
        message: () => {},
      },
      fetch: async (req) => {
        const url = new URL(req.url);

        // GET /health
        if (url.pathname === '/health' && req.method === 'GET') {
          return Response.json({
            status: 'ok',
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
          });
        }

        // GET /state
        if (url.pathname === '/state' && req.method === 'GET') {
          return Response.json(this.getState());
        }

        // GET /api/version
        if (url.pathname === '/api/version' && req.method === 'GET') {
          return Response.json({ version: '0.6.0' });
        }

        // POST /stop
        if (url.pathname === '/stop' && req.method === 'POST') {
          setTimeout(() => this.stop(), 50);
          return Response.json({ status: 'ok' });
        }

        // POST /task — enqueue a new task
        if (url.pathname === '/task' && req.method === 'POST') {
          try {
            const body = await req.json();
            if (!body || typeof body.command !== 'string' || body.command.trim().length === 0) {
              return Response.json({ error: 'command is required' }, { status: 400 });
            }
const task = this.taskQueue.enqueue(body.command, {
  timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
  llm: body.llm ?? undefined,
});
// Defer processing so the 201 response is sent before the task moves to 'running'
setTimeout(() => this.maybeProcessQueue(), 0);
return Response.json({ id: task.id, status: task.status }, { status: 201 });
          } catch (err) {
            return Response.json({ error: 'invalid JSON body' }, { status: 400 });
          }
        }

        // GET /api/history — paginated task history
        if (url.pathname === '/api/history' && req.method === 'GET') {
          const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
          const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));
          const result = await listTaskHistory(this.baseDir, page, pageSize);
          return Response.json(result);
        }

        // GET /api/tasks/:id — single task detail
        const tasksMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (tasksMatch && req.method === 'GET') {
          const taskId = tasksMatch[1];
          const entry = await readTaskHistory(this.baseDir, taskId);
          if (!entry) {
            return Response.json({ error: 'task not found' }, { status: 404 });
          }
          return Response.json(entry);
        }

        // POST /loops/:id/start — start a child loop
        const loopsStartMatch = url.pathname.match(/^\/loops\/([^/]+)\/start$/);
        if (loopsStartMatch && req.method === 'POST') {
          const started = await this.orchestrator.startChild(loopsStartMatch[1]);
          if (started === 'not_found') {
            return Response.json({ error: 'child loop not found' }, { status: 404 });
          }
          if (started === 'already_running') {
            return Response.json({ error: 'child loop already running' }, { status: 409 });
          }
          return Response.json({ status: 'ok' });
        }

        // POST /loops/:id/stop — stop a child loop
        const loopsStopMatch = url.pathname.match(/^\/loops\/([^/]+)\/stop$/);
        if (loopsStopMatch && req.method === 'POST') {
          const stopped = await this.orchestrator.stopChild(loopsStopMatch[1]);
          if (stopped === 'not_found') {
            return Response.json({ error: 'child loop not found' }, { status: 404 });
          }
          if (stopped === 'not_running') {
            return Response.json({ error: 'child loop is not running' }, { status: 409 });
          }
          return Response.json({ status: 'ok' });
        }

        // GET /loops — list all child loops
        if (url.pathname === '/loops' && req.method === 'GET') {
          return Response.json(this.orchestrator.listChildren());
        }

        // POST /loops — create a new child loop
        if (url.pathname === '/loops' && req.method === 'POST') {
          try {
            const body = await req.json();
            if (!body || typeof body.name !== 'string' || typeof body.planPath !== 'string') {
              return Response.json({ error: 'name and planPath are required' }, { status: 400 });
            }
            const id = this.orchestrator.addChild(body);
            return Response.json({ id, status: 'created' }, { status: 201 });
          } catch {
            return Response.json({ error: 'invalid JSON body' }, { status: 400 });
          }
        }

        // DELETE /loops/:id — remove a child loop
        const loopsDeleteMatch = url.pathname.match(/^\/loops\/([^/]+)$/);
        if (loopsDeleteMatch && req.method === 'DELETE') {
          const removed = this.orchestrator.removeChild(loopsDeleteMatch[1]);
          if (!removed) {
            return Response.json({ error: 'child loop not found' }, { status: 404 });
          }
          return Response.json({ status: 'ok' });
        }

        // GET /loops/:id — single child loop state
        if (loopsDeleteMatch && req.method === 'GET') {
          const child = this.orchestrator.getChildState(loopsDeleteMatch[1]);
          if (!child) {
            return Response.json({ error: 'child loop not found' }, { status: 404 });
          }
          return Response.json(child);
        }

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          const upgraded = this.server!.upgrade(req, { data: {} });
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 400 });
          }
          return;
        }

        // GET /dashboard — serve the SPA
        if (url.pathname === '/dashboard' && req.method === 'GET') {
          if (!this.dashboardHtml) {
            return new Response('Dashboard not available', { status: 404 });
          }
          return new Response(this.dashboardHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        return new Response('Not found', { status: 404 });
      },
    });

    this._port = this.server.port;
    this._status.port = this.server.port;

    console.error(`Daemon v${this._status.version} listening on port ${this.server.port}`);

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
      if (this._status.status !== 'running') return;
      this.broadcast('state_change', { ...this.getState(), children: this.orchestrator.listChildren() });
    }, 2000);

    // Check child status changes every 1s
    let prevChildrenJson = JSON.stringify(this.orchestrator.listChildren());
    this._childInterval = setInterval(() => {
      if (this._status.status !== 'running') return;
      const current = this.orchestrator.listChildren();
      const currentJson = JSON.stringify(current);
      if (currentJson !== prevChildrenJson) {
        prevChildrenJson = currentJson;
        this.broadcast('child_status_change', current);
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
    this.server?.stop(true);
    this.stopResolve?.();
    console.error('Daemon stopped gracefully');
  }

  private broadcast(type: string, data: unknown): void {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const ws of this.wsClients) {
      try { ws.send(message); } catch { this.wsClients.delete(ws); }
    }
  }

  private async executeTask(task: Task): Promise<void> {
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
      this.broadcast('task_completed', this.taskQueue.get(task.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.taskQueue.fail(task.id, msg);
      this.broadcast('task_completed', this.taskQueue.get(task.id));
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
      }
    }

    this.processing = false;
  }

  private maybeProcessQueue(): void {
    // Fire-and-forget: start processing if not already running
    this.processQueue().catch(() => {});
  }
}
