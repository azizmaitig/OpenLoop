# Upscale Research — agent-loop Dashboard v1.1

> Companion to `.build/upscale-spec.md`. Research into the stack and the five
> top implementation risks (R1–R5), using current (2025–2026) docs. Per risk:
> **evidence + source**, **recommended approach**, **fallback**. No code is
> written here — this is input to implementation.

---

## 0. Stack & version compatibility (top risk: dependency rot)

The additive work reuses the existing `dashboard/` stack: **Vite + React + TS**,
**uPlot** (time-series), **Recharts** (gauges/sparklines), **TanStack Query v5**
(server state), **TanStack Virtual** (tables). The only live risk is the
**React 18 vs 19 / Recharts** interaction — everything else is version-tolerant.

| Library | Current state | Risk for this upscale | Source |
| --- | --- | --- | --- |
| React | 18.x or 19.x both viable | See Recharts note | — |
| Vite | 5 / 6 both fine with these libs | None — no breaking change for our usage | https://vite.dev |
| uPlot | 1.6.32 (TS types built-in, **0 deps**) | **None** — framework-agnostic, no React peer dep | https://www.npmjs.com/package/uplot |
| TanStack Query | v5 (current) | **None** — v5 supports React 18 & 19; `notifyManager` + `refetchInterval` unchanged | https://tanstack.com/query/latest/docs/reference/notifyManager |
| TanStack Virtual | v3 | **None** — works with React 18/19 | https://tanstack.com/virtual/latest |
| Recharts | 2.15.x (final 2.x) **or** 3.x (3.9.x) | **Highest** — React 19 needs care | https://github.com/recharts/recharts/issues/4558 , https://newreleases.io/project/npm/recharts/release/2.15.0 |

