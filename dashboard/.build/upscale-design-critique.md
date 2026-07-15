# Design Critique — agent-loop Dashboard Upscale (v1.5)

**Verdict: REVISE** (2× P0, 3× P1, 4× P2). The design is structurally sound and, importantly,
**genuinely respects the binding hard constraint** (no `agent-loop/src/` edits — see §A).
But it has one fabricated data contract (`recovery`) and several field-name mismatches
against the real `dashboard/src/lib/types.ts` and `src/types.ts` that must be fixed before L2.

Sources read: `upscale-design.md`, `upscale-spec.md`, `dashboard/src/lib/types.ts`,
`dashboard/src/lib/api.ts`, `dashboard/src/hooks/useTimeSeries.ts`,
`dashboard/src/hooks/useLoopStream.tsx`, `src/types.ts`.

---

## A. Source-of-truth constraint — does it truly avoid `src/` edits? ✅ COMPLIANT (strength)

- Every file in the layout (§5) lives under `dashboard/src/…`. The repo-root `src/`
  (`agent-loop/src/`: `daemon.ts`, `routes.ts`, `daemon-api.ts`, `dashboard-api.ts`) is
  **not created, edited, or deleted**.
- Acceptance gate `git diff --stat src/` (run from repo root) is correctly scoped:
  `dashboard/` is a sibling of `src/`, so dashboard edits do not appear in that diff.
  This is a real, verifiable compliance win and the design's strongest property.
- **P2 — build output pollutes repo-root `src/`.** Spec §6 keeps v1's
  `build.outDir = ../src/dashboard`, so `vite build` writes artifacts into
  `agent-loop/src/dashboard/` — *under repo-root `src/`*. This is pre-existing v1 behavior,
  but during this work it creates/modifies files under the frozen `src/`. Mitigation: ensure
  `src/dashboard/` is git-ignored and restate the gate as "only `dashboard/` is changed /
  untracked" (use `git status`, not just `git diff --stat`). Add to `.gitignore` before L2.

---

## B. Field-name verification against real types

Verified each field the design consumes. ✅ = exists, ❌ = does not exist.

| Design reference | Real type | Result |
|---|---|---|
| `taskMetrics.p95DurationMs` | `TaskMetricsResult.p95DurationMs` | ✅ |
| `passCount`/`failCount`/`errorCount` | `TaskMetricsResult.*` | ✅ |
| `MetricsResponse.triggers[]` / `TriggerSummary.fireCount` | `MetricsResponse.triggers`, `TriggerSummary.fireCount` | ✅ (design writes `/api/metrics.triggers` sloppily but means `MetricsResponse.triggers` — cosmetic) |
| `ChildLoopSummary.planPath/name/status/triggerCount/enabled` | `ChildLoopSummary` | ✅ |
| `CheckpointState.planPath/planName/completedTaskIds/inProgressTaskId/results` | `CheckpointState` | ✅ |
| `fetchMetrics(window,lastN)`, `fetchHistory(page,pageSize)`, `fetchLoops()`, `fetchCheckpoint(planPath?)`, `fetchTimeSeries(metric,window)` | `lib/api.ts` | ✅ signatures match design usage exactly |
| **`CheckpointState.totalTasks`** (design §2.1) | — | ❌ **no such field** (see P1-B1) |
| **spec `totalKnown`** (`types.ts:90` cited) | — | ❌ **no such field** |
| **`HistoryListEntry.status==='healed'|'recovered'` / `retryCount`** (design §2.4) | `TaskStatus = queued|running|completed|failed|cancelled`; no `retryCount` anywhere in tree | ❌ **no such fields** (see P0-B2) |
| WS events `state_change`/`child_status_change`/`task_event`/`task_completed` | `useLoopStream.tsx` | ✅ exist — design correctly reuses them, no new event |

Grep across the whole repo confirmed `totalTasks`, `totalKnown`, `retryCount`, and any
`'healed'`/`'recovered'` *status* value do **not** exist (the only "healed" string is a test
stdout fixture in `recovery.test.ts`, not a status).

---

## C. P0 — must fix before L2

### P0-1 · `recovery` metric is unachievable from real data (fabricated contract)
Design §2.4 derives `recovery` from `/api/history` entries with
`status==='healed'` or `retryCount>0` (fallback `status==='recovered'`). None of these
fields exist: `HistoryListEntry.status` is `TaskStatus` (no heal/recovered states) and there
is no `retryCount` on any history type. `/api/metrics` likewise exposes only cumulative
`pass/fail/errorCount`, not retries. **Consequence:** the `RecoveryCard` (§2.6) will render a
"live" series that is *permanently 0* — worse than missing, because it implies recovery
activity that cannot be measured. Design §8 even admits this but frames it as a *graceful
degrade*; in reality it is always 0, so the card is meaningless and the spec §3.1 "recovery
visibility" requirement cannot be met client-side.
**Fix:** either (a) drop `recovery`/`RecoveryCard` entirely, or (b) redefine it from signals
that actually exist (e.g., count history entries with `status==='failed'`/`'error'` in the
window vs. previously, as a *failure* proxy — but this is not "recovery"). Do not ship a
constant-0 KPI. Mirror the same correction back into the spec.

