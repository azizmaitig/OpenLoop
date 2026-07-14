import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChildLoopDef, ChildLoopState, ChildLoopSummary, LoopsConfig, StartChildResult, StopChildResult, TriggerDef } from './types.js';
import { CronTrigger, FileWatchTrigger, TriggerManager } from './triggers.js';
import { TaskQueue } from './task-queue.js';
import { parseYaml } from './yaml.js';
import { isSafePath } from './shell.js';
import { remainingRuns as budgetRemaining } from './budget.js';
import { comparePriority } from './collision.js';

let childIdCounter = 0;
function generateChildId(): string {
  childIdCounter++;
  return `child-${Date.now().toString(36)}-${childIdCounter}`;
}

export interface OrchestratorConfig {
  maxConcurrentLoops?: number;
  avgCostPerLoop?: number;
  getRemainingRuns?: () => Promise<number>;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_AVG_COST = 1;

export class LoopOrchestrator {
  private children = new Map<string, ChildLoopState>();
  private pendingQueue: string[] = [];
  private _maxConcurrentLoops: number;
  private _avgCostPerLoop: number;
  private _getRemainingRuns: () => Promise<number>;

  constructor(
    private taskQueue: TaskQueue,
    private triggerManager: TriggerManager,
    config?: OrchestratorConfig,
  ) {
    this._maxConcurrentLoops = config?.maxConcurrentLoops ?? DEFAULT_MAX_CONCURRENT;
    this._avgCostPerLoop = config?.avgCostPerLoop ?? DEFAULT_AVG_COST;
    this._getRemainingRuns = config?.getRemainingRuns ?? (() => budgetRemaining());
  }

  /** Expose the pending queue length for observability (names in queue). */
  get queuedChildNames(): string[] {
    return this.pendingQueue.map(id => this.children.get(id)?.name ?? id);
  }

  /** Set by Daemon to trigger queue processing when a child trigger enqueues a task. */
  onTaskEnqueued: (() => void) | null = null;

  addChild(def: ChildLoopDef): string {
    const id = generateChildId();
    const triggers: TriggerDef[] = [...(def.triggers ?? [])];

    // Support watchDir shorthand: auto-create a fileWatch trigger if not already present
    if (def.watchDir && !triggers.some(t => t.type === 'fileWatch' && 'watchDir' in t && t.watchDir === def.watchDir)) {
      triggers.push({ type: 'fileWatch', watchDir: def.watchDir });
    }

    const state: ChildLoopState = {
      id,
      name: def.name,
      status: 'stopped',
      planPath: def.planPath,
      triggers,
      enabled: def.enabled !== false,
      createdAt: new Date().toISOString(),
    };

    this.children.set(id, state);
    return id;
  }

  removeChild(id: string): boolean {
    const child = this.children.get(id);
    if (!child) return false;

    if (child.status === 'running') {
      this.deregisterChildTriggers(id);
    }

    // Also remove from pending queue if queued
    const qIdx = this.pendingQueue.indexOf(id);
    if (qIdx !== -1) this.pendingQueue.splice(qIdx, 1);

    this.children.delete(id);
    return true;
  }

  getChildState(id: string): ChildLoopState | null {
    return this.children.get(id) ?? null;
  }

