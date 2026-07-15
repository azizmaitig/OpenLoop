# Product Spec — agent-loop Dashboard v1.1 Upscale

> Status: design-up / additive. This is an **upscale** of the shipped v1 dashboard
> (`dashboard/`) adding a Plans/Runs screen, fixing known live-metrics gaps, and
> a design-cohesion pass. It is **100% additive inside the `dashboard/` Vite
> package** — `src/` is read-only for this work.

---

## 0. Hard Constraints (binding — non-negotiable)

1. **NO edits to `src/`.** Do not touch `daemon.ts`, `routes.ts`, `daemon-api.ts`,
   or `dashboard-api.ts`. The backend is frozen at v1. The additive seam
   (`handleDashboardApi`, tail-delegated at `routes.ts:278`) stays exactly as-is.
2. **Everything is additive inside `dashboard/`.** New screens, components, hooks,
   a client-side ring, and styling. No new backend endpoints are added — the four
   required live series are derived **client-side** from endpoints that already
   exist.
3. **Plans screen stays live via existing endpoints only.** It polls
   `GET /api/checkpoint` + `GET /loops` at **2s** (TanStack Query
   `refetchInterval`). No new WS event is introduced. The daemon already
   broadcasts `state_change`/`child_status_change` over the existing `WS /ws`; the
   Plans screen may consume that for instant child-status updates but must not
   require any new server event to function.
4. **Live `durationP95` / `passRate` / `errorRate` series are DERIVED CLIENT-SIDE.**
   The v1 server ring (`dashboard-api.ts:112`) is only ever fed `throughput` and
   `queueDepth` (`daemon.ts` `pushTsSample`), so `ring.read('durationP95'|'passRate')`
   is empty after cold start and the server path returns a **static** history
   snapshot (this is the exact P1-1 gap flagged in `design-critique.md`). The fix
   is **client-side**: poll the existing `GET /api/metrics` (returns
   `p95DurationMs`, `passCount`, `failCount`, `errorCount`) and `GET /api/history`
   at **2s**, push each sample into a **new client-side ring**
   (`src/lib/clientRing.ts`), and render. Do NOT add backend endpoints.
5. **Time-series windows are scoped to `10m` / `1h` only.** No `24h` or longer
   persistence (out of scope §7). The client ring and any bucketing are bounded.
6. **Acceptance (this spec is done when):** `vite build` passes with no type
   errors; the parent repo `bun test` stays green (untouched `src/`); the Plans
   screen renders live plan progress; all **four** promised time-series charts
   (throughput, queue depth, durationP95, passRate) now update live; the design
   reads as a polished ops console.

---

## 1. Goal

Three thrusts over v1:

1. **Plans/Runs screen** — watch a plan execute live: checkpoint progress
   (completed / in-progress / pending tasks), per-task results, and the live set
   of child loops driving the plan. The v1 Diagnostic screen only exposed
   checkpoint as a small bar; the new screen makes plan execution a first-class,
   continuously-refreshing view.
2. **More live metrics, closing the v1 gaps** — v1's `durationP95`/`passRate`
   charts were *not* live (static history backfill, P1-1). Add a true **live
   error-rate** series and make **all four** time-series charts update every 2s.
   Improve cadence consistency (research/design deviations P2-1, P2-2, P2-3 from
   `review.md`: fix poll cadences to 2s, install the `notifyManager` RAF
   scheduler, set WS-owned keys `staleTime: Infinity`).
3. **Design upscale pass** — gauges, sparkline KPI cards, a denser ops-console
   layout, and dark-mode cohesion so the dashboard reads as a single polished
   product rather than glued-together panels.

---

## 2. Users (unchanged from v1)

- **Loop operator** — at-a-glance health + live plan progress without SSH.
- **Developer** — root-cause a looping/failing run via per-task detail,
  checkpoint progress, and the live event stream.

Both run locally (localhost:3000) or a trusted host; no auth (§7 out of scope).

---

## 3. Core Features (additive)

### 3.1 Plans/Runs screen (NEW) — `src/screens/PlansScreen.tsx`

A first-class screen (third tab, lazy-loaded) showing plan execution live.

- **Plan selector** — if `GET /api/checkpoint` returns a checkpoint (active plan),
  render it; allow `?plan=` / `?planPath=` to target a specific plan. Fallback
  message "no active checkpoint" when `404` (mirrored to `null` by `api.ts`).
- **Checkpoint progress board** — `CheckpointState` (`types.ts:90`):
  `planName`, `completedTaskIds`, `inProgressTaskId`, `totalKnown`, `results[id]
  {status, durationMs, exitCode}`. Render as a left-to-right pipeline / kanban of
  `pending → in-progress → done` task chips, `inProgressTaskId` highlighted.