### P0-2 · Ring feeder dies when the Plans tab is active (lifecycle break)
§2.3 mounts `useLiveMetrics()` "once — in OpsHealthScreen, or App". §2.2 then says
`usePlans` "reads the ring via `useDerivedSeries` for any plan-level KPI sparkline". But
`OpsHealthScreen` unmounts when the user switches to the `plans` tab (lazy tab switch, §2.11),
so the 2s feeder stops feeding `seriesRing` while on Plans → any Plans sparkline goes stale /
empty. The design contradicts itself on where the feeder lives.
**Fix:** mount `useLiveMetrics()` once above the tab switch (in `App.tsx`, outside the
`ScreenId` conditional) so the ring is fed on every tab. Make this explicit and mandatory.

---

## D. P1 — should fix before L2

### P1-1 · `CheckpointState` has no total task count
Neither `totalTasks` (design §2.1) nor the spec's `totalKnown` exist. Progress denominator is
unknown from the type — only `completedTaskIds`, `inProgressTaskId`, and `results` keys are
available. Design §2.1's `completedTaskIds.length / totalTasks` with
`Object.keys(results).length` fallback is therefore imprecise and the `PlanSummary.total`
field is undefined in source.
**Fix:** define `total = max(results keys, completedTaskIds) + (inProgressTaskId?1:0)` and
document it as best-effort (plans may contain tasks not yet represented). Drop the
`totalTasks` reference.

### P1-2 · `/loops` polling contradicts spec's "WS-owned" intent
Spec §0.3 says poll `GET /loops` at 2s, but §3.2 (P2-2) says "`/loops` hooks use
`staleTime: Infinity` (WS writes cache)". Design §2.2 polls `/loops` at 2s and never sets
`staleTime: Infinity`. The spec is internally contradictory and the design picked the
poll side without noting it. Polling `/loops` at 2s alongside the existing `child_status_change`
WS mirror is redundant double-data and contradicts the cadence/batch fix the spec asked for.
**Fix:** reconcile explicitly — choose ONE: WS-owned (`staleTime: Infinity`, no poll) per
§3.2, OR 2s poll per §0.3. Recommend WS-owned for `/loops` and `/state` to honor P2-2, and
poll only `/api/checkpoint` (which has no WS event) at 2s.

### P1-3 · `useDerivedSeries` ring "emit" is unspecified
§2.5 says it "re-renders on a 2s setInterval tick reading `seriesRing.read(...)` (or
subscribes to the ring's emit — same cadence)". But `SeriesRing` (§2.3) exposes only
`append/read/latest/clear` — there is **no** `emit`/subscribe mechanism. The "or" branch is
vapor. Pick the `setInterval` reader (works) and delete the phantom subscribe option.

---

## E. P2 — polish / missing spec requirements

### P2-1 · Missing `TaskDetailDrawer` click-through
Spec §3.1 requires per-task rows "clicking opens the existing `TaskDetailDrawer`
(`GET /api/tasks/:id`)". Design §2.1 only renders "fail/error rows: exitCode+stderr" with no
click handler and no drawer. Either wire the existing drawer or drop the requirement from the
spec. (Verify the drawer component exists in v1 before claiming it.)

### P2-2 · Missing `?plan` / `?planPath=` deep-link
Spec §3.1 requires `?plan=` / `?planPath=` to target a specific plan. Design §2.1 uses internal
`selectedPlanPath` state only — no URL search-param read. Add deep-link support or narrow the
spec.

### P2-3 · Missing connection/health top bar
Spec §3.3 requires a top bar showing WS status (from `useLoopStream`) + last-poll timestamp.
Design §2.10/2.11 has no top status bar. Add it (cheap, reuses existing `useLoopStream`) or
remove from spec.

### P2-4 · `src/dashboard/` build output not git-ignored (see P2 under §A)
Restate the hard-constraint gate in terms of `git status` cleanliness of `dashboard/` and add
`src/dashboard/` (or whatever `outDir` resolves to) to `.gitignore` so the build never creates
tracked files under repo-root `src/`.

---

## F. Over-engineering / scalability / security — no major concerns

- **Over-engineering:** none found. Ring capacity 1800 (1h@2s), Gauge/Sparkline/tokens, and
  the three new cards are all in spec scope. Separation of `usePlans` (plan data) vs
  `useLiveMetrics` (ring) is clean, not excessive.
- **Scalability:** client ring is bounded (≤5 metrics × 1800 pts); 2s polling of ~5 endpoints
  for a single localhost operator is fine. No server load added (constraint respected).
- **Security:** correctly inherits v1 localhost open-access model; adds no auth, secrets,
  or new exposed surface (out-of-scope per §7). No injection risk — sparkline/points are
  numeric; `planPath` is `encodeURIComponent`'d by `fetchCheckpoint`. Acceptable.

---

## G. Summary checklist

- [x] **Truly avoids `src/` edits** — compliant; all changes under `dashboard/src/`.
- [ ] Every field name maps to real types — **NO**: `totalTasks`/`totalKnown` and
      `healed`/`recovered`/`retryCount` do not exist.
- [ ] `recovery` KPI derivable — **NO** (P0-1); will always be 0.
- [ ] Ring fed on all tabs — **NO** (P0-2); dies on Plans tab.
- [ ] Checkpoint progress denominator defined — **NO** (P1-1).
- [ ] `/loops` cadence reconciled with spec — **NO** (P1-2).
- [ ] All spec §3.1/§3.3 features present — **NO** (P2-1/2/3).

**Decision: REVISE.** Resolve P0-1 and P0-2 (and reconcile P1 items) before this design is
eligible for L2 implementation. The no-`src/` constraint is satisfied and need not be revised.
