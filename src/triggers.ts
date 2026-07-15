import { watch, mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── Cron trigger ────────────────────────────────────────────────────────────

// Parse a single cron field into a set of allowed values (0-relative).
// Supports: *, step/N, list N,M,O, range N-M, single N.
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = part.match(/^\*\/\d+$/);
    if (stepMatch) {
      const step = parseInt(part.slice(2), 10);
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
      continue;
    }

    const dashMatch = part.match(/^(\d+)-(\d+)$/);
    if (dashMatch) {
      const start = parseInt(dashMatch[1], 10);
      const end = parseInt(dashMatch[2], 10);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= min && num <= max) {
      values.add(num);
    }
  }

  return values;
}

export class CronTrigger {
  private minuteSet: Set<number>;
  private hourSet: Set<number>;
  private domSet: Set<number>;
  private monthSet: Set<number>;
  private dowSet: Set<number>;
  /** Allow Sun=0 and Sun=7 */
  private dowSet7: Set<number>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastFired: number = 0;

  /** Number of times this trigger has fired since creation. In-memory only. */
  fireCount = 0;
  /** ISO timestamp of the most recent fire. Undefined until first fire. */
  lastFiredAt?: string;

  constructor(
    public readonly expression: string,
    public readonly onFire: () => void,
  ) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${fields.length}`);
    }

    this.minuteSet = parseCronField(fields[0], 0, 59);
    this.hourSet = parseCronField(fields[1], 0, 23);
    this.domSet = parseCronField(fields[2], 1, 31);
    this.monthSet = parseCronField(fields[3], 1, 12);
    this.dowSet = parseCronField(fields[4], 0, 6);

    // Also allow 7 (some cron specs use 7=Sun)
    const dowRaw = parseCronField(fields[4], 0, 7);

    // Normalize: 7 → 0
    this.dowSet7 = new Set<number>();
    for (const v of dowRaw) {
      this.dowSet7.add(v === 7 ? 0 : v);
    }
  }

  matches(date: Date = new Date()): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dom = date.getDate();
    const month = date.getMonth() + 1; // JS is 0-based
    const dow = date.getDay(); // JS: 0=Sun

    // If both domSet and dowSet aren't `*`, one must match (OR logic)
    const domIsStar = this.domSet.size === 31;
    const dowIsStar = this.dowSet.size === 7 && this.dowSet7.size === 7;

    const domMatch = this.domSet.has(dom);
    const dowMatch = this.dowSet.has(dow) || this.dowSet7.has(dow);

    let dateOk: boolean;
    if (domIsStar && dowIsStar) {
      dateOk = true;
    } else if (!domIsStar && !dowIsStar) {
      dateOk = domMatch || dowMatch;
    } else if (!domIsStar) {
      dateOk = domMatch;
    } else {
      dateOk = dowMatch;
    }

    return (
      this.minuteSet.has(minute) &&
      this.hourSet.has(hour) &&
      dateOk &&
      this.monthSet.has(month)
    );
  }

  /** Start polling the cron expression every `checkIntervalMs` ms (default 30s). */
  start(checkIntervalMs: number = 30_000): void {
    if (this.intervalId) return;
    this.lastFired = Date.now();

    this.intervalId = setInterval(() => {
      const now = Date.now();
      if (this.matches()) {
        // Self-correcting: skip if we already fired for this time slot
        // (prevents double-fire within the same minute)
        const currentMinute = Math.floor(now / 60_000);
        const lastMinute = Math.floor(this.lastFired / 60_000);
        if (currentMinute !== lastMinute) {
          this.lastFired = now;
          this.fireCount++;
          this.lastFiredAt = new Date().toISOString();
          try { this.onFire(); } catch { /* ponytail: callback errors logged by caller */ }
        }
      }
    }, checkIntervalMs);
    this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  get running(): boolean {
    return this.intervalId !== null;
  }
}

// ── File watch trigger ───────────────────────────────────────────────────────

export interface FileWatchOptions {
  /** Glob/pattern to filter watched files (default: *.plan.yaml) */
  pattern?: string;
  /** Debounce window in ms (default: 500) */
  debounceMs?: number;
  /** Directory to move processed files into (default: .processed) */
  processedDir?: string;
}

function fileNameMatches(file: string, pattern: string): boolean {
  // Simple glob: only `*` prefix/suffix or exact match
  if (!pattern.includes('*')) return file === pattern;
  const parts = pattern.split('*');
  if (parts.length === 2) {
    if (parts[0] && parts[1]) return file.startsWith(parts[0]) && file.endsWith(parts[1]);
    if (parts[0]) return file.startsWith(parts[0]);
    if (parts[1]) return file.endsWith(parts[1]);
  }
  return pattern === '*';
}

export class FileWatchTrigger {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFiles = new Set<string>();
  private readonly pattern: string;

  /** Number of times this trigger has fired since creation. In-memory only. */
  fireCount = 0;
  /** ISO timestamp of the most recent fire. Undefined until first fire. */
  lastFiredAt?: string;
  private readonly debounceMs: number;
  private readonly processedDir: string;

  constructor(
    public readonly watchDir: string,
    public readonly onTrigger: (filePath: string) => void,
    opts?: FileWatchOptions,
  ) {
    this.pattern = opts?.pattern ?? '*.plan.yaml';
    this.debounceMs = opts?.debounceMs ?? 500;
    this.processedDir = opts?.processedDir ?? '.processed';
  }

  start(): void {
    if (this.watcher) return;

    // Ensure watch dir exists
    if (!existsSync(this.watchDir)) {
      mkdirSync(this.watchDir, { recursive: true });
    }

    this.watcher = watch(this.watchDir, (eventType, filename) => {
      if (!filename) return;
      if (!fileNameMatches(filename, this.pattern)) return;

      this.pendingFiles.add(filename);
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.debounceTimer = null;
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const file of files) {
      const fullPath = join(this.watchDir, file);
      const processedPath = join(this.watchDir, this.processedDir, file);

      try {
        mkdirSync(join(this.watchDir, this.processedDir), { recursive: true });
          renameSync(fullPath, processedPath);
          this.fireCount++;
          this.lastFiredAt = new Date().toISOString();
          try { this.onTrigger(fullPath); } catch { /* ponytail: callback errors logged by caller */ }
      } catch {
        // File might have been removed before we processed it — skip silently
      }
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pendingFiles.clear();
  }

  get running(): boolean {
    return this.watcher !== null;
  }
}

// ── Trigger manager ─────────────────────────────────────────────────────────

export type Trigger = CronTrigger | FileWatchTrigger;

export type { TriggerDef } from './types.js';

interface RegisteredTrigger {
  id: string;
  trigger: Trigger;
}

export class TriggerManager {
  private triggers: RegisteredTrigger[] = [];

  register(id: string, trigger: Trigger): void {
    if (this.triggers.find(t => t.id === id)) {
      console.warn(`[triggers] Trigger "${id}" already registered, skipping`);
      return;
    }
    this.triggers.push({ id, trigger });
  }

  unregister(id: string): boolean {
    const idx = this.triggers.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const [entry] = this.triggers.splice(idx, 1);
    if (entry.trigger.running) {
      entry.trigger.stop();
    }
    return true;
  }

  startAll(): void {
    for (const t of this.triggers) {
      if (!t.trigger.running) {
        t.trigger.start();
      }
    }
  }

  stopAll(): void {
    for (const t of this.triggers) {
      if (t.trigger.running) {
        t.trigger.stop();
      }
    }
  }

  get(id: string): Trigger | undefined {
    return this.triggers.find(t => t.id === id)?.trigger;
  }

  list(): { id: string; type: string; running: boolean; fireCount: number; lastFiredAt?: string }[] {
    return this.triggers.map(t => ({
      id: t.id,
      type: t.trigger instanceof CronTrigger ? 'cron' : 'fileWatch',
      running: t.trigger.running,
      fireCount: t.trigger.fireCount,
      lastFiredAt: t.trigger.lastFiredAt,
    }));
  }

  get count(): number {
    return this.triggers.length;
  }

  reset(): void {
    this.stopAll();
    this.triggers = [];
  }
}