- **Live progress gauge** — completion % = `completedTaskIds.length / totalKnown`
  (or `Object.keys(results).length`) rendered as a radial **gauge** (design §5.3).
- **Per-task result rows** — status color, duration, exit code; clicking opens the
  existing `TaskDetailDrawer` (`GET /api/tasks/:id`).
- **Child loops strip** — `GET /loops` (`ChildLoopSummary[]`) for the plan's
  driving loops: name, status, trigger, last fire. Fed by 2s polling +
  `child_status_change` WS mirror (existing event, no new server event).
- **Triggers fire visibility** — `GET /api/metrics` → `triggers` array
  (`TriggerSummary[]`) shows fire counts and last-fire; render a compact
  "trigger fires" sparkline/card so recurring-trigger activity (CronTrigger /
  FileWatchTrigger) is visible. This addresses the v1 gap of missing
  trigger-fire visibility.
- **Recovery visibility** — derive from `GET /api/history` + `GET /api/metrics`:
  tasks with `status` in a retry/heal state or `failCount`/`errorCount` trends
  imply recovery activity. Show a "retries / recovers" mini-card (count of
  `heal`/`retry` outcomes this window) and an **error-rate sparkline** (see §3.2).

Data hooks: `useCheckpoint(planPath)` (2s), `useLoops()` (2s / WS-owned),
`useMetrics()` (2s → feeds client ring, see §3.2), `useHistory()` (2s, bounded
page). No new endpoints.

### 3.2 Live metrics fixes + new series

- **Client-side ring** — `src/lib/clientRing.ts`: a small append/filter ring
  (cap ~1800 ≈ 30 min @2s, but **windows exposed only `10m`/`1h`**). One ring
  instance per metric; `append(sample)` + `read(window)`.
- **Derived sampler** — `src/hooks/useDerivedSeries.ts` (new): on each 2s poll of
  `useMetrics()` and `useHistory()`:
  - `durationP95` ← `metrics.taskMetrics.p95DurationMs`
  - `passRate` ← `passCount / (passCount + failCount + errorCount)`
  - `errorRate` ← `errorCount / (passCount + failCount + errorCount)`
  - `throughput`, `queueDepth` ← already live from `GET /api/metrics/timeseries`
    (server ring); keep polling that at 2s as v1 does.
  Each derived value is appended to the client ring with `t = Date.now()`. Result:
  all four charts now move every 2s. **No `src/` change** — the gap is closed
  entirely on the client.
- **Cadence & batching fixes (carry review.md P2-1/P2-2/P2-3):**
  - `useTimeSeries` `refetchInterval` = **2000** (was 5000) — matches spec "live
    chart = 2s REST poll".
  - Install `notifyManager.setScheduler(requestAnimationFrame)` once in
    `main.tsx` (was missing, P2-3).
  - `/state` and `/loops` hooks use `staleTime: Infinity` (WS writes cache, P2-2).
  - `useMetrics` / `useHealthScore` / `useCheckpoint` get explicit
    `refetchInterval` (5s/5s/2s) per design §3.2.
- **New chart: error-rate.** Add a fourth uPlot series for `errorRate` (client-
  derived) alongside throughput / queueDepth / durationP95 / passRate. The Ops
  Health screen shows all four live (throughput + queueDepth from server ring;
  durationP95 + passRate + errorRate from client ring).

### 3.3 Design upscale pass

- **Gauges** — replace plain big-numbers for Health score and Plan progress with
  radial gauge components (Recharts `RadialBar` or lightweight SVG arc, no new
  lib).
- **Sparkline KPI cards** — `MetricCard` gains an optional inline sparkline
  (Recharts `<Area/>` mini, ≤60 points) fed from the client ring for that metric,
  so KPI tiles show trend at a glance (throughput, p95, error rate, pass rate).
- **Denser layout** — move from spaced stacked panels to a CSS-grid ops console:
  a fixed top status bar + a responsive 12-col grid; cards use consistent padding,
  tabular numerics (`font-variant-numeric: tabular-nums`), and a shared
  `tokens.css` design-token file (colors, spacing, radii) so dark mode reads
  cohesive.
- **Dark-mode cohesion** — single palette via CSS variables; uPlot + Recharts
  themes read the same tokens; charts get a unified grid/axis color. No light
  mode required (daemon is an operator tool; ship dark only).
- **Connection/health indicator** — top bar shows WS status (from `useLoopStream`)
  + last-poll timestamp, so the operator sees liveness at a glance.

### 3.4 Existing screens unchanged in scope

OpsHealthScreen and DiagnosticScreen keep their v1 responsibilities; they are
*upgraded* (design pass + live fixes) but not re-architected.

---

## 4. Tech Stack (unchanged + additive)

