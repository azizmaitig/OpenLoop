# Technical Design — agent-loop Dashboard Upscale (v1.5)

> **Skill note:** The requested `api-and-interface-design` skill is not present in any
> skill directory on this machine, so this design applies its core principles directly:
> contract-first typing, one REST seam (`lib/api.ts`), TanStack Query as the single
> source of truth, query layer fully isolated from views, and stable, documented
> component prop interfaces. Every claim below is grounded in the existing
> `dashboard/src` files (read during design).
>
> **HARD CONSTRAINT (binding):** Additive only. Every change lives inside
> `dashboard/` (the Vite package). **No file under `agent-loop/src/` is created,
> edited, or deleted.** No new endpoint, no new WS message, no daemon change.
> Acceptance gate: `git diff --stat src/` (repo root) must be empty.

---

## 0. Source of truth — what already exists (read, not assumed)

| File | Role | Used by this design |
|------|------|---------------------|
| `src/lib/api.ts` | **Only** REST seam; `apiFetch` + one helper per route; 404→`null` via `allowNotFound`. | New hooks call `fetchMetrics` / `fetchHistory` / `fetchCheckpoint` / `fetchLoops` — no new helper needed. |
| `src/lib/types.ts` | Mirrored backend contract. Has `CheckpointState`, `ChildLoopSummary`, `MetricsResponse` (`taskMetrics`, `budget`, `triggers[]`), `HistoryListEntry`, `TimeSeriesResponse`. | Reused verbatim; no new backend types required. |
| `src/hooks/useTimeSeries.ts` | `useQuery(['timeseries',metric,window], fetchTimeSeries, {refetchInterval:5000})`. | **Edit:** `refetchInterval` → `2000` (resolves gap G2). |
| `src/hooks/useLoops.ts` | `refetchInterval: transport==='poll' ? 3000 : false`, `staleTime:2000`. | Basis for `usePlans`; we pin cadence to 2000 (REST is the fallback source per spec §7). |
| `src/hooks/useCheckpoint.ts` | No `refetchInterval` today. | Basis for the Plans screen 2s polling. |
| `src/App.tsx` | `QueryClientProvider` + `LoopStreamProvider` + tab switch (`'ops'\|'diag'`). | **Edit:** add a third `'plans'` tab + lazy `PlansScreen`. |
| `src/main.tsx` | `ReactDOM.createRoot(...).render(<App/>)`. | **Edit:** install `notifyManager.setScheduler(requestAnimationFrame)`. |
| `src/components/TabNav.tsx` | `ScreenId = 'ops' \| 'diag'`. | **Edit:** add `'plans'`. |
| `src/screens/OpsHealthScreen.tsx` | Composes `HealthScoreCard` + `MetricCardGrid` + `LiveTimeSeriesStrip` + `ActiveLoopsPanel` + `MiniEventFeed`. | **Edit:** mount the ring feeder once; add derived charts + sparklines. |
| `src/components/ops/MetricCardGrid.tsx` | `PassFailErrorDonut / DurationCard / ThroughputCard / QueueCard`. | **Edit:** append error-rate / recovery / trigger-fire cards. |
| `src/lib/raf.ts` | `createRafScheduler()` — already batches to one rAF. | Reused by the ring feeder / query flush. |

---

## 1. Architecture & data flow

Two independent, additive data paths — neither touches `agent-loop/src/`.

```
                ┌─────────────────────── REST polling (2s) ───────────────────────┐
                │  GET /api/metrics      GET /api/history     GET /api/checkpoint  │
                │  GET /loops            GET /api/metrics/timeseries                │
                └───────────────┬─────────────────────────────────────────────────┘
                                │  (single REST seam: src/lib/api.ts)
                                ▼
        ┌───────────────────────────────────────────────────────────┐
        │  TanStack Query cache (source of truth)                     │
        │   ['metrics'] ['history'] ['checkpoint',p] ['loops']       │
        │   ['timeseries',m,w]  (w ∈ {10m,1h})                        │
        └───┬───────────────────────────┬───────────────────────────┘
            │                           │
   useLiveMetrics()              usePlans()          useDerivedSeries()
   (ring feeder,                 (plans screen)     (read ring → chart)
    mounts once)                        │
            │ derive (§2.3)             │ derive (§2.2)
            ▼                           ▼
   ┌──────────────────┐        ┌────────────────────────┐
   │  seriesRing       │        │ plan cards + progress  │
   │  (lib/series.ts)  │        │  + per-task chips      │
   └────────┬──────────┘        └────────────────────────┘
            │ read(metric,window)
            ▼
   useDerivedSeries(metric,window)  →  charts 3–7 (§3)
```

