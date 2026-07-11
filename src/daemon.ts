import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import type { DaemonStatus, LoopConfig, LoopState, Task, LLMConfig, HistoryEntry, HistoryListResponse } from './types.js';
import { TaskQueue } from './task-queue.js';
import { CronTrigger, FileWatchTrigger, TriggerManager } from './triggers.js';
import { LoopOrchestrator } from './orchestrator.js';
import { processQueue } from './task-processor.js';
import type { TaskContext } from './task-processor.js';
import { readPauseState, writeBothStates, setCurrentState, createInitialState, updateStateMd } from './state.js';
import type { StateMdFrontmatter } from './state.js';
import { createFetchHandler } from './routes.js';
import { createTsRing } from './dashboard-api.js';
import type { DaemonAPI } from './daemon-api.js';
import { callLLM } from './llm.js';
import { saveTaskHistory, readTaskHistory, listTaskHistory } from './history.js';
import { isSafeCommand } from './shell.js';
import { StateMachine } from './state-machine.js';
import { applyTransition } from './transition.js';
import { loadPlugins } from './plugins.js';
import { runLoopBody } from './loop-core.js';

export class Daemon {
  private _status: DaemonStatus;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private dashboardHtml = '';
  private wsClients = new Set<ServerWebSocket<unknown>>();
  private _stateInterval: ReturnType<typeof setInterval> | null = null;
  private _childInterval: ReturnType<typeof setInterval> | null = null;
  private _loopState: LoopState | null = null;
  private _loopStateInterval: ReturnType<typeof setInterval> | null = null;
  private _loopStateDir: string;
  private startedAt: number = 0;
  private stopResolve: (() => void) | null = null;
  private processing = false;
  private _loopsConfigPath: string | undefined;
  readonly taskQueue = new TaskQueue();
  readonly triggerManager = new TriggerManager();
  readonly orchestrator: LoopOrchestrator;
  readonly baseDir: string;
  readonly tsRing = createTsRing(1800);

  private _planPath: string | undefined;
  private _cronExpr: string | undefined;