| Concern | Choice | Why |
| --- | --- | --- |
| Build/dev | Vite + React + TS | unchanged |
| Time-series | uPlot | unchanged; now fed by client ring too |
| Card/spark/gauge | Recharts | unchanged; sparkline + radial gauges |
| Server state | TanStack Query v5 | unchanged; RAF scheduler installed |
| Virtual tables | TanStack Virtual | unchanged |
| Realtime | existing `WS /ws` | **no new event**; reused for Plans + indicators |

New internal modules (all in `dashboard/src`): `lib/clientRing.ts`,
`hooks/useDerivedSeries.ts`, `components/Gauge.tsx`, `components/Sparkline.tsx`,
`components/PlansScreen.tsx`, `styles/tokens.css`. No `src/` change.

---

## 5. Data Sources (v1 endpoints only — none added)

| Endpoint | Used for (v1.1) |
| --- | --- |
| `GET /api/checkpoint?plan\|planPath` | Plans screen live progress; gauges |
| `GET /loops` | Plans child-loop strip; Ops child panel |
| `GET /api/metrics` | KPI cards; **derived durationP95/passRate/errorRate series**; triggers; recovery counts |
| `GET /api/history` | recovery/retry counts; derived series backfill |
| `GET /api/metrics/timeseries?metric=throughput\|queueDepth` | live throughput + queueDepth (server ring, 2s) |
| `GET /api/health-score` | Health gauge |
| `GET /state` | status bar / queue length |
| `WS /ws` | `state_change` / `child_status_change` / `task_completed` (existing events only) |

**Window scopes:** client ring + charts expose `10m` and `1h` only. `24h` is not
supported (out of scope §7).

---

## 6. Architecture Notes

- Single SPA, served by daemon at `GET /dashboard`; `build.outDir = ../src/dashboard`,
  `base: './'` (unchanged from v1 design §4.1).
- Two data seams unchanged: `lib/api.ts` (REST) and `useLoopStream` (WS→cache RAF).
  The client ring + derived sampler are a **third, purely client-side seam**
  (`lib/clientRing.ts` + `useDerivedSeries`) that sits *on top of* `useMetrics`/
  `useHistory` — it never calls `fetch` itself.
- uPlot charts read from either the server `useTimeSeries` hook (throughput,
  queueDepth) or the new client-ring hook (`useDerivedSeries` → durationP95,
  passRate, errorRate). Same `setData` update path (no re-mount, R1/R3).
- All new code is additive under `dashboard/`; deleting it leaves v1 byte-identical
  in behavior. `src/` is never imported or modified.

---

## 7. Out of Scope (explicit)

- **Auth / auth changes** — localhost-only, inherits `LOOP_API_KEY` as v1. No
  login, no user accounts, no new gating.
- **Cost / token tracking** — budget endpoint stays run-cap/remaining only.
- **Control plane** — no start/stop/pause/enqueue from the UI (v1 stance kept).
- **24h+ historical persistence** — time-series windows limited to `10m`/`1h`;
  no long-term store, no DB.
- **New backend endpoints or WS events** — strictly forbidden by §0.
- **Editing `src/`** — strictly forbidden by §0.

---

## 8. Acceptance Criteria

- [ ] `bunx vite build` (tsc --noEmit && vite build) **passes** with no type errors.
- [ ] Parent repo `bun test` stays **green** — `src/` untouched, additive seam
      intact.
- [ ] **Plans/Runs screen** renders live plan progress: poll `GET /api/checkpoint`
      + `GET /loops` at 2s; shows completed/in-progress/pending tasks, per-task
      results, child loops, and trigger-fire visibility. Updates without a new WS
      event.
- [ ] **All four** time-series charts update live every 2s: throughput, queue
      depth (server ring), **durationP95, passRate, errorRate (client-derived
      ring)**. The v1 static-snapshot gap (P1-1) is closed client-side.
- [ ] Design reads as a polished ops console: gauges (health, plan progress),
      sparkline KPI cards, denser dark-mode-cohesive grid layout, connection/
      health top bar.
- [ ] Cadence/batch fixes applied: `useTimeSeries` 2s; `notifyManager` RAF
      scheduler installed; WS-owned keys `staleTime: Infinity`; `useCheckpoint`
      polls at 2s.
- [ ] No new backend endpoint or WS event added; no `src/` file edited (verified
      by `git status` showing only `dashboard/` changes).

---

## 9. Risks / Notes

- **Drift:** `lib/types.ts` hand-mirrors server contracts (P2-6). The new client
  ring uses only field names already present in v1 (`p95DurationMs`, `passCount`,
  `failCount`, `errorCount`, checkpoint shape) — no new server fields consumed.
- **Client-ring memory:** cap 1800 samples/metric × ~5 metrics is trivial; bounded
  to `10m`/`1h` windows on read.
- **One reader of `/api/metrics` per 2s** feeds the derived sampler; the existing
  KPI cards reuse the same Query cache (no duplicate fetch).