**WS:** unchanged. `useLoopStream` stays receive-only; on `task_completed` it still
invalidates `['history']`, so the next feeder tick picks up the new run. No new
event type. This honors the hard constraint (spec §3.3, research R0/R5).

**Render coalescing:** `notifyManager.setScheduler(requestAnimationFrame)` in
`main.tsx` aligns *all* Query notifications to one frame (research R2), so the
2s poll storms collapse into a single commit. This is a one-line, dashboard-only
edit and is the lowest-risk highest-leverage change in this design.

---

## 2. Module / component breakdown

### 2.1 Plans screen — `screens/PlansScreen.tsx` (NEW, lazy)

Lazy-loaded inside `App.tsx` (mirrors how `DiagnosticScreen` is imported).
Composition:

```
PlansScreen
 ├─ PlanCard[]            (one per child loop with planPath)   → components/plans/PlanCard.tsx
 └─ selected plan view:
      ├─ PlanProgress      (progress bar + task grid)          → components/plans/PlanProgress.tsx
      │     └─ TaskChip[]  (status color, pulse, tooltip)      → components/plans/TaskChip.tsx
      └─ per-task result strip (fail/error rows: exitCode+stderr)
```

Behaviours (from spec §2, carried as contract):
- Poll `/api/checkpoint?planPath=<encoded>` and `/loops` every **2s**.
- Plan list = one card per `ChildLoopSummary` whose `planPath` is non-empty.
- Clicking a card sets `selectedPlanPath`, driving the checkpoint query.
- Live progress = `completedTaskIds.length / totalTasks`; fallback
  `Object.keys(results).length` when `totalTasks === 0`. Animated width transition.
- Task grid: one `TaskChip` per result key; `inProgressTaskId` chip pulses;
  tooltip shows `durationMs` + `exitCode`.
- Empty state when `/api/checkpoint` → 404 (mapped to `null` by `apiFetch`
  `allowNotFound`) **and** `/loops` has no plan-backed child.

### 2.2 `hooks/usePlans.ts` (NEW) — Plans data contract

```ts
// hooks/usePlans.ts
import { useQuery } from '@tanstack/react-query';
import { fetchLoops, fetchCheckpoint } from '../lib/api';
import type { ChildLoopSummary, CheckpointState } from '../lib/types';

export interface PlanSummary {
  loop: ChildLoopSummary;
  checkpoint: CheckpointState | null;
  progress: number;          // 0..1
  completed: number;
  total: number;
  inProgressTaskId: string | null;
}

export interface UsePlansResult {
  loops: ChildLoopSummary[];                       // all child loops
  planLoops: ChildLoopSummary[];                  // loops with planPath
  selectedPlanPath: string | null;
  select(planPath: string | null): void;
  plans: PlanSummary[];                           // derived per-plan progress
  isLoading: boolean;
}

export function usePlans(selectedPlanPath?: string): UsePlansResult;
//   ['loops']            → refetchInterval 2000, staleTime 2000
//   ['checkpoint', p]    → refetchInterval 2000, enabled: !!p, allowNotFound
// derives `progress = completedTaskIds.length / (totalTasks || resultsKeys.length)`
```

> **Interface-design note:** `usePlans` owns *plan* data only. The durationP95 /
> passRate / error-rate **ring derivation** is deliberately split into the
> `useLiveMetrics` feeder (§2.3) so the Plans screen and Ops Health share one
> ring without coupling their query lifecycles. `usePlans` reads the ring via
> `useDerivedSeries` for any plan-level KPI sparkline, but never writes it.

### 2.3 Ring feeder + client-side series — `lib/series.ts` (NEW) + `hooks/useLiveMetrics.ts` (NEW)

The client owns a small time-series ring (server ring is untouched — hard
constraint). Mirror the server `TsRing` interface so chart components are
identical for server- and client-derived metrics (spec §7).

```ts
// lib/series.ts
export interface SeriesPoint { t: number; v: number; }

export interface SeriesRing {
  append(metric: string, p: SeriesPoint): void;
  read(metric: string, windowMs: number, now?: number): SeriesPoint[];
  latest(metric: string): SeriesPoint | null;
  clear(metric?: string): void;
}

export function createSeriesRing(capacity = 1800): SeriesRing;
// capacity 1800 = 1h @ 2s (largest window). Spec's "~300 (10m@2s)" is the
// minimum; we size for the 1h window so the 10m/1h toggle both work.
export const seriesRing: SeriesRing;   // module singleton
export const WINDOW_MS = { '10m': 600_000, '1h': 3_600_000 } as const;
```

