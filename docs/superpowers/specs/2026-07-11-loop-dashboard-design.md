# Loop Observability Dashboard v2 — Design Spec

**Date**: 2026-07-11
**Project**: `10-Projects/11-Active/agent-loop` (Bun + TypeScript loop orchestrator)
**Status**: Approved by user (build + L2 enabled)

## 1. Goal

Replace the existing vanilla-JS dashboard (`src/dashboard/index.html`) with a
production-grade React/TypeScript observability dashboard for the loop itself,
showing **live metrics and detailed indicators** about loop health, phase
performance, LLM verdicts, throughput, retries, child loops, triggers, budget,
and errors.

## 2. Non-Goals (YAGNI)

- No auth on the dashboard (loop is localhost-only; `LOOP_API_KEY` already gates mutating routes).
- No separate backend server — reuse the existing Bun daemon.
- No token/cost tracking in v1 (requires instrumenting `src/llm.ts`; deferred to P1).
- No deployment/push (build artifact only).

## 3. Architecture

```
React SPA (Vite + TS)
  ├─ uPlot ............ high-frequency time-series (latency, throughput, cost)
  ├─ Recharts ......... overview stat cards / bars
  ├─ TanStack Query ... server state, staleTime: Infinity
  ├─ TanStack Virtual . virtualized task-history / event tables
  └─ WS/SSE bridge .... RAF-batched flush (no render storm)
        │  GET /state, /api/metrics, /api/metrics/timeseries,
        │  /api/health-score, /api/checkpoint, /api/history, /api/tasks/:id,
        │  /loops  +  WS /ws (state_change / child_status_change / task_completed)
        ▼
  Bun daemon (existing) + ADDITIVE endpoints (see §5)
```

**Serving**: Vite `build.outDir` → `agent-loop/src/dashboard/` (relative to app
root `dashboard/`), `base: './'`. Daemon already serves `src/dashboard/index.html`
at `GET /dashboard` — no daemon code change required for serving.

## 4. Data Sources

| Signal | Source | Protocol |
|---|---|---|
| Daemon status, uptime, pid, port | `GET /state` | poll / WS `state_change` |
| Queue length, current task | `GET /state` | poll / WS |
| FSM state + iteration | `GET /state` + `STATE.md` | poll / WS |
| Task metrics (pass/fail/error, p50/p95, throughput) | `GET /api/metrics` | poll |
| Budget (runsToday/cap/remaining) | `GET /api/metrics` | poll |
| Triggers (fireCount, lastFiredAt) | `GET /api/metrics` | poll |
| Task history (paginated) | `GET /api/history` | poll |
| Task detail (phases, stdout, judgment) | `GET /api/tasks/:id` | poll |
| Child loops | `GET /loops` | poll / WS `child_status_change` |
| Task completion events | WS `task_completed` | realtime |
| Health score (0–1.0) | `GET /api/health-score` (NEW) | poll |
| Time-series (ring buffer) | `GET /api/metrics/timeseries?window=` (NEW) | poll |
| Checkpoint progress | `GET /api/checkpoint?plan=` (NEW) | poll |

## 5. Backend Additions (additive only — no edits to existing logic)

1. **`GET /api/health-score`** — compute `computeHealthScore` from current
   `LoopState` (passingPhases/totalPhases). Expose `computeHealthScore`
   (currently in `src/memory-hooks.ts`) via a small `src/dashboard-api.ts`
   module imported by `routes.ts`.
2. **`GET /api/metrics/timeseries?window=5m|1h|24h`** — in-memory ring buffer
   (max ~2000 points) appended on every `state_change` broadcast in
   `daemon.ts`; returns downsampled series for: iteration, queueLength,
   healthScore, p95DurationMs, passRate. Enables real trend lines.
3. **`GET /api/checkpoint?plan=<name>`** — `loadCheckpoint` from
   `_agent-loop-output/checkpoint-{planName}.json`; returns
   `completedTaskIds`, `inProgressTaskId`, `results`.
4. New module `src/dashboard-api.ts` exports these handlers; `routes.ts` wires
   them. **No modification of existing route handlers or daemon logic** beyond
   appending new `if` branches.

## 6. Frontend — Screens

**Screen 1 — Ops Health**
- Health strip (green/amber/red from health-score + budget + error rate).
- Live FSM **state-timeline** (Grafana-style color bars over time).
- Key stat cards w/ sparklines: throughput (tasks/min), p95 phase duration,
  error rate, budget remaining, active child loops.
- Throughput + latency time-series (uPlot).
- Active alerts panel (start with 2–3: stuck run >T s, error rate spike,
  budget >80%).

**Screen 2 — Diagnostic**
- Loop/plan selector → drill-down.
- Phase table: name, duration p50/p95, status, pass/fail (sortable).
- Virtualized task history (`/api/history`) + task detail drawer
  (`/api/tasks/:id`) showing phases, stdout, LLM judgment.
- Live WS **event feed** (filterable by type) — `state_change`,
  `child_status_change`, `task_completed`.
- Checkpoint progress bar (from `/api/checkpoint`).

## 7. Metric Categories (P0)

1. Loop health — FSM state, iteration, uptime, status strip
2. Phase perf — per-phase duration p50/p95, success/fail rate, heatmap
3. LLM verdict — pass/fail rate, quality trend
4. Throughput/queue — queue depth, tasks/min, schedule-to-start
5. Retry/heal — retry count, heal attempts
6. Child loops — active count, per-child status
7. Triggers — fire rate, lastFiredAt
8. Budget — runsToday/cap/remaining
9. Errors — type classification, error rate

(P1 deferred: token/cost burn rate, cost/run, budget-vs-consumed.)

## 8. Pitfalls Handled

- WS/SSE updates buffered in `useRef`, flushed via `requestAnimationFrame`
  (avoids React render storm).
- Statistical thresholds (not round numbers) for alerts.
- Start with 2–3 alerts only (avoid fatigue).
- Canvas (uPlot) for all time-series; disable animations on live charts.
- `base: './'` so assets resolve under `/dashboard`.

## 9. Acceptance Criteria

- `bun run build` (or `npm run build`) in `dashboard/` succeeds.
- Daemon `GET /dashboard` returns the built SPA; it renders without console errors.
- All P0 metrics render from live or synthetic loop data.
- New endpoints return valid JSON; existing `bun test` suite still green.
- Typecheck clean.