  constructor(
    private _port: number = 3000,
    baseDir?: string,
    opts?: { cron?: string; watchDir?: string; loopsConfig?: string; planPath?: string; loopStateDir?: string },
  ) {
    this._planPath = opts?.planPath;
    this._cronExpr = opts?.cron;
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

    // Loop ↔ daemon path contract: must match OUTPUT_DIR (src/state.ts:141) exactly
    // so we read the same STATE.md the phase loop writes. Resolve in the body, not
    // as a parameter default, because process.cwd() is not available at param-eval time.
    // Constraint: the standalone `start` loop and the daemon MUST share CWD.
    const loopStateDir = opts?.loopStateDir ?? resolve(process.cwd(), '_agent-loop-output');
    this._loopStateDir = loopStateDir;

    // Register triggers from CLI options
    if (opts?.cron) {
      const cronExpr = opts.cron;
      try {
        const trigger = new CronTrigger(cronExpr, () => {
          this.taskQueue.enqueue(cronExpr, { timeoutMs: 60000 });
          // ponytail: triggers enqueue tasks, processQueue picks them up
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

  getState(): DaemonStatus & { queueLength: number; currentTask: Task | null; loopState: LoopState | null } {
    const uptime = this.startedAt > 0
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    return {
      ...this._status,
      uptime,
      queueLength: this.taskQueue.length,
      currentTask: this.taskQueue.current,
      loopState: this._loopState ?? null,
    };
  }

  // ── Seam methods (DaemonAPI) ─────────────────────────────────────────────────
  // Routes and the task processor reach every side-effecting capability ONLY
  // through these — they never import the underlying modules directly.

  async callLLM(config: LLMConfig, prompt: string, system?: string): Promise<string> {
    return callLLM(config, prompt, system);
  }

  saveTaskHistory(task: Task): Promise<string> {
    return saveTaskHistory(this.baseDir, task);
  }

  async readTaskHistory(taskId: string): Promise<HistoryEntry | null> {
    return readTaskHistory(this.baseDir, taskId);
  }

  listTaskHistory(page: number = 1, pageSize: number = 20): Promise<HistoryListResponse> {
    return listTaskHistory(this.baseDir, page, pageSize);
  }

  async updateStateMd(fm: StateMdFrontmatter): Promise<void> {
    await updateStateMd(resolve(this.baseDir, 'STATE.md'), fm);
  }

  isSafeCommand(command: string): boolean {
    return isSafeCommand(command);
  }

  /**
   * Run one daemon loop tick: execute all phases, update state, loop back.
   * Mimics daemon-runner.ts's tick logic but as a Daemon class method.
   * Used by the `--daemon` CLI flag when starting with phase config instead of task queue.
   */
  async runIntervalTick(config: LoopConfig): Promise<void> {
    const sm = new StateMachine();
    let state = createInitialState(config);
    setCurrentState(state);

    const intervalMs = config.daemon?.intervalMs ?? 60000;

    await writeBothStates(state);

    // Load plugins once
    const plugins = await loadPlugins(config);

    console.log(`Daemon tick started (interval: ${intervalMs}ms)`);

    let iterationCount = 0;
    let running = true;

    const shutdown = () => {
      if (!running) return;
      running = false;
      state = applyTransition('ABORT', state, sm);
      writeBothStates(state).catch(() => {});
    };

    const prevSigInt = process.listeners('SIGINT').slice();
    const prevSigTerm = process.listeners('SIGTERM').slice();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Shared per-iteration body. Daemon policy: always LOOP (ignores pass/fail,
    // runs until SIGINT); iteration count shown as ∞.
    const runTick = async (): Promise<void> => {
      if (!running) return;
      iterationCount++;
      // ponytail: daemon ignores iteration count, always shows ∞
      const fakeConfig = { ...config, maxIterations: Infinity };
      const result = await runLoopBody({
        sm,
        state,
        config: fakeConfig,
        plugins,
        iteration: iterationCount,
        writeState: writeBothStates,
        onPhaseFailed: () => {},
        logPath: resolve('loop-run-log.md'),
        decideEvent: () => 'LOOP',
      });
      state = result.state;
      console.log(`Daemon iteration ${iterationCount} complete`);
    };

    await runTick();
    const intervalId = setInterval(runTick, intervalMs);
    intervalId.unref();

    await new Promise<void>(() => {});
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this._status = {
      ...this._status,
      status: 'running',
      startTime: new Date().toISOString(),
    };

    // Cache dashboard HTML
    const dashboardPath = resolve(import.meta.dirname, 'dashboard', 'index.html');
    console.log('[dashboard] resolving:', dashboardPath);
    try {
      this.dashboardHtml = readFileSync(dashboardPath, 'utf-8');
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
      fetch: createFetchHandler(this),
    });

    this._port = this.server!.port!;
    this._status.port = this.server!.port!;

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

    // ponytail: inline child loop when --plan + --cron given (no loops.yaml needed)
    if (this._planPath && this._cronExpr) {
      const id = this.orchestrator.addChild({
        name: `plan-${this._cronExpr.replace(/\s+/g, '-')}`,
        planPath: this._planPath,
        triggers: [{ type: 'cron', expression: this._cronExpr }],
        enabled: true,
      });
      await this.orchestrator.startChild(id);
      console.log(`[daemon] Registered plan "${this._planPath}" on cron "${this._cronExpr}"`);
    } else if (this._planPath) {
      console.warn(`[daemon] --plan provided without --cron — plan will not auto-run. Add --cron to schedule it.`);
    }

    // Broadcast state every 2s
    this._stateInterval = setInterval(() => {
      if (this._status.status !== 'running') return;
      this.broadcast('state_change', { ...this.getState(), children: this.orchestrator.listChildren() });
      void this.pushTsSample();
    }, 2000);

    // Poll the phase loop's STATE.md (written by writeBothStates) and cache it for /state + WS.
    this._loopStateInterval = setInterval(async () => {
      if (this._status.status !== 'running') return;
      try {
        this._loopState = await readState(resolve(this._loopStateDir, 'STATE.md'));
      } catch {
        // keep previous value on transient read error
      }
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
    if (this._loopStateInterval) clearInterval(this._loopStateInterval);
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

  // Append a live throughput (and queue-depth) sample to the dashboard ring.
  // Best-effort: failures are non-fatal for the loop itself.
  private _lastTotal = 0;
  private _lastTotalTs = 0;
  private async pushTsSample(): Promise<void> {
    if (this._status.status !== 'running') return;
    const now = Date.now();
    const state = this.getState();
    try {
      const { total } = await this.listTaskHistory(1, 1);
      let throughput = 0;
      if (this._lastTotalTs > 0) {
        const dtMin = (now - this._lastTotalTs) / 60_000;
        if (dtMin > 0) throughput = Math.max(0, (total - this._lastTotal) / dtMin);
      }
      this._lastTotal = total;
      this._lastTotalTs = now;
      this.tsRing.append({ metric: 'throughput', t: now, v: throughput });
      this.tsRing.append({ metric: 'queueDepth', t: now, v: state.queueLength });
    } catch {
      /* non-fatal */
    }
  }

  private isAuthorized(req: Request): boolean {
    const apiKey = process.env.LOOP_API_KEY;
    if (!apiKey) return true; // No key configured = open access
    const auth = req.headers.get('Authorization');
    return auth === `Bearer ${apiKey}`;
  }

  private async isPaused(): Promise<boolean> {
    return readPauseState(resolve(this.baseDir, 'STATE.md'));
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const ctx: TaskContext = {
        taskQueue: this.taskQueue,
        baseDir: this.baseDir,
        getState: () => this._status,
        isPaused: () => this.isPaused(),
        broadcast: (type, data) => this.broadcast(type, data),
        callLLM: (config, prompt, system) => this.callLLM(config, prompt, system),
        isSafeCommand: (command) => this.isSafeCommand(command),
        saveTaskHistory: (task) => this.saveTaskHistory(task),
        updateStateMd: (fm) => this.updateStateMd(fm),
      };
      await processQueue(ctx);
    } finally {
      this.processing = false;
    }
  }

  private maybeProcessQueue(): void {
    this.processQueue().catch(() => {});
  }
}
