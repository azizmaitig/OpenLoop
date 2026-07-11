/**
 * dashboard-api.ts — NEW additive module (design §5).
 *
 * Adds three read-only dashboard endpoints without touching the existing
 * metrics/route logic. It imports and *composes* existing pure functions:
 *   - computeTaskMetrics / computeBudgetMetrics (src/metrics.ts)
 *   - loadCheckpoint (src/checkpoint.ts)
 * Routes delegate to `handleDashboardApi`, which returns `null` for any path
 * it does not own, so existing behavior is untouched.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DaemonAPI } from './daemon-api.js';
import { computeTaskMetrics, computeBudgetMetrics } from './metrics.js';
import { loadCheckpoint } from './checkpoint.js';
import { computeHealthScore as computePhaseHealthScore } from './memory-hooks.js';
import type { CheckpointState } from './types.js';

// ── Types (mirror the dashboard contract) ──────────────────────────────────

export interface HealthScoreComponents {
  passRate: number; // 0–1, higher better
  errorRate: number; // 0–1, lower better
  budget: number; // 0–1 remaining/cap
  queueDepth: number; // 0–1 normalized
}

export interface HealthScore {
  score: number; // 0–100
  grade: 'healthy' | 'degraded' | 'critical';
  components: HealthScoreComponents;
  derivedFrom: { window: string; lastN: number };
}

export interface TimeSeriesPoint {
  t: number;
  v: number;
}

export interface TimeSeriesResponse {
  metric: string;
  points: TimeSeriesPoint[];
}

// Equal weights (design §7 open item). Exposed for tuning.
export const HEALTH_WEIGHTS = {
  passRate: 0.25,
  lowError: 0.25,
  budget: 0.25,
  queueDepth: 0.25,
} as const;

const QUEUE_CAP = 20;

// ── Health score ───────────────────────────────────────────────────────────

export async function computeHealthScore(
  baseDir: string,
  window: string,
  lastN: number,
): Promise<HealthScore> {
  const [taskMetrics, budget] = await Promise.all([
    computeTaskMetrics(baseDir, lastN, window),
    computeBudgetMetrics(baseDir),
  ]);

  const total = taskMetrics.passCount + taskMetrics.failCount + taskMetrics.errorCount;
  const passRate = total > 0 ? taskMetrics.passCount / total : 1;
  const errorRate = total > 0 ? taskMetrics.errorCount / total : 0;
  const budgetComp = budget.cap > 0 ? Math.max(0, budget.remaining) / budget.cap : 1;

  // DaemonAPI exposes queue depth via getState(); we read it lazily through the
  // caller-supplied api. To keep this pure-composition, queueDepth is supplied
  // by the dispatcher (`computeHealthScoreWithQueue`).
  return finalizeHealthScore(passRate, errorRate, budgetComp, 1, window, lastN);
}

/** Compose health score including a live queue-depth sample. */
export function finalizeHealthScore(
  passRate: number,
  errorRate: number,
  budgetComp: number,
  queueDepth: number,
  window: string,
  lastN: number,
): HealthScore {
  const score = Math.round(
    100 *
      (HEALTH_WEIGHTS.passRate * passRate +
        HEALTH_WEIGHTS.lowError * (1 - errorRate) +
        HEALTH_WEIGHTS.budget * budgetComp +
        HEALTH_WEIGHTS.queueDepth * queueDepth),
  );
  const grade: HealthScore['grade'] = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'critical';
  return {
    score,
    grade,
    components: { passRate, errorRate, budget: budgetComp, queueDepth },
    derivedFrom: { window, lastN },
  };
}

// ── Ring buffer for live time-series (design §5.3) ─────────────────────────

export interface TsRing {
  append(sample: TimeSeriesPoint & { metric: string }): void;
  read(metric: string, window: string): TimeSeriesResponse;
}

export function createTsRing(capacity = 1800): TsRing {
  const buffers = new Map<string, TimeSeriesPoint[]>();

  return {
    append(sample) {
      const arr = buffers.get(sample.metric) ?? [];
      arr.push({ t: sample.t, v: sample.v });
      if (arr.length > capacity) arr.splice(0, arr.length - capacity);
      buffers.set(sample.metric, arr);
    },
    read(metric, window) {
      const arr = buffers.get(metric) ?? [];
      const minutes = WINDOW_MAP[window] ?? 60;
      const cutoff = Date.now() - minutes * 60_000;
      return { metric, points: arr.filter((p) => p.t >= cutoff) };
    },
  };
}

const WINDOW_MAP: Record<string, number> = {
  '10m': 10,
  '1h': 60,
  '24h': 1440,
};

// ── Checkpoint loader (design §5.2) ────────────────────────────────────────

function planNameFromPath(planPath: string): string {
  const base = basename(planPath);
  return base.replace(/\.(ya?ml|json)$/i, '');
}

export async function loadCheckpointState(planPath?: string): Promise<CheckpointState | null> {
  const outputDir = resolve('_agent-loop-output');
  if (planPath) {
    return loadCheckpoint(planNameFromPath(planPath), outputDir);
  }
  // No planPath: pick the most recently updated checkpoint as "the active plan".
  return findActiveCheckpoint(outputDir);
}

