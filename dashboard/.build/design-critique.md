## Critique: Design vs Spec — `upscale-design.md` → `upscale-spec.md`

### Verdict: **REVISE** — 3 P1 gaps, 4 P2 gaps

---

### P1 Issues (major — blocks acceptance)

**P1-1. Connection/health indicator not designed.**  
*Spec §3.3*: "top bar shows WS status (from `useLoopStream`) + last-poll timestamp, so the operator sees liveness at a glance."  
Design §2.11 describes mounting `useLiveMetrics` but defines **no component** and **no placement** for the health indicator. The file list (design §5) contains no status-bar component. The spec treats this as a first-class acceptance requirement (criterion §8 "Connection/health top bar"). **REVISE** — add a status-bar component and mount it in the app shell.

**P1-2. `staleTime: Infinity` not applied to WS-owned keys.**  
*Spec §3.2*:"`/state` and `/loops` hooks use `staleTime: Infinity` (WS writes cache, P2-2)."  
Design §0 carries forward `useLoops` with `staleTime: 2000` (v1 default) and design §4 lists no edit to `useLoops.ts` or `useState` to change this. The design's own §8 says "WS `/state` + `/loops` cache keys keep v1 behaviour" — contradicting the spec's explicit directive. **REVISE** — set `staleTime: Infinity` on both hooks.

**P1-3. `useHealthScore` polling interval not addressed.**  
*Spec §3.2*: "useHealthScore [gets] explicit refetchInterval (5s)". Design replaces `HealthScoreCard`'s rendering (adds gauge) but never touches its polling cadence. The design §4 edits table omits it. If the hook currently has no `refetchInterval`, health scores will be stale. **REVISE** — set `useHealthScore` `refetchInterval: 5000`.

---

### P2 Issues (minor — should fix but don't block)

**P2-1. File & interface naming drift from spec contract.**  
*Spec §0.4* explicitly names `src/lib/clientRing.ts` and describes `append(sample)` + `read(window)`. Design renames to `lib/series.ts` with `createSeriesRing` and a multi-metric interface (`append(metric, p)`, `read(metric, windowMs, now?)`). The design's interface is richer but makes spec-to-code traceability harder. **REVISE** — either rename to `clientRing.ts` or note the divergence in design §8.

**P2-2. Recovery and trigger-fire visibility scoped to Ops screen, not Plans screen.**  
*Spec §3.1* places recovery visibility ("retries/recovers mini-card", "error-rate sparkline") and trigger-fire visibility within the **Plans/Runs screen**. Design places both `RecoveryCard` and `TriggerFireCard` only in `OpsHealthScreen`'s `MetricCardGrid` (design §2.6). The data _is available_ to Plans via the shared ring, but the design doesn't compose these cards into `PlansScreen`. **REVISE** — add recovery and trigger-fire mini-cards to the Plans screen layout as spec §3.1 requires.

**P2-3. `useLiveMetrics` mount location ambiguous.**  
Design §2.11: "Mount the `useLiveMetrics()` feeder once (in `OpsHealthScreen`, or `App`)." If mounted in `OpsHealthScreen`, switching directly to the Plans tab (without visiting Ops first) yields an empty ring: no durationP95, passRate, errorRate, recovery, or triggerFire data for the Plans screen. **REVISE** — specify mount in `App` above the tab switch, guaranteeing the ring primes before any screen reads it.

**P2-4. Recovery metric may always degrade to 0.**  
Design §8 acknowledges `HistoryListEntry` may lack `retryCount`/`healed` fields, causing recovery to resolve to `0`. The spec §3.1 requires recovery visibility as a feature, not an optional. If these fields don't exist, the feature is silently invisible. **REVISE** — either confirm field presence during L2 (add a pre-flight check to design §8) or specify an alternative derivation (e.g. ratio of fail/error to total tasks) that works without those fields.

---

### Summary

| Axis | Findings | Worst |
|------|----------|-------|
| **Spec coverage** | 3 P1, 4 P2 | P1 — Health indicator missing, staleTime unset, healthScore cadence unaddressed |

**Overall: REVISE with 7 issues** (3 P1 structural gaps, 4 P2 scoping/naming/ambiguity issues). The design correctly covers ~90% of the spec's functional surface; the remaining 10% are concentrated in the app shell (status bar, WS-key config, Plans screen recovery/trigger cards) and in traceability (`clientRing` naming).