```ts
// hooks/useLiveMetrics.ts  (mounted ONCE — in OpsHealthScreen, or App)
export function useLiveMetrics(): void;
//   ['metrics']     → refetchInterval 2000, queryFn: fetchMetrics('1h', 200)
//   ['history',1,100] → refetchInterval 2000, queryFn: fetchHistory(1,100)
//   on success: compute samples (§2.4) and seriesRing.append(...) them
```

#### 2.4 Derivation rules (no new data — existing fields only, spec §3.2)

At each 2s tick, push one sample per derived metric into `seriesRing`:

| metric | sample value | source |
|--------|--------------|--------|
| `durationP95` | `taskMetrics.p95DurationMs` (ms) | `/api/metrics` — now *live* (fixes G1) |
| `passRate` | `pass / (pass+fail+error)` (or `1` if denom `0`) | `/api/metrics` |
| `errorRate` | `error / (pass+fail+error)` (or `0`) | `/api/metrics` — **new (G3)** |
| `recovery` | count of `/api/history` entries in window with `status==='healed'` **or** `retryCount>0`; fallback `status==='recovered'`; else `0` (chart still renders) | `/api/history` — **new (G3)** |
| `triggerFire` | **delta** of `Σ triggers[].fireCount` vs previous poll (seed `0` on first poll) | `/api/metrics.triggers` — **new (G3)** |

`throughput` and `queueDepth` stay on the **server** `/api/metrics/timeseries`
endpoint (already live) — we do NOT re-derive them, avoiding dual-source drift.

### 2.5 `hooks/useDerivedSeries.ts` (NEW) — ring reader contract

```ts
// hooks/useDerivedSeries.ts
import { useEffect, useState } from 'react';
import { seriesRing, WINDOW_MS } from '../lib/series';

export type DerivedMetric =
  | 'durationP95' | 'passRate' | 'errorRate' | 'recovery' | 'triggerFire';

export interface UseDerivedSeriesResult {
  points: SeriesPoint[];          // for uPlot / sparkline
  latest: number | null;          // for the big number
  window: '10m' | '1h';
}

export function useDerivedSeries(
  metric: DerivedMetric,
  window: '10m' | '1h' = '1h',
): UseDerivedSeriesResult;
// re-renders on a 2s setInterval tick reading seriesRing.read(metric, WINDOW_MS[window])
// (or subscribes to the ring's emit — same cadence)
```

### 2.6 New metric cards — `components/ops/*` (NEW files)

Each is a thin view over `useDerivedSeries` + `useMetrics`, mounted by
`MetricCardGrid` (additive):

- `components/ops/ErrorRateCard.tsx` — `useDerivedSeries('errorRate')`, `ErrorRateCard` shows `%` + status tone (warn ≥ threshold).
- `components/ops/RecoveryCard.tsx` — `useDerivedSeries('recovery')`, labelled "recovery events" (auto-heal retries).
- `components/ops/TriggerFireCard.tsx` — `useDerivedSeries('triggerFire')`, labelled "trigger fires / tick".

`MetricCardGrid` becomes:
```
PassFailErrorDonut · DurationCard · ThroughputCard · QueueCard
· ErrorRateCard · RecoveryCard · TriggerFireCard
```
Existing four cards untouched; the three new ones are appended.

### 2.7 Design-system tokens — `styles/tokens.css` (NEW)

Single `:root` + `[data-theme='dark']` variable set; **all** components consume
variables, no hardcoded hex. Resolves inconsistent dark-mode (G4).

```css
:root, [data-theme='dark'] {
  --bg: #0d1117;  --panel: #161b22;  --panel-2: #1c2330;
  --border: #2a3340;  --text: #e6edf3;  --text-dim: #8b949e;
  --accent: #4c8dff;
  --ok: #2ea043;  --warn: #d29922;  --crit: #f85149;  --info: #58a6ff;
  --radius: 10px;  --gap: 12px;  --pad: 12px;
}
/* light theme = variable override only, no second stylesheet */
[data-theme='light'] { --bg:#fff; --panel:#f6f8fa; /* … */ }
```