async function findActiveCheckpoint(outputDir: string): Promise<CheckpointState | null> {
  if (!existsSync(outputDir)) return null;
  let entries: string[] = [];
  try {
    entries = (await readdir(outputDir)).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  let best: CheckpointState | null = null;
  let bestTs = 0;
  for (const f of entries) {
    try {
      const raw = await readFile(join(outputDir, f), 'utf-8');
      const state = JSON.parse(raw) as CheckpointState;
      const ts = new Date(state.updatedAt).getTime();
      if (ts > bestTs) {
        bestTs = ts;
        best = state;
      }
    } catch {
      /* ignore unparseable checkpoint */
    }
  }
  return best;
}

// ── Cold-start history bucketing (design §5.2) ─────────────────────────────

async function bucketHistory(
  api: DaemonAPI,
  metric: string,
  minutes: number,
  buckets = 60,
): Promise<TimeSeriesPoint[]> {
  const history = await api.listTaskHistory(1, 500);
  const now = Date.now();
  const span = minutes * 60_000;
  const bucketMs = span / buckets;
  const start = now - span;

  const groups: { t: number; items: { status: string; durationMs?: number }[] }[] = [];
  for (let i = 0; i < buckets; i++) {
    groups.push({ t: Math.round(start + i * bucketMs), items: [] });
  }

  for (const task of history.tasks) {
    const completed = task.completedAt ? new Date(task.completedAt).getTime() : null;
    if (completed === null || completed < start || completed > now) continue;
    const idx = Math.min(buckets - 1, Math.floor((completed - start) / bucketMs));
    groups[idx].items.push({ status: String(task.status), durationMs: task.durationMs });
  }

  return groups.map((g) => {
    const n = g.items.length;
    let v = 0;
    if (n > 0) {
      if (metric === 'throughput') {
        v = n / (bucketMs / 60_000); // tasks per minute in this bucket
      } else if (metric === 'durationP95') {
        const durs = g.items.map((x) => x.durationMs ?? 0).sort((a, b) => a - b);
        const p95 = durs[Math.max(0, Math.ceil(0.95 * durs.length) - 1)] ?? 0;
        v = p95;
      } else if (metric === 'passRate') {
        const pass = g.items.filter((x) => x.status === 'completed' || x.status === 'pass').length;
        v = pass / n;
      }
    }
    return { t: g.t, v };
  });
}

// ── Route dispatcher ───────────────────────────────────────────────────────

export async function handleDashboardApi(
  api: DaemonAPI,
  url: URL,
  req: Request,
  ring: TsRing,
): Promise<Response | null> {
  if (req.method !== 'GET') return null;

  // GET /api/health-score
  if (url.pathname === '/api/health-score') {
    const window = url.searchParams.get('window') || '1h';
    const lastN = Math.max(1, parseInt(url.searchParams.get('lastN') ?? '100', 10) || 100);
    const base = await computeHealthScore(api.baseDir, window, lastN);
    const queueDepth = 1 - Math.min(api.getState().queueLength / QUEUE_CAP, 1);

    // Phase-level health (memory-hooks.computeHealthScore operates on a
    // LoopState's phaseResults). Blend it with the task-metric pass rate so the
    // score also reflects plan checkpoint progress when one is active.
    let passRate = base.components.passRate;
    const cp = await loadCheckpointState();
    if (cp) {
      const loopState = {
        phaseResults: Object.fromEntries(
          Object.entries(cp.results).map(([id, r]) => [
            id,
            {
              status: r.status,
              exitCode: r.exitCode,
              stdout: '',
              stderr: '',
              durationMs: r.durationMs,
              evidencePath: '',
            },
          ]),
        ),
      } as unknown as Parameters<typeof computePhaseHealthScore>[0];
      passRate = 0.5 * passRate + 0.5 * computePhaseHealthScore(loopState);
    }

    const score = finalizeHealthScore(
      passRate,
      base.components.errorRate,
      base.components.budget,
      queueDepth,
      window,
      lastN,
    );
    return Response.json(score);
  }

  // GET /api/metrics/timeseries
  if (url.pathname === '/api/metrics/timeseries') {
    const metric = url.searchParams.get('metric') || 'throughput';
    const window = url.searchParams.get('window') || '1h';
    const minutes = WINDOW_MAP[window] ?? 60;

    const live = ring.read(metric, window);
    if (live.points.length > 0) {
      return Response.json(live);
    }
    // Cold start: re-bucket task history.
    const points = await bucketHistory(api, metric, minutes);
    return Response.json({ metric, points });
  }

  // GET /api/checkpoint
  if (url.pathname === '/api/checkpoint') {
    const planPath =
      url.searchParams.get('plan') ?? url.searchParams.get('planPath') ?? undefined;
    const state = await loadCheckpointState(planPath);
    if (!state) {
      return Response.json({ error: 'no checkpoint' }, { status: 404 });
    }
    return Response.json(state);
  }

  return null;
}
