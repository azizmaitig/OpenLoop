# 0013 — Dashboard observability extension (metrics, charts, trends)

## Status

Accepted.

## Context

The dashboard (src/dashboard/index.html) is a single-file vanilla HTML/JS SPA served
by the daemon. It has three pages: Live (daemon status, queue, children via WebSocket),
History (paginated task list), and Task Detail (full task record with logs).

The following observability data exists in the engine but is invisible to the dashboard:

- **Budget** — `BudgetStatus` (ok/report_only/exceeded, runsToday, cap) computed by
  `budget.ts` from the run-log (JSONL in `loop-run-log.md`) — never exposed via API.
- **Run log** — append-only JSONL in `loop-run-log.md` tracking every run outcome
  (pass/fail/error/paused/budget_exit) — never surfaced in the UI.
- **Trigger fires** — `CronTrigger` tracks a private `lastFired` timestamp and
  `FileWatchTrigger` tracks nothing. No fire count, no exposure.
- **Phase-loop progress** — `STATE.md` in `_agent-loop-output/` tracks the running
  phase loop's state (currentState, iteration, phaseResults) — never polled or
  broadcast by the daemon (the existing `.omo/plans/dashboard-loop-state.md` plan
  addresses this separately).
- **Aggregated metrics** — no pass/fail ratio, no avg/p95 duration, no throughput
  (tasks/min, phases/hour) over any time window.

The system already persists the raw data (task history in `_loop-history/<id>/task.json`,
run log in `loop-run-log.md`, budget in-memory). What's missing is the aggregation
layer and the UI to display it.

## Decision

### Extend, don't rebuild

The existing 1175-line vanilla dashboard SPA will be extended with a new Metrics tab.
No React, Vue, or bundler. Rationale: adding a build pipeline, `npm install`, and
framework boilerplate for a single-user dev-tool dashboard is disproportionate to
the value. The existing hash router, WebSocket client, dark theme, and 3-page layout
are working and test-covered.

### Chart.js from CDN for time-series

Chart.js (44 KB minzipped) loaded via `<script>` tag from CDN — no npm install, no
`package.json` change, no bundler. Used for:
- Task throughput sparkline (tasks/min over time)
- Failure rate trend (last N tasks)
- Duration distribution (passing tasks' duration over time)

If Chart.js CDN is unavailable, the dashboard renders a plain table fallback with
no visual degradation — the metrics are still readable.

### Compute metrics on request

Metrics are computed from raw data at request time via a new `/api/metrics` endpoint,
not pre-computed in memory. Rationale: this is a single-user dev tool with hundreds
(rather than millions) of tasks. Computing p95 duration, pass/fail ratio, and
throughput from the history directory + run-log on each request adds ~10-50ms of
latency and zero infrastructure complexity. Pre-computed aggregation can be added
later if performance becomes an issue.

### Trigger fire counters

`TriggerDef` and the trigger classes gain `fireCount` and `lastFiredAt` fields.
`CronTrigger._onFire()` and `FileWatchTrigger._onTrigger()` increment the counter.
`TriggerManager.list()` returns them. Exposed via `GET /api/metrics`.

Three metrics bundles exposed through a single endpoint:

#### 1. Task metrics (from history + run-log)
- Total runs (ever)
- Pass/fail/error counts (last N tasks, N configurable via query param)
- Avg, p50, p95 duration for passing tasks (last N)
- Task throughput: tasks/min over configurable window (10m, 1h, 24h default)

#### 2. Budget status (from budget.ts)
- `BudgetStatus` fields: status, runsToday, cap, remaining (computed)

#### 3. Trigger metrics (from triggers.ts)
- Per-trigger: `fireCount`, `lastFiredAt`, `type`, `id`
- Total trigger fires (all triggers)

### API shape

```
GET /api/metrics?window=1h&lastN=100

{
  "taskMetrics": {
    "totalRuns": 542,
    "lastN": 100,
    "passCount": 78,
    "failCount": 18,
    "errorCount": 4,
    "avgDurationMs": 1234,
    "p50DurationMs": 890,
    "p95DurationMs": 4500,
    "throughputTasksPerMin": 2.3,
    "throughputWindowMinutes": 60
  },
  "budget": {
    "status": "ok",
    "runsToday": 42,
    "cap": 100,
    "remaining": 58
  },
  "triggers": [
    { "id": "daily-triage", "type": "cron", "expression": "0 9 * * *",
      "fireCount": 14, "lastFiredAt": "2026-07-10T09:00:00Z", "running": true },
    { "id": "file-watcher", "type": "fileWatch", "watchDir": "./plans",
      "fireCount": 3, "lastFiredAt": "2026-07-10T08:30:00Z", "running": true }
  ]
}
```

### Dashboard UI

A 4th hash route: `#/metrics`. Layout:
- Top row: 3 stat cards (Total Runs, Pass Rate %, Budget Remaining)
- Middle: Task throughput line chart (tasks/min over time window)
- Bottom: Trigger table with fire counts and last-fired timestamps

The existing Live (`#/`), History (`#/history`), and Task Detail (`#/task/:id`)
pages are untouched.

## Alternatives considered

| Alternative | Rejected because |
|-------------|-----------------|
| Rebuild dashboard in React/Vue | No build pipeline needed for a dev-tool dashboard. Existing SPA works. Adding npm + bundler for one Metrics tab is disproportionate. |
| Pre-computed metrics store (incremental aggregation) | Premature optimization. ~500 task history files on disk, computing on request adds ~10-50ms. Can add incremental aggregation later if performance degrades. |
| Prometheus `/metrics` endpoint + Grafana | Overkill for a single-user dev-tool daemon. Requires Prometheus server, Grafana instance, port configuration. The dashboard already exists and has WebSocket live updates. |
| Server-Sent Events for metrics push | Existing WebSocket connection handles live updates. No need for a second real-time channel. |
| D3.js or raw Canvas for charts | Chart.js is 44 KB, has built-in time-series support, tooltips, responsive sizing. D3 requires 3x the code for the same output. Raw Canvas makes tooltips and interactions manual. |

## Consequences

- One new file: `src/metrics.ts` (compute logic)
- Changes to: `src/routes.ts` (new route), `src/dashboard/index.html` (new #/metrics tab),
  `src/types.ts` (TriggerDef extended with fireCount/lastFiredAt),
  `src/triggers.ts` (CronTrigger + FileWatchTrigger + TriggerManager fire tracking),
  `src/budget.ts` (expose checkBudget more directly, or route calls it)
- No changes to: `src/loop-runner.ts`, `src/daemon.ts` (add route only, no structural change),
  `src/state.ts`, `src/execute-phases.ts`, or any core engine file
- No new npm dependencies (Chart.js from CDN: 44 KB)
- `/api/metrics` response time increases linearly with history size (~1ms per 1000 entries
  on SSD). Acceptable for single-user dev tool.
- Trigger fire counters reset on daemon restart (in-memory only). Acceptable — triggers
  are a live-monitoring concern, not historical audit.

## Compliance with existing constraints

- **No loop-runner.ts/loop.ts/cli.ts changes** ✅ — metrics layer is purely additive,
  no changes to the phase-loop engine.
- **No new npm dependencies** ✅ — Chart.js via CDN, not npm.
- **No React/bundler** ✅ — vanilla JS extension.
- **Only daemon-mode concern** ✅ — metrics endpoint is served by the daemon; standalone
  `start` mode is unaffected.