### Recharts + React 19 (the one real version trap)
- Recharts <2.15 renders **empty charts** under React 19 (issue #4558).
- **2.15.0** added `react@^19` to peerDependencies ("final 2.x React 19 support"),
  but you must **pin `react-is` to match `react`/`react-dom`** (via `overrides` /
  `resolutions`) or charts stay blank. (https://newreleases.io/project/npm/recharts/release/2.15.0 , https://bstefanski.com/blog/recharts-empty-chart-react-19)
- **Recharts 3.x** rewrote state management, removed `react-smooth` and
  `recharts-scale` (animations now internal), requires **React 16.8+, TS 5.x,
  Node 18+**, and has several breaking changes (`CategoricalChartState` gone,
  `Customized` no longer receives internal props, `accessibilityLayer` on by
  default). (https://github.com/recharts/recharts/wiki/3.0-migration-guide)
- **Recommendation:** match whatever the existing `dashboard/package.json`
  already pins. If it is on React 18 → Recharts 2.x is safe as-is. If React 19 →
  go Recharts **3.x** (cleanest) or 2.15.x **with the `react-is` override**. Do
  not mix. Gauge/sparkline usage here (RadialBarChart + tiny Area) is stable
  across 2.x→3.x, so a 3.x bump is low-risk.

### General compatibility guardrails
- uPlot and TanStack libs impose **no React version constraint** — safe.
- Keep `tsc --noEmit && vite build` green (spec acceptance). Recharts 3.x needs
  `target: es6` and TS 5.x — confirm `tsconfig` already meets it (v1 builds, so
  it does).

---

## R1 — Client-side derivation of live time-series from polled REST (no WS)

**Risk:** The v1 server ring only ever receives `throughput` + `queueDepth`
(`pushTsSample` in `daemon.ts`), so `durationP95`/`passRate`/`errorRate` are
empty after cold start and the server path returns a static snapshot (spec
P1-1). The fix is a **client-side ring** fed by `GET /api/metrics` +
`GET /api/history` at 2s, never calling `fetch` itself.

### Evidence + source
- **Ring buffer** is the canonical O(1) append/filter FIFO for streaming
  windows: fixed-size array, pre-allocated, no element shifting, constant-time
  ops; correct sizing is the only critical decision. (https://www.baeldung.com/java-ring-buffer , https://www.daugaard.org/blog/writing-a-fast-and-versatile-spsc-ring-buffer)
- **requestAnimationFrame coalescing** is the correct primitive to decouple
  data arrival (every 2s poll) from paint: rAF fires once per display refresh,
  pauses in background tabs, and never stacks frames — unlike `setInterval`.
  (https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame , https://codeshack.io/references/javascript/requestanimationframe/)
- uPlot's streaming demo uses a **fixed-length sliding slice** fed to
  `setData` on each tick (see R3). (https://leeoniya.github.io/uPlot/demos/stream-data.html)

### Recommended approach
- One bounded ring per derived metric (`durationP95`, `passRate`, `errorRate`,
  plus throughput/queueDepth mirror). Cap ~1800 samples/metric (≈30 min @2s);
  **expose only `10m`/`1h` on read** per spec §5.
- Append on each 2s poll of `useMetrics()`/`useHistory()` with `t = Date.now()`;
  **do not** re-render per append. The store notifies subscribers, and the chart
  layer coalesces all pending updates into a **single rAF** before calling
  `uPlot.setData` / Recharts update. This is the same idea as TanStack's
  `notifyManager.setScheduler(requestAnimationFrame)` (R2) applied to the ring.
- Treat the ring as a pure transform over the existing Query cache — it never
  fetches (spec §6). `useDerivedSeries` reads the cached metrics object and
  pushes one sample per observed change.

### Fallback
- If rAF coalescing proves awkward with React's render model, fall back to
  driving updates directly from the 2s poll callback (the data already changes
  only every 2s, so a render storm is unlikely at this cadence). Keep the ring
  as the single source of truth so windowing (`10m`/`1h`) stays correct
  regardless of poll timing jitter.

---

## R2 — Poll `/api/checkpoint` + `/loops` at 2s without render storms

**Risk:** Multiple 2s `useQuery` hooks (checkpoint, loops, metrics, history,
timeseries) can each trigger re-renders on every tick, and WS-driven cache
  writes (`state_change`/`child_status_change`) add more. Without batching, the
  UI repaints many times per second.

### Evidence + source
- **`refetchInterval`** (TanStack Query v5) accepts a number or a function
  returning ms and polls on that cadence; `refetchIntervalInBackground` controls
  background-tab behavior. (https://tanstack.com/query/latest/docs/reference/useQuery)
- **`notifyManager.setScheduler(requestAnimationFrame)`** — the official,
  documented way to coalesce all Query notifications into one paint per frame.
  Default scheduler is `setTimeout(cb, 0)`; switching to rAF means "schedule
  batches before the next frame is rendered." (https://tanstack.com/query/latest/docs/reference/notifyManager)
- The notify manager already **batches and queues** observer callbacks; the
  scheduler only decides *when* the batch flushes
  (https://github.com/TanStack/query/blob/main/packages/query-core/src/notifyManager.ts).
- Query deduplication: one `QueryClient` coordinates fetches, so multiple
  components reading the same `queryKey` share one cache entry and one poll —
  no duplicate network requests. (https://tanstack.com/query/latest)

### Recommended approach
- Install `notifyManager.setScheduler(requestAnimationFrame)` **once** in
  `main.tsx` (spec §3.2, review.md P2-3). This is the single highest-leverage
  fix.
- Set `refetchInterval` per hook: `useTimeSeries` **2000** (was 5000),
  `useCheckpoint` 2000, `useMetrics` 5000, `useHealthScore` 5000,
  `useHistory` 2000 (spec §3.2).
- **WS-owned keys** (`/state`, `/loops`) get `staleTime: Infinity` so the WS
  handler is the only writer; polling must not invalidate them (spec P2-2).
- Use `select` in consuming components to subscribe to **only the fields they
  need**, so an unrelated field change in the cached object does not re-render
  the component.

### Fallback
- If a specific component still over-renders, wrap it in `React.memo` and/or
  rely on the `select` + structural-sharing equality default. The rAF scheduler
  already caps paints at the display refresh rate, so worst case is one repaint
  per frame — acceptable for a localhost ops console. Reducing `refetchInterval`
  is *not* the fallback; keep 2s per spec.

---

## R3 — uPlot for 4+ live series (throughput, queueDepth, durationP95, passRate, errorRate)

**Risk:** The four (really five, with errorRate) metrics have **different units
and magnitudes** (req/s vs depth count vs ms vs ratio). A single naive shared
y-axis would crush the small-magnitude series. Also need no re-mount on update.

### Evidence + source
- uPlot is Canvas2D, ~45–50 KB, **0 dependencies**, and explicitly supports
  **"Multiple series w/toggle", "Multiple y-axes, scales & grids"**, temporal
  x-axis, and **"Data streaming (live update)"**. Streaming bench: 3,600 points
  @60fps at 10% CPU / 12.3 MB. (https://github.com/leeoniya/uPlot , https://leeoniya.github.io/uPlot/)
- `setData(data, resetScales?)` is the live-update entry point (default
  `resetScales = true`). For a **sliding window** you fix the x scale range and
  pass a fixed-length slice, as in the stream-data demo. (https://github.com/leeoniya/uPlot/blob/master/dist/uPlot.d.ts , https://github.com/leeoniya/uPlot/issues/268)
- `setData(data, false)` skips scale reset; pair with explicit `setScale` /
  `redraw()` if you want a static x range (the "static x scale" stream variant).
  (https://github.com/leeoniya/uPlot/issues/274)
- **Cursor sync** lets multiple uPlot charts share one crosshair — ideal for a
  stacked ops layout. (https://leeoniya.github.io/uPlot/demos/sync-cursor.html)
- uPlot "may begin to struggle beyond 100k in-view points" — irrelevant here
  (max ~1800/ring, ≤3600 visible). (https://leeoniya.github.io/uPlot/)

### Recommended approach
- **One `uPlot` instance per chart, stacked vertically**, each bound to one
  metric's client/server ring, sharing the **x cursor** via uPlot's cursor-sync
  (`sync: { key: 'ops' }`). This keeps each series on its own auto-scaled y-axis
  (clean readability) while a shared crosshair makes them feel like one console.
- Single update path: on each 2s sample, build the `AlignedData`
  `[xs, ys]` tuple from the ring (`read('10m' | '1h')`) and call
  `u.setData(slice, true)` — **no React re-mount**, no key change (spec §6).
- For the Ops Health screen that shows all four together, either (a) stack four
  synced charts, or (b) one chart with **distinct scale keys** (`scale:
  'throughput'`, `'depth'`, `'p95'`, `'rate'`) and up to 4 y-axes on sides 1/3.
  (a) is preferred for a dense, readable ops console.

### Fallback
- If four stacked canvases cost too much layout height, collapse to **two
  charts**: (throughput + queueDepth) sharing one axis-ish scale, and
  (durationP95 + passRate + errorRate) with a 0–1 rate axis and a separate ms
  axis. uPlot's multi-scale support makes this trivial. Worst case, normalize
  all series to 0–1 for a single overview sparkline and keep the per-metric
  detail charts for drill-down.

---

## R4 — Gauge + sparkline card patterns with Recharts

**Risk:** Spec asks for radial **gauges** (health, plan progress) and inline
**sparklines** in KPI cards. Recharts is SVG (fine for few points, bad for
thousands) — so it is right for gauges/sparklines but wrong for the live
time-series (uPlot handles those, R3).

### Evidence + source
- **RadialBarChart** is the Recharts gauge primitive: `startAngle`/`endAngle`
  make a **partial arc**; `innerRadius`/`outerRadius` set ring thickness; a
  centered `<text>` gives the number-in-middle gauge. (https://recharts.github.io/en-US/api/RadialBarChart , https://recharts.github.io/en-US/examples/SimpleRadialBarChart , https://stackoverflow.com/questions/71153325/react-recharts-radialbarchart-clockwise)
- shadcn/Radial pattern: single data point, partial arc (e.g. 250° gauge),
  center `<Label>` with SVG text; themed via CSS vars (`--color-<key>`) that
  auto-retheme in dark mode. (https://designrevision.com/components/radial-chart)
- **Sparkline** = small axis-free Recharts `<Area/>` (or Line): no
  CartesianGrid, no XAxis/YAxis, `dot={false}`, container `h-[60px]`; the value
  + trend text carry meaning, the chart is decorative (`aria-hidden`).
  (https://designrevision.com/components/sparkline)
- Recharts **animations are on by default** (`animationDuration` 1500). For live
  gauges/sparklines that update every 2s, set `isAnimationActive={false}` (or a
  short duration) to avoid constant re-tweening/jitter. In Recharts 3.x
  animations are internal (no `react-smooth` dep) — still disable for live.
  (https://recharts.github.io/en-US/api/Area , https://github.com/recharts/recharts/wiki/3.0-migration-guide)

### Recommended approach
- **Gauge component** (`components/Gauge.tsx`): `RadialBarChart` with one
  `RadialBar`, `startAngle={220} endAngle={-40}` (≈260° sweep), `innerRadius`
  ~70%, `background` track, `isAnimationActive={false}`, and a centered
  `<text>` showing the % . Feed it `healthScore` and `completedTaskIds.length /
  totalKnown`.
- **Sparkline component** (`components/Sparkline.tsx`): `AreaChart` → `<Area
  type="monotone" dot={false} isAnimationActive={false}/>`, height ~48–60px,
  `aria-hidden`. Feed ≤60 points from the client ring for that metric
  (throughput, p95, error rate, pass rate) — spec §3.3.
- Theme both via the shared `tokens.css` CSS variables (R5) so they match uPlot's
  palette exactly.

### Fallback
- If Recharts RadialBar gauges feel heavy or animate oddly, the spec explicitly
  permits a **lightweight SVG arc** ("no new lib"). A hand-rolled
  `<svg><path>` arc with `stroke-dasharray` is ~20 lines and fully token-driven.
  Keep Recharts for sparklines (Area is trivial) unless SVG is preferred
  everywhere for consistency.

---

## R5 — Design-system approach for a dense ops console

**Risk:** v1 reads as "glued-together panels." Spec wants a cohesive dark-mode
ops console: top status bar, 12-col grid, tabular numerics, shared tokens, and a
status color system — with **uPlot and Recharts reading the same tokens**.

### Evidence + source
- **Two-layer CSS-variable token architecture** is the current best practice:
  (1) **primitive** tokens (raw palette + spacing/radius scale), (2) **semantic**
  tokens (`--color-bg`, `--color-surface`, `--color-success`, etc.) that
  components actually consume. Change one place → updates everywhere; dark mode
  is "free" by redefining semantic tokens. (https://csstools.io/blog/css-variables-guide , https://mypalettetool.com/blog/color-system-css-variables)
- **Dark mode is not inversion** — use dark *gray* (not pure black) surfaces,
  lighter surfaces for elevation, adjusted (not inverted) brand colors, and
  validated contrast. Three tiers: primitives → semantic → theme overrides.
  (https://framingui.com/blog/dark-mode-implementation-design-tokens , https://cr0x.net/en/dark-mode-token-system)
- Toggle pattern: `.dark` class on `:root` (or `prefers-color-scheme`); spec
  says **ship dark only** (operator tool) → set dark tokens as the base.
  (https://pickcss.com/blog/dark-mode-css-variables)
- Recharts + shadcn chart theming already injects `--color-<key>` vars scoped
  per light/dark and auto-retemes — the same CSS-variable mechanism we use, so
  Recharts gauges/sparklines and uPlot axes can share one palette.
  (https://designrevision.com/components/sparkline , https://designrevision.com/components/radial-chart)
- uPlot axes/series take CSS color **strings**, so they read the same
  `var(--color-*)` values (set axis `stroke`/`grid`/`tick` to token vars; series
  `stroke`/`fill` to status tokens).

### Recommended approach
- Create `styles/tokens.css` with:
  - **Primitive layer:** neutral scale (e.g. `--gray-950..50`), accent, and a
    status ramp (`--ok`, `--warn`, `--err`, `--info` + tints).
  - **Semantic layer:** `--bg`, `--surface`, `--surface-2` (elevation),
    `--border`, `--text`, `--text-muted`, `--status-ok/warn/err/info`,
    `--chart-1..5` (one per live series), `--radius`, `--space-1..8`,
    `--shadow`.
  - Dark as the **base** (`:root` = dark values); no light mode per spec.
- **Status color system:** map `pending`/`in-progress`/`done` and
  `pass`/`fail`/`error`/`heal` to the semantic status tokens so the Plans board,
  child-loop strip, and recovery mini-card all share one vocabulary.
- Layout: fixed top status bar (WS status + last-poll ts) + CSS-grid 12-col
  body; cards use consistent `--space` padding, `font-variant-numeric:
  tabular-nums` on all numerics, and `--border`/`--surface` for the panel look.
- Wire uPlot axis/grid colors and Recharts fills to the **same** `--chart-*` /
  `--status-*` vars so both chart libs are chromatically identical.

### Fallback
- If a full two-layer token file is over-scoped for the upscale, ship a single
  flat `:root` dark palette (primitives + semantic merged) — still satisfies
  "cohesive dark mode" and is trivially refactorable later. The hard requirement
  is **one palette consumed by both uPlot and Recharts**; the layering is
  polish.

---

## Summary of highest-leverage decisions
1. **`notifyManager.setScheduler(requestAnimationFrame)` in `main.tsx`** — kills
   render storms across all polling + WS cache writes (R2).
2. **Client ring as pure transform over the Query cache, rAF-coalesced** — closes
   the P1-1 static-snapshot gap with zero backend change (R1).
3. **uPlot for the 4+ live series (stacked, cursor-synced, per-metric scales);
   Recharts only for gauges/sparklines** — right tool per data shape (R3/R4).
4. **Recharts version matched to React (3.x or 2.15+ w/ react-is override)** —
   the only real dependency trap (§0).
5. **One dark token palette shared by uPlot + Recharts** — cohesive ops console
   (R5).

### Source index
- TanStack Query `notifyManager` / `setScheduler`: https://tanstack.com/query/latest/docs/reference/notifyManager
- TanStack Query `useQuery` / `refetchInterval`: https://tanstack.com/query/latest/docs/reference/useQuery
- notifyManager source: https://github.com/TanStack/query/blob/main/packages/query-core/src/notifyManager.ts
- uPlot (streaming, multi-axis, perf): https://github.com/leeoniya/uPlot , https://leeoniya.github.io/uPlot/ , https://leeoniya.github.io/uPlot/demos/stream-data.html , https://leeoniya.github.io/uPlot/demos/sync-cursor.html
- uPlot `setData`/`setScale` types: https://github.com/leeoniya/uPlot/blob/master/dist/uPlot.d.ts
- Recharts RadialBarChart/Area APIs: https://recharts.github.io/en-US/api/RadialBarChart , https://recharts.github.io/en-US/api/Area
- Recharts 3.0 migration: https://github.com/recharts/recharts/wiki/3.0-migration-guide
- Recharts React 19 (issue #4558, 2.15 notes): https://github.com/recharts/recharts/issues/4558 , https://newreleases.io/project/npm/recharts/release/2.15.0
- shadcn Radial/Sparkline (CSS-var theming): https://designrevision.com/components/radial-chart , https://designrevision.com/components/sparkline
- requestAnimationFrame (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- CSS variable design tokens / dark mode: https://csstools.io/blog/css-variables-guide , https://mypalettetool.com/blog/color-system-css-variables , https://framingui.com/blog/dark-mode-implementation-design-tokens , https://cr0x.net/en/dark-mode-token-system , https://pickcss.com/blog/dark-mode-css-variables
- Ring buffer: https://www.baeldung.com/java-ring-buffer , https://www.daugaard.org/blog/writing-a-fast-and-versatile-spsc-ring-buffer
