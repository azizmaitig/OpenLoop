import { resolve } from 'node:path';
import { readRunLog as _readRunLog } from './run-log.js';

const RUN_LOG_FILENAME = 'loop-run-log.md';
const DEFAULT_DAILY_CAP = 100;

export interface BudgetStatus {
  status: 'ok' | 'report_only' | 'exceeded';
  runsToday: number;
  cap: number;
}

function getDailyCap(): number {
  const env = process.env.LOOP_DAILY_RUN_CAP;
  if (env === undefined || env === '') return DEFAULT_DAILY_CAP;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}

/**
 * Sum runs_count from entries within the last 24 hours.
 * Each entry without an explicit runs_count counts as 1.
 */
export async function countRunsLast24h(baseDir: string = '.'): Promise<number> {
  const entries = _readRunLog(resolve(baseDir, RUN_LOG_FILENAME), 24);
  let total = 0;
  for (const entry of entries) {
    total += typeof entry.runs_count === 'number' ? entry.runs_count : 1;
  }
  return total;
}

/**
 * Return the remaining run budget (dailyCap - runsToday).
 * Returns 0 if the budget is exhausted or negative.
 */
export async function remainingRuns(baseDir: string = '.'): Promise<number> {
  const cap = getDailyCap();
  const used = await countRunsLast24h(baseDir);
  return Math.max(0, cap - used);
}

/**
 * Check the daily run budget.
 * - ok:         runs < 80% of cap
 * - report_only: runs >= 80% but < 100% of cap
 * - exceeded:   runs >= 100% of cap
 */
export async function checkBudget(baseDir: string = '.'): Promise<BudgetStatus> {
  const cap = getDailyCap();
  const runsToday = await countRunsLast24h(baseDir);

  if (runsToday >= cap) {
    return { status: 'exceeded', runsToday, cap };
  }
  if (runsToday >= cap * 0.8) {
    return { status: 'report_only', runsToday, cap };
  }
  return { status: 'ok', runsToday, cap };
}