Imported once in `main.tsx` (`import './styles/tokens.css';`) and in `index.css`
vars cascade. Default theme = dark (ops console); optional localStorage toggle.

### 2.8 `components/Gauge.tsx` (NEW) — radial arc

```ts
export interface GaugeProps {
  value: number;            // 0..max
  min?: number;             // default 0
  max?: number;             // default 100
  label: string;
  grade?: 'healthy' | 'degraded' | 'critical';  // color band
  size?: number;            // px, default 120
}
// SVG arc (hand-rolled path or Recharts RadialBar). Color by grade:
//   healthy ≥80 · degraded ≥50 · critical <50  (mirrors v1 HEALTH_WEIGHTS)
```
`HealthScoreCard` keeps its data hook (`useHealthScore`) and swaps its big number
for `<Gauge value={score} grade={grade} />`. `budget.remaining / cap` also gets a
gauge.

### 2.9 `components/Sparkline.tsx` (NEW) — inline trend

```ts
export interface SparklineProps {
  data: number[];           // recent values (from seriesRing)
  width?: number;           // default 120
  height?: number;          // default 28
  tone?: 'ok' | 'warn' | 'crit' | 'info';
}
// Lightweight hand-rolled SVG path (no axes) — avoids Recharts per-KPI cost (R1).
```
`MetricCard` gains optional `spark?: number[]` + `tone` props; KPI cards render a
sparkline from the corresponding derived series (e.g. p95 sparkline on
`DurationCard`, error-rate sparkline on `ErrorRateCard`).

### 2.10 Denser layout (Thrust 3, presentational only)

`OpsHealthScreen` moves from a stacked single column to a **CSS grid** with named
areas: health gauge (1×1), KPI card row (auto-flow), charts in a 2-col grid,
child-loops strip across the bottom. Panels use `--panel` + 1px `--border` +
`--radius`, tighter `--pad`. History table + diagnostic drawer inherit tokens for
free cohesion (unchanged otherwise).

### 2.11 App shell change — third tab

`TabNav.tsx`: `ScreenId = 'ops' | 'diag' | 'plans'`. `App.tsx` lazy-imports
`PlansScreen` and renders it for `'plans'`. No other screen is touched. Mount the
`useLiveMetrics()` feeder once (in `OpsHealthScreen`, or `App` above the switch so
both tabs share the ring).

---

## 3. Charts delivered (all live, 2s; 10m/1h only)

| # | chart | source | live? |
|---|-------|--------|-------|
| 1 | throughput | server `/api/metrics/timeseries` | yes (unchanged) |
| 2 | queueDepth | server `/api/metrics/timeseries` | yes (unchanged) |
| 3 | durationP95 | **client-derived** `seriesRing` | **yes (fixes G1)** |
| 4 | passRate | **client-derived** `seriesRing` | **yes (fixes G1)** |
| 5 | errorRate | **client-derived** `seriesRing` | **new (G3)** |
| 6 | recovery | **client-derived** from history | **new (G3)** |
| 7 | triggerFire | **client-derived** delta | **new (G3)** |

Window toggle: `useTimeSeries(metric, window)` already takes a `window` param and
now polls at 2000; `useDerivedSeries(metric, window)` reads `WINDOW_MS[window]`.
**`24h` is removed from the UI toggle** (backend still accepts it; we never request it).

---

## 4. Data-layer edits (dashboard-only)

1. **`hooks/useTimeSeries.ts`** — `refetchInterval: 5000` → `2000` (fixes cadence drift G2).
2. **`main.tsx`** — install rAF scheduler:
   ```ts
   import { notifyManager } from '@tanstack/react-query';
   if (typeof requestAnimationFrame !== 'undefined') {
     notifyManager.setScheduler(requestAnimationFrame);
   }
   ```
   Guard for jsdom (no rAF in tests) — fall back to `setTimeout` so Vitest runs.
3. **NEW `hooks/usePlans.ts`**, **NEW `hooks/useDerivedSeries.ts`**,
   **NEW `hooks/useLiveMetrics.ts`**, **NEW `lib/series.ts`** — as specified §2.
4. All new hooks go through `lib/api.ts` (the only seam) — no new fetch sites.

---

## 5. File layout additions (all under `dashboard/src/`)

