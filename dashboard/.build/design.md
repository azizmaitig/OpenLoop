# Technical Design — agent-loop Observability Dashboard

> Status: **L1 (report-only / design)**. No application code in this doc; this is
> the concrete module/interface plan that L2 implements.
> Inputs: `spec.md` (product), `research.md` (stack/risk). Vocabulary from the
> `codebase-design` skill (deep modules, seams, interfaces, adapters).
> Backend facts read from source, not guessed: `src/routes.ts`,
> `src/dashboard-api.ts`, `src/daemon.ts`, `src/daemon-api.ts`, `src/metrics.ts`,
> `src/checkpoint.ts`, `src/types.ts`.

---

## 0. Design invariants (binding)

1. **Additive-only backend.** The three new endpoints already exist as a single
   deep module `src/dashboard-api.ts` behind `handleDashboardApi()`, wired at the
   *tail* of `createFetchHandler` (`routes.ts:262`). It returns `null` for any
   non-owned path, so every existing handler is untouched. L2 must NOT edit any
   existing route body — only (if anything) confirm the seam.
2. **Read-only dashboard.** No control actions (start/stop/pause/enqueue) in v1
   (spec §6). Every query is a `GET`.
3. **WS is receive-only** (research R0/R5): frame `{ type, data, timestamp }`;
   types `state_change` (2s), `child_status_change` (on change, 1s poll),
   `task_completed` (terminal). No client→server messages.
4. **Timeseries arrives via REST**, not WS (research R0). `/api/metrics/timeseries`
   is polled every 2s; the daemon only appends to the server-side `TsRing`.
5. **Two seams the UI depends on**: `lib/api.ts` (REST fetch adapter) and
   `useLoopStream` (WS→cache bridge). Nothing else in the app opens a socket or
   calls `fetch` directly.

---

## 1. System context

```
 Browser SPA (dashboard/, Vite React-TS)
   │   built to ../src/dashboard/  (index.html + assets/)
   │
   ├── REST GET  /state /api/metrics /api/history /api/tasks/:id /loops
   │             /api/health-score /api/metrics/timeseries /api/checkpoint
   │             (TanStack Query, refetchInterval per cadence)
   │
   └── WS   /ws  (single socket, receive-only, RAF-batched → Query cache)
                 │
        ┌────────┴───────────────────────────────────────────┐
        │ Daemon (Bun.serve, src/daemon.ts)                   │
        │  createFetchHandler(api)  → routes.ts               │
        │    existing handlers … then handleDashboardApi()    │
        │  websocket { open/close/message } broadcast()       │
        │  tsRing (createTsRing 1800)  pushTsSample() @2s      │
        └─────────────────────────────────────────────────────┘
```