  listChildren(): ChildLoopSummary[] {
    return Array.from(this.children.values()).map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      planPath: c.planPath,
      triggerCount: c.triggers.length,
      enabled: c.enabled,
    }));
  }

  async startChild(id: string): Promise<StartChildResult> {
    const child = this.children.get(id);
    if (!child) return 'not_found';
    if (child.status === 'running') return 'already_running';

    // If already queued, this is a no-op; it stays in queue
    if (child.status === 'queued') return 'ok';

    const cap = await this.effectiveCap();

    // Count currently running children
    let runningCount = 0;
    for (const c of this.children.values()) {
      if (c.status === 'running') runningCount++;
    }

    if (runningCount >= cap) {
      // At capacity — queue the child
      child.status = 'queued';
      child.error = undefined;
      this.pendingQueue.push(id);
      return 'ok';
    }

    await this.doStartChild(child);
    await this.drainQueue();
    return 'ok';
  }

  async stopChild(id: string): Promise<StopChildResult> {
    const child = this.children.get(id);
    if (!child) return 'not_found';
    if (child.status !== 'running') return 'not_running';

    child.status = 'stopped';
    this.deregisterChildTriggers(id);

    // A slot freed — try to start queued children
    await this.drainQueue();
    return 'ok';
  }

  async loadFromConfig(path: string): Promise<void> {
    const resolvedPath = resolve(path);

    if (!existsSync(resolvedPath)) {
      console.warn(`[orchestrator] loops config not found at ${resolvedPath}, skipping`);
      return;
    }

    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      const config = parseLoopsYaml(content);

      // Apply top-level orchestrator config from YAML (if present)
      if (config.maxConcurrentLoops !== undefined) {
        this._maxConcurrentLoops = config.maxConcurrentLoops;
      }
      if (config.avgCostPerLoop !== undefined) {
        this._avgCostPerLoop = config.avgCostPerLoop;
      }

      for (const def of config.loops) {
        const id = this.addChild(def);
        console.log(`[orchestrator] Registered child loop "${def.name}" (${id})`);
        if (def.enabled !== false) {
          await this.startChild(id);
          console.log(`[orchestrator] Auto-started child loop "${def.name}"`);
        }
      }
    } catch (err) {
      console.error(`[orchestrator] Failed to load loops config:`, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Calculate the effective concurrency cap:
   *   effectiveCap = min(maxConcurrentLoops, floor(remainingRuns / avgCostPerLoop))
   */
  private async effectiveCap(): Promise<number> {
    const remaining = await this._getRemainingRuns();
    const maxByBudget = Math.floor(remaining / this._avgCostPerLoop);
    return Math.min(this._maxConcurrentLoops, Math.max(0, maxByBudget));
  }

  /**
   * Actually start a child: set status, register triggers, enqueue task.
   * Assumes caller has already validated the child can start.
   */
  private async doStartChild(child: ChildLoopState): Promise<void> {
    child.status = 'running';
    child.startedAt = new Date().toISOString();
    child.error = undefined;

    this.registerChildTriggers(child.id);

    if (child.planPath && !isSafePath(child.planPath)) {
      child.status = 'stopped';
      child.error = `Invalid planPath: "${child.planPath}" contains unsafe characters`;
      return;
    }

    const enqueueCmd = child.planPath
      ? `bun run loop.ts start --plan "${child.planPath}" --max-iterations 1`
      : child.name;
    this.taskQueue.enqueue(enqueueCmd, { timeoutMs: 60000 });
    this.onTaskEnqueued?.();
  }

  /**
   * Process the pending queue: sort queued children by priority (highest first)
   * and start as many as fit within the effective cap.
   */
  private async drainQueue(): Promise<void> {
    if (this.pendingQueue.length === 0) return;

    const cap = await this.effectiveCap();

    // Count currently running
    let runningCount = 0;
    for (const c of this.children.values()) {
      if (c.status === 'running') runningCount++;
    }

    const available = cap - runningCount;
    if (available <= 0) return;

    // Sort pending queue by priority descending
    this.pendingQueue.sort((a, b) => {
      const nameA = this.children.get(a)?.name ?? '';
      const nameB = this.children.get(b)?.name ?? '';
      return comparePriority(nameA, nameB);
    });

    const toStart = this.pendingQueue.splice(0, available);
    for (const id of toStart) {
      const child = this.children.get(id);
      if (child && child.status === 'queued') {
        await this.doStartChild(child);
      }
    }
  }

  private registerChildTriggers(childId: string): void {
    const child = this.children.get(childId);
    if (!child) return;

    for (let i = 0; i < child.triggers.length; i++) {
      const t = child.triggers[i];
      const triggerId = `${childId}-trigger-${i}`;
      const onFire = () => {
        if (child.planPath && !isSafePath(child.planPath)) {
          console.warn(`[orchestrator] Skipping trigger for child "${child.name}": invalid planPath`);
          return;
        }
        this.taskQueue.enqueue(`bun run loop.ts start --plan "${child.planPath}" --max-iterations 1`, { timeoutMs: 60000 });
        this.onTaskEnqueued?.();
      };

      if (t.type === 'cron') {
        const trigger = new CronTrigger(t.expression, onFire);
        this.triggerManager.register(triggerId, trigger);
        trigger.start();
      } else if (t.type === 'fileWatch') {
        const trigger = new FileWatchTrigger(t.watchDir, onFire, t.pattern ? { pattern: t.pattern } : undefined);
        this.triggerManager.register(triggerId, trigger);
        trigger.start();
      }
    }
  }

  private deregisterChildTriggers(childId: string): void {
    const child = this.children.get(childId);
    if (!child) return;

    for (let i = 0; i < child.triggers.length; i++) {
      this.triggerManager.unregister(`${childId}-trigger-${i}`);
    }
  }
}

// ── Loops YAML Parser ──────────────────────────────────────────────────────────

function parseLoopsYaml(content: string): LoopsConfig {
  const doc = parseYaml(content) as Record<string, unknown> | null;
  if (!doc || !Array.isArray(doc.loops)) {
    return { loops: [] };
  }
  // Validate and coerce each loop entry
  const loops: ChildLoopDef[] = [];
  for (const raw of doc.loops) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string') continue;
    const triggers: TriggerDef[] = [];
    if (Array.isArray(entry.triggers)) {
      for (const rt of entry.triggers) {
        if (!rt || typeof rt !== 'object') continue;
        const t = rt as Record<string, unknown>;
        if (t.type === 'cron' && typeof t.schedule === 'string') {
          triggers.push({ type: 'cron', expression: t.schedule });
        } else if (t.type === 'fileWatch' && typeof t.watchDir === 'string') {
          const ft: TriggerDef = { type: 'fileWatch', watchDir: t.watchDir };
          if (typeof t.pattern === 'string') (ft as any).pattern = t.pattern;
          triggers.push(ft);
        }
      }
    }
    const def: ChildLoopDef = { name: entry.name as string };
    if (typeof entry.planPath === 'string') def.planPath = entry.planPath;
    if (typeof entry.watchDir === 'string') def.watchDir = entry.watchDir;
    if (typeof entry.enabled === 'boolean') def.enabled = entry.enabled;
    if (triggers.length > 0) def.triggers = triggers;
    loops.push(def);
  }

  const result: LoopsConfig = { loops };
  if (typeof doc.maxConcurrentLoops === 'number') result.maxConcurrentLoops = doc.maxConcurrentLoops;
  if (typeof doc.avgCostPerLoop === 'number') result.avgCostPerLoop = doc.avgCostPerLoop;
  return result;
}