```
dashboard/src/
  styles/tokens.css              # NEW dark-mode + status tokens
  lib/series.ts                  # NEW client-side SeriesRing + singleton
  hooks/usePlans.ts              # NEW plans data (loops 2s + checkpoint 2s + derive)
  hooks/useLiveMetrics.ts        # NEW 2s derivation poller → seriesRing
  hooks/useDerivedSeries.ts      # NEW ring reader (2s tick)
  screens/PlansScreen.tsx        # NEW lazy third tab
  components/plans/PlanCard.tsx        # NEW
  components/plans/PlanProgress.tsx    # NEW
  components/plans/TaskChip.tsx        # NEW
  components/ops/ErrorRateCard.tsx     # NEW metric card
  components/ops/RecoveryCard.tsx      # NEW metric card
  components/ops/TriggerFireCard.tsx   # NEW metric card
  components/Gauge.tsx            # NEW radial gauge
  components/Sparkline.tsx        # NEW inline sparkline
  App.tsx                        # EDIT: add 'plans' tab + mount useLiveMetrics
  main.tsx                       # EDIT: notifyManager.setScheduler(rAF) + tokens.css
  components/TabNav.tsx          # EDIT: ScreenId += 'plans'
  hooks/useTimeSeries.ts         # EDIT: refetchInterval 2000
  screens/OpsHealthScreen.tsx    # EDIT: mount feeder, add 3 derived cards
  components/ops/MetricCardGrid.tsx  # EDIT: append 3 cards
  components/ops/HealthScoreCard.tsx # EDIT: use Gauge + tokens
  components/ops/MetricCard.tsx      # EDIT: sparkline + tokens
```
No file under `agent-loop/src/` is created, edited, or deleted.

---

## 6. Build & test strategy

- **Build:** `bunx vite build` (or `npm run build`) in `dashboard/` — passes with
  no type errors. Recommended to add `tsc --noEmit` before `vite build`
  (`"build": "tsc --noEmit && vite build"`) for a real type gate.
- **Test runner:** Vitest (`vitest run`) — independent of repo `bun test`.
- **New tests (highest-leverage):**
  1. `lib/series.test.ts` — `append`/`read` windowing + capacity eviction (1800).
  2. `hooks/useLiveMetrics.test.ts` (mock `fetch`) — given `/api/metrics`
     (`p95DurationMs/passCount/failCount/errorCount`) + a `/api/history` page,
     assert ring receives `durationP95`, `passRate`, `errorRate`, and a
     `triggerFire` **delta**; assert `errorRate = error/(pass+fail+error)`.
  3. `screens/PlansScreen.test.tsx` — mock checkpoint + `/loops`; assert progress
     bar reflects `completedTaskIds.length/totalTasks` and updates on re-poll.
  4. `components/Gauge.test.tsx` / `components/Sparkline.test.tsx` — render with
     sample data, no crash.
- **Parent gate:** `bun test` in repo root stays **green** because `src/` is
  untouched (explicit acceptance criterion, spec §9–10).
- **Hard-constraint gate:** `git diff --stat src/` (repo root) is **empty**.

---

## 7. Acceptance criteria (this design)

- [ ] `vite build` passes, no type errors.
- [ ] `git diff --stat src/` (repo root) empty — no `daemon.ts` / `routes.ts` /
      `daemon-api.ts` / `dashboard-api.ts` changes.
- [ ] Plans screen renders live progress (checkpoint + loops) updating within 2s;
      no new WS event.
- [ ] All 4 promised series (throughput, queueDepth, durationP95, passRate) update
      live at 2s; `durationP95`/`passRate` no longer static (G1, G2 fixed).
- [ ] New live series present: error-rate, recovery, trigger-fire.
- [ ] Window toggle offers **10m / 1h only** (24h removed from UI).
- [ ] Design reads as polished dark-mode ops console: gauges on health + budget,
      sparkline KPI cards, denser CSS-grid layout, token-driven dark mode.
- [ ] `notifyManager.setScheduler(requestAnimationFrame)` installed in `main.tsx`.
- [ ] `useTimeSeries` cadence fixed to 2000ms.
- [ ] Parent `bun test` green; `vitest run` green for the 4 new test groups.

---

## 8. Open items carried forward

- If `HistoryListEntry` lacks `retryCount`/`healed` fields, `recovery` degrades to
  `0` (chart still renders). Confirm field presence during L2; do **not** add
  backend fields (hard constraint).
- `notifyManager` rAF scheduler needs a jsdom guard so Vitest doesn't break.
- WS `/state` + `/loops` cache keys keep v1 behaviour; Plans screen uses REST 2s
  polling as the authoritative fallback (spec §12).