The SPA is served as a static asset at `GET /dashboard`; the daemon reads
`resolve(import.meta.dirname,'dashboard','index.html')` = `src/dashboard/index.html`
(`daemon.ts:201`). Hence the Vite `build.outDir` = `../src/dashboard` and
`base: './'` so asset URLs resolve under the `/dashboard` path (acceptance #2).

---

## 2. Frontend module breakdown

Each module below lists its **interface** (everything a caller must know) and its
**depth rationale** (behaviour hidden behind that interface). Components are kept
shallow-and-declarative; the *depth* lives in the two seams (`lib/api.ts`,
`useLoopStream`) so screens stay dumb and testable.

### 2.1 App shell — `src/App.tsx` + `src/main.tsx`

- **Interface**: `<App/>`; no props. `main.tsx` mounts it inside
  `<QueryClientProvider>` and calls `notifyManager.setScheduler(requestAnimationFrame)`
  **once** (research R2) before render.
- **Responsibility**: top-level layout + tab/route switch between two screens
  (`OpsHealthScreen`, `DiagnosticScreen`); mounts the single `useLoopStream()`
  bridge at the top so exactly one socket exists for the app lifetime; renders a
  global connection/status indicator (derived from the stream hook).
- **Depth**: hides QueryClient config (staleTime defaults, retry policy, RAF
  scheduler), the WS lifecycle, and lazy-loading of the diagnostic screen
  (`React.lazy` — research R8 code-split so the Ops landing paints first).
- **Deletion test**: removing it scatters QueryClient setup + socket ownership
  across every screen → it earns its keep.

### 2.2 OpsHealthScreen — `src/screens/OpsHealthScreen.tsx` (P0 landing)

- **Interface**: `<OpsHealthScreen/>`; no props (reads from Query hooks).
- **Composes**: `HealthScoreCard`, a `MetricCardGrid` of KPI cards, one+ uPlot
  `TimeSeriesChart`, and (P1) `ChildLoopsPanel`.
- **Data**: `useHealthScore()`, `useMetrics()`, `useTimeSeries('throughput')`
  (+ queueDepth/durationP95/passRate P1), `useLoops()`.
- **Depth**: layout + which metrics map to which cards; no fetching logic.

### 2.3 DiagnosticScreen — `src/screens/DiagnosticScreen.tsx` (lazy)

- **Interface**: `<DiagnosticScreen/>`; internal selection state
  (`selectedTaskId`).
- **Composes**: `HistoryTable` (virtualized), `TaskDetailDrawer`, `StateView`,
  `CheckpointBar`, `TriggerView` (P1).
- **Data**: `useHistory(page)`, `useTask(selectedTaskId)`, `useDaemonState()`,
  `useCheckpoint()`.
- **Depth**: master/detail wiring (row click → drawer); pagination state.

### 2.4 Metric cards — `src/components/HealthScoreCard.tsx`, `MetricCard.tsx`, `MetricCardGrid.tsx`

- **Interface**:
  - `<HealthScoreCard score={HealthScore}/>` — renders 0–100 + grade
    (`healthy`/`degraded`/`critical`) with grade→color mapping.
  - `<MetricCard label value unit? tone? trend?/>` — one KPI tile.
  - `<MetricCardGrid metrics={TaskMetricsResult} budget triggers/>` — maps the
    `/api/metrics` payload to the P0 KPI set: `totalRuns`, `passCount`,
    `failCount`, `errorCount`, `avg/p50/p95DurationMs`,
    `throughputTasksPerMin`, budget `status/remaining/cap`, trigger fire counts.
- **Depth**: shallow by design (pure presentational); `React.memo` with stable
  prop identity from Query cache so WS repaints don't re-render them (research R3).
- **Charts note**: KPI/card mini-charts (P1) use **Recharts** (low point count,
  declarative — research R1/R8). Never feed >~5k points to Recharts.

### 2.5 uPlot charts — `src/components/TimeSeriesChart.tsx` + `src/hooks/useUplot.ts`

- **Interface**:
  - `useUplot(opts): { containerRef, setData(points) }` — a thin `useUPlot`
    wrapper (research R1 fallback made primary): creates the uPlot instance once,
    owns a `ResizeObserver`, exposes imperative `setData` for incremental updates.
  - `<TimeSeriesChart metric title data={TimeSeriesPoint[]}/>` — declarative shell
    that pushes `data` into `useUplot().setData` on change.
- **Depth**: hides all imperative uPlot lifecycle (create/destroy/resize/setData),
  canvas config, and the `{t,v}[] → [x[],y[]]` column transform uPlot expects.
  This is the deepest UI module — a lot of canvas behaviour behind `setData`.
- **Update path**: fed by `useTimeSeries()` polling (2s) → `setData` inside the
  RAF flush; **never** re-mounts the chart (research R1/R3).

### 2.6 Virtualized table — `src/components/HistoryTable.tsx` + `src/hooks/useVirtualRows.ts`

- **Interface**:
  - `<HistoryTable page pageSize onRowClick(id) onPageChange(n)/>`.
  - `useVirtualRows(rows, {rowHeight, overscan})` wraps `useVirtualizer`.
- **Behaviour**: fixed-height rows (`estimateSize` constant — no `measureElement`,
  research R4), `overscan ~10`, fixed-height scroll container, rows positioned by
  `transform: translateY`, inner height = `getTotalSize()`. Columns: `id`,
  `command`, `status`, `createdAt`, `completedAt`, `durationMs`, `exitCode`
  (from `HistoryListEntry`, `types.ts:148`).
- **Depth**: hides the virtualizer wiring + pagination interplay. Server-side
  pagination (`?page&pageSize`) is the source of truth; virtualization only
  handles the loaded page. Escalation path (research R4): swap `useHistory` for
  `useInfiniteQuery` if histories grow to millions — interface unchanged.
- **Isolation**: the virtualizer lives in the lowest body component so WS/Query
  updates don't remount it (research R3/R4).

### 2.7 Task detail drawer — `src/components/TaskDetailDrawer.tsx`

- **Interface**: `<TaskDetailDrawer taskId={string|null} onClose()/>`.
- **Data**: `useTask(taskId)` → `HistoryEntry` (`types.ts:143`). Renders `task`
  meta + `phases[]` (`name/command/startedAt/completedAt/exitCode/stdout/stderr/
  durationMs`). Judgment/plugin/evidence rendered when present.
- **Depth**: closed when `taskId===null` (query disabled via `enabled`).

### 2.8 WS event feed — `src/components/EventFeed.tsx`

- **Interface**: `<EventFeed/>`; reads a bounded ring of recent WS events exposed
  by `useLoopStream` (see §3.3).
- **Behaviour**: shows the last N (~200) `{type,data,timestamp}` frames, newest
  first; `React.memo` + capped list so a reconnect burst can't thrash layout
  (RAF-batched upstream — acceptance #4).

### 2.9 Checkpoint bar — `src/components/CheckpointBar.tsx`

- **Interface**: `<CheckpointBar/>`; `useCheckpoint()` → `CheckpointState | null`.
- **Behaviour**: renders `planName`, progress = `completedTaskIds.length /
  totalKnown`, highlights `inProgressTaskId`, per-task `results[id]`
  (`status/durationMs/exitCode` — `types.ts:100`). 404 → "no active checkpoint".

### 2.10 StateView / ChildLoopsPanel / TriggerView (P1 except StateView)

- `<StateView/>` — `useDaemonState()` → `status`, `uptime`, `queueLength`,
  `currentTask`, child summary.
- `<ChildLoopsPanel/>` — `useLoops()` → `ChildLoopSummary[]` (`types.ts:195`).
- `<TriggerView/>` — reads `triggers` from `useMetrics()` (`TriggerSummary[]`).

---

## 3. Data layer

Two deep seams. Every component reaches the daemon through exactly these; no
component calls `fetch` or opens a socket itself.

### 3.1 REST adapter — `src/lib/api.ts`

- **Interface** (the whole REST surface as typed functions):
  - `getState(): Promise<DaemonState>`
  - `getMetrics(window?,lastN?): Promise<MetricsResponse>`
  - `getHistory(page,pageSize): Promise<HistoryListResponse>`
  - `getTask(id): Promise<HistoryEntry>`
  - `getLoops(): Promise<ChildLoopSummary[]>`
  - `getHealthScore(window?,lastN?): Promise<HealthScore>`
  - `getTimeSeries(metric,window?): Promise<TimeSeriesResponse>`
  - `getCheckpoint(planPath?): Promise<CheckpointState | null>` (404 → `null`)
  - `wsUrl(): string` — `(location.protocol==='https:'?'wss':'ws')+'//'+location.host+'/ws'`
- **Depth (hidden behind these)**: base-URL resolution, JSON parse, error→throw
  normalization, and the **auth header**: attach `Authorization: Bearer <key>`
  when `import.meta.env.VITE_LOOP_API_KEY` is set (research R5; WS upgrade needs
  no header). 404 mapping for checkpoint. This is the one place that knows the
  wire format.
- **Types**: mirror the server types (`HealthScore`, `TimeSeriesResponse`,
  `TimeSeriesPoint` from `dashboard-api.ts`; `TaskMetricsResult`,
  `BudgetMetricsResult`, `TriggerSummary` from `metrics.ts`; `HistoryListResponse`,
  `HistoryEntry`, `ChildLoopSummary`, `CheckpointState`, `DaemonStatus` from
  `types.ts`). Declared in `src/lib/types.ts` as a hand-mirrored contract (the SPA
  is a separate Vite package; it does not import from `../src`).

### 3.2 Query hooks — `src/hooks/queries.ts` (one `useQuery` per endpoint)

| Hook | queryKey | queryFn | refetchInterval | staleTime |
|------|----------|---------|-----------------|-----------|
| `useDaemonState` | `['/state']` | `getState` | 2s (or WS-owned) | `Infinity` (WS writes) |
| `useMetrics` | `['/api/metrics',w,n]` | `getMetrics` | 5s | 4s |
| `useHistory` | `['/api/history',page]` | `getHistory` | 5s | 4s (+`placeholderData:keepPrevious`) |
| `useTask` | `['/api/tasks',id]` | `getTask` | off | 30s (`enabled: !!id`) |
| `useLoops` | `['/loops']` | `getLoops` | 5s (or WS-owned) | `Infinity` (WS writes) |
| `useHealthScore` | `['/api/health-score',w,n]` | `getHealthScore` | 5s | 4s |
| `useTimeSeries` | `['/api/metrics/timeseries',metric,w]` | `getTimeSeries` | 2s | 2s |
| `useCheckpoint` | `['/api/checkpoint',planPath]` | `getCheckpoint` | 5s | 4s |

- Cadences mirror daemon broadcast timing (spec §3.4). WS-owned keys (`/state`,
  `/loops`) use `staleTime: Infinity` so polling + WS don't double-fight
  (research R2/R6 fallback: drop their `refetchInterval` if contention appears).

### 3.3 WS bridge + RAF flush — `src/hooks/useLoopStream.ts` (deepest data module)

- **Interface**: `useLoopStream(): { status: 'connecting'|'open'|'closed', events: WsEvent[] }`.
  Called **once** in `App.tsx`. All cache mutation is a side effect; the return is
  only for the status indicator and `EventFeed`.
- **Behaviour (hidden depth)** — the core anti-thrash mechanism (research R3):
  1. Open one `WebSocket(api.wsUrl())` on mount; reconnect with exponential
     backoff (1s→8s cap) on `onclose`. On reopen the daemon auto-sends a fresh
     `state_change` snapshot (`daemon.ts:214`).
  2. `onmessage` **never** touches React state directly — it pushes the parsed
     frame into a `pendingRef` array (mutable ref, outside React) and schedules a
     single `requestAnimationFrame` if none pending.
  3. **RAF flush**: dedupe `state_change` (keep newest only), then apply:
     - `state_change` → `queryClient.setQueryData(['/state'], data)` (data also
       carries `children` — mirror into `['/loops']` when present).
     - `child_status_change` → `setQueryData(['/loops'], data)`.
     - `task_completed` → `invalidateQueries(['/api/history'])` (+ optional
       optimistic prepend). Cheap; history is paginated.
     - unknown `type` → ignored (future-proof).
     Append every frame to a bounded `events` ring (~200) for `EventFeed`, then
     clear `pendingRef`.
  4. **Backpressure**: cap `pendingRef` (~1000) and drop stale `state_change`
     on overflow (only the last matters) to survive reconnect bursts.
  5. **Visibility**: cancel RAF on `document.hidden`; flush on `visibilitychange`
     to avoid backlog (research R3).
- **Why deep**: an enormous amount of correctness (batching, dedupe, reconnect,
  backpressure, cache routing) sits behind a 2-field return. Deletion test:
  removing it means every component wires its own socket + render storm.
- **Fallback (research R2/R3)**: if RAF proves flaky in tests, drive the flush
  from a 200–250ms `setInterval` coalescer — same ref-buffer design, interface
  unchanged. Lower bound: rely on React 19 auto-batching + `notifyManager` RAF
  scheduler. If WS is blocked entirely, the app degrades to pure REST polling
  (every WS payload has a REST source) — still fully functional read-only.

---

## 4. File layout (SPA lives in `dashboard/`)

```
dashboard/
  index.html                 # Vite entry; <div id="root"> + module script
  vite.config.ts             # plugin-react; base './'; build.outDir '../src/dashboard'; test (vitest)
  package.json               # dev/build/preview/typecheck/test scripts
  tsconfig.json              # strict; moduleResolution Bundler; jsx react-jsx; types ["vite/client","vitest/globals"]
  .env.example               # VITE_LOOP_API_KEY, VITE_API_BASE (dev proxy)
  src/
    main.tsx                 # mount + QueryClientProvider + notifyManager RAF scheduler
    App.tsx                  # shell, screen switch, mounts useLoopStream once
    lib/
      api.ts                 # REST adapter seam (§3.1)
      types.ts               # hand-mirrored server contracts
      queryClient.ts         # QueryClient factory (defaults, RAF scheduler)
    hooks/
      queries.ts             # per-endpoint useQuery hooks (§3.2)
      useLoopStream.ts       # WS→cache RAF bridge (§3.3)
      useUplot.ts            # imperative uPlot wrapper (§2.5)
      useVirtualRows.ts      # useVirtualizer wrapper (§2.6)
    screens/
      OpsHealthScreen.tsx
      DiagnosticScreen.tsx   # React.lazy
    components/
      HealthScoreCard.tsx  MetricCard.tsx  MetricCardGrid.tsx
      TimeSeriesChart.tsx  HistoryTable.tsx  TaskDetailDrawer.tsx
      EventFeed.tsx  CheckpointBar.tsx  StateView.tsx
      ChildLoopsPanel.tsx  TriggerView.tsx
    __tests__/
      useLoopStream.test.ts  # RAF flush + dedupe + reconnect (highest-leverage)
      api.test.ts            # fetch shaping + auth header + 404→null
      HistoryTable.test.tsx  # virtual rows render window
```

Built assets land in `../src/dashboard/{index.html,assets/*}` — exactly what the
daemon serves (`daemon.ts:201`); `src/dashboard/index.html` already exists as the
placeholder to be overwritten by `vite build`.

### 4.1 `vite.config.ts` key settings

- `plugins: [react()]`
- `base: './'` (relative asset URLs → resolve under `/dashboard`, acceptance #2;
  fallback research R7 if sub-path fragile).
- `build: { outDir: '../src/dashboard', emptyOutDir: true }`
- `server.proxy`: `'/api' → http://localhost:3000`, `'/state'`, `'/loops'`,
  `'/ws' (ws:true)` so `vite dev` hits a running daemon without CORS (research R7).
- `test: { environment: 'jsdom', globals: true, setupFiles: [...] }` (Vitest).

---

## 5. Backend endpoints (additive module — already scaffolded, documented here)

These three endpoints are **already implemented** as the deep module
`src/dashboard-api.ts` and wired at `routes.ts:262`. This design documents their
contract and confirms they satisfy invariant §0.1 — L2 does not rewrite them.

### 5.1 Module seam — `handleDashboardApi(api, url, req, ring): Promise<Response|null>`

- **Interface**: given the `DaemonAPI` seam (`daemon-api.ts`), the request `URL`,
  the `Request`, and the shared `TsRing`, returns a `Response` for the three
  owned `GET` paths, else `null`. `null` = "not mine" → the caller falls through
  to `return new Response('Not found', 404)`. Non-GET → `null`.
- **Depth**: composes existing *pure* functions (`computeTaskMetrics`,
  `computeBudgetMetrics`, `loadCheckpoint`) + the ring; adds no new side effects
  to the loop. It reads daemon state only through `DaemonAPI` (`getState`,
  `listTaskHistory`, `baseDir`) — never Daemon internals.

### 5.2 `GET /api/health-score?window&lastN → HealthScore`

- Source: `computeHealthScore()` (`dashboard-api.ts:58`) computes `passRate`,
  `errorRate`, `budget` from `computeTaskMetrics`+`computeBudgetMetrics`; the
  dispatcher then injects a **live** `queueDepth = 1 - min(queueLength/20, 1)`
  from `api.getState()` and calls `finalizeHealthScore()` (`:80`).
- Weights: `HEALTH_WEIGHTS` (equal 0.25 each, exposed for tuning — spec §8).
  `score` 0–100; `grade` = `≥80 healthy / ≥50 degraded / else critical`.
- Contract: `{ score, grade, components:{passRate,errorRate,budget,queueDepth},
  derivedFrom:{window,lastN} }`.

### 5.3 `GET /api/metrics/timeseries?metric&window → TimeSeriesResponse`

- Source: `ring.read(metric, window)` (`TsRing`, cap 1800 ≈ 30min @1/2s). If the
  ring has points, return them (live path). **Cold start**: if empty, re-bucket
  task history via `bucketHistory()` (`dashboard-api.ts:180`) into 60 buckets over
  the window for `throughput`/`durationP95`/`passRate`.
- The ring is fed server-side by `daemon.pushTsSample()` (`daemon.ts:304`) every
  2s (`throughput`, `queueDepth`) — **not** broadcast over WS (research R0). So
  the client's live chart = 2s REST poll of this endpoint.
- Contract: `{ metric, points: {t:number, v:number}[] }`.

### 5.4 `GET /api/checkpoint?planPath → CheckpointState | 404`

- Source: `loadCheckpointState()` (`dashboard-api.ts:143`). With `planPath`,
  loads `checkpoint-<planName>.json` via `loadCheckpoint`. Without it, scans
  `_agent-loop-output/checkpoint-*.json` and returns the most recently
  `updatedAt` one (`findActiveCheckpoint`). Missing → `{error}` + `404`.
- Contract: `CheckpointState` (`types.ts:90`) or 404 (client maps to `null`).

### 5.5 Wiring in `routes.ts` (no existing handler edited)

- `import { handleDashboardApi } from './dashboard-api.js'` (`routes.ts:12`).
- **Tail delegation** (`routes.ts:262`), after all existing routes and before the
  404:
  ```
  const dash = await handleDashboardApi(api, url, req, api.tsRing);
  if (dash) return dash;
  return new Response('Not found', { status: 404 });
  ```
- The ring is constructed once on the Daemon (`tsRing = createTsRing(1800)`,
  `daemon.ts:38`) and exposed on the `DaemonAPI` seam (`daemon-api.ts:41`), so
  routes reach it without importing Daemon internals.
- **Auth**: these are read-only `GET`s; the daemon's `isAuthorized` gate applies
  to mutating routes only. If `LOOP_API_KEY` is set, the SPA sends the bearer
  header on all `fetch` (§3.1); WS upgrade is unauthenticated by the daemon.

### 5.6 Why this is a clean seam (deletion test)

Delete `dashboard-api.ts` + the two-line tail wire → all existing routes still
compile and behave identically; only the three dashboard endpoints vanish. One
adapter, one seam, zero coupling into existing handlers. Satisfies invariant §0.1.

---

## 6. Build & test strategy

### 6.1 Build

- `package.json` scripts (research R7):
  - `dev` → `vite`
  - `build` → `tsc --noEmit && vite build` (Vite transforms, `tsc` type-checks —
    acceptance #1: build passes with **no type errors**).
  - `preview` → `vite preview`
  - `typecheck` → `tsc --noEmit`
  - `test` → `vitest run`
- Output to `../src/dashboard` (so `daemon.ts` serves it). `emptyOutDir: true`.
- Pin (research R8): React 19, Vite 6 + `@vitejs/plugin-react`, TanStack Query v5,
  TanStack Virtual latest, uPlot ^1.6, Recharts ^2 (P1). `bun audit` post-install.
  Avoid TanStack React Charts.

### 6.2 Test

- **Runner**: Vitest (jsdom) inside `dashboard/` — the daemon suite stays on
  `bun test` and is untouched (acceptance #5). The two runners are independent.
- **Highest-leverage tests** (research R3, synthesis §9) — test through the seam
  interfaces, not internals:
  1. `useLoopStream` — feed synthetic frames; assert (a) many `state_change` in
     one frame → exactly one `setQueryData(['/state'])` with the newest; (b)
     `child_status_change` → `['/loops']`; (c) `task_completed` → invalidate
     history; (d) reconnect backoff on close; (e) `events` ring capped.
     Use fake timers / `requestAnimationFrame` mock (or the setInterval fallback).
  2. `lib/api.ts` — mock `fetch`; assert URL/query shaping, `Bearer` header when
     `VITE_LOOP_API_KEY` set, checkpoint 404 → `null`, JSON error → throw.
  3. `HistoryTable` / `useVirtualRows` — fixed container height, only the window
     of rows rendered, `onRowClick` fires the id.
- **Manual acceptance** (spec §7) after `vite build`: run the daemon, open
  `/dashboard`, verify no 404 on JS/CSS, P0 metrics paint without console errors,
  WS feed live without layout thrash.
- **Backend**: no new backend tests required from this design (endpoints already
  covered by the existing suite); `bun test` must remain green (acceptance #5).

---

## 7. Open items / decisions carried to L2

1. **Spec §3.3 vs source** (research §9): timeseries is NOT on WS. Decision:
   **(a) keep timeseries on 2s REST polling** (recommended, no source change). Do
   NOT add a `metrics_sample` WS broadcast in v1 (would touch daemon source →
   L2 + worktree per AGENTS.md).
2. **`base` pathing**: ship `base: './'`; if assets 404 under `/dashboard`, fall
   back to `base:'/dashboard/'` or daemon rewrite (research R7).
3. **History scale**: start with paginated `useHistory`; escalate to
   `useInfiniteQuery` only if row counts demand it (interface unchanged).
4. **Health weights** remain equal (`HEALTH_WEIGHTS`) until tuning data exists.
