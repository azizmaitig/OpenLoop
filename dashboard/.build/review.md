# Code Review — agent-loop Observability Dashboard

**Inputs reviewed**
- `code-frontend.diff` (52 files: SPA + backend `src/daemon.ts`, `src/daemon-api.ts`, `src/routes.ts`, `src/dashboard-api.ts`)
- `code-backend.diff` (UTF-16; only `routes.ts` hunk + a header for `dashboard-api.ts` with **no body** — the full backend already lives in `code-frontend.diff`)
- `design.md` (L1 design / contract)

**Axes applied** (per `code-review` skill): Standards (repo invariants + Fowler baseline) and Spec (design.md adherence); plus an explicit Security pass on the backend diff and an Additivity check (invariant §0.1).

**Verdict: APPROVE with minor fixes (no P0 blockers).** Additive-only backend, all existing route bodies untouched, no secrets in diff, test notes report green. Several P2 design deviations and two P1 items (timeseries window coverage, client-exposed API key) should be fixed before merge.

---

## P0 — Blockers (none)
- No secrets/key material committed; no `.env`, no hardcoded credentials.
- Existing route handlers (`routes.ts`) are byte-for-byte untouched by the change.
- `dashboard-api.ts` is a new module; existing `metrics.ts`/`checkpoint.ts` are only *composed*, not edited.

---

## P1 — Should fix before merge

### P1-1 (Backend correctness) Timeseries large windows return only ~60 min of live data
`dashboard-api.ts:3481` — `handleDashboardApi` returns `ring.read(metric, window)` as soon as the ring has **any** point:
```ts
const live = ring.read(metric, window);
if (live.points.length > 0) return Response.json(live);
```
The ring is capped at 1800 samples @2s = **60 min** (`daemon.ts:3177`, `createTsRing(1800)`). So `GET /api/metrics/timeseries?window=24h` returns at most the last 60 min once the daemon has been running, and the cold-start `bucketHistory()` backfill over the full window is **never reached**. Design §5.3/§5.5 implies the window should span the requested range. Fix: when `live.points` covers less than the requested window span, merge/concatenate the cold-start history buckets, or raise the ring cap, or always backfill for windows wider than the ring's retention.

### P1-2 (Security) Dashboard API key is exposed to any client that loads `/dashboard`
`lib/api.ts:2547` reads the bearer key from a runtime global:
```ts
function authHeaders() {
  const key = typeof window !== 'undefined' ? window.__LOOP_API_KEY__ : undefined;
  return key ? { Authorization: `Bearer ${key}` } : {};
}
```
Design §3.1 specifies `import.meta.env.VITE_LOOP_API_KEY`; §5.5 says the bearer is sent on all `fetch`. The implementation deviates (window global instead of build-time env). More importantly, because the SPA is served from the same origin and the key is embedded in the client (or injected HTML), **anyone who can load `/dashboard` can read the `LOOP_API_KEY` bearer**, which is the very secret meant to gate the API. This is inherent to SPA auth, but the design's trust model ("no key = open, localhost only, don't expose the port") should be documented next to this code, and the key should not be trivially readable (consider a one-time short-lived token, or accept that the dashboard port must stay localhost-only). Flagging as P1 because it partially defeats the `LOOP_API_KEY` control.

---

## P2 — Design deviations / hygiene

### Spec (design.md) adherence
- **P2-1 `useTimeSeries` cadence wrong.** `useTimeSeries.ts:2312` uses `refetchInterval: 5000` (5s). Design §3.2 and §5.3 require **2s** ("client's live chart = 2s REST poll"). The live strip will look ~2.5× laggier than specified.
- **P2-2 WS-owned keys not `staleTime: Infinity`.** Design §3.2 says `/state` and `/loops` use `staleTime: Infinity` (WS writes the cache). Implemented: `useDaemonState.ts` and `useLoops.ts` use `staleTime: 2000`. Harmless but contradicts the contract and lets polling/WS double-write.
- **P2-3 `notifyManager` RAF scheduler not installed.** Design §2.1 requires `notifyManager.setScheduler(requestAnimationFrame)` once before render (so React Query notifications coalesce into frames). Neither `main.tsx` nor `App.tsx` sets it; only `lib/raf.ts` does its own RAF batching for the WS→cache flush. WS batching still works via `lib/raf`; the Query notify scheduler is the missing piece.
- **P2-4 `api.ts` auth mechanism ≠ design.** `window.__LOOP_API_KEY__` instead of `import.meta.env.VITE_LOOP_API_KEY` (see P1-2). Functionally similar but diverges from the documented contract.
- **P2-5 Event ring cap.** Design §2.8 says "last N (~200)"; `useLoopStream.tsx:2027` sets `EVENT_CAP = 500`. Minor.
- **P2-6 Missing poll intervals.** `useCheckpoint` and `useHealthScore` have no explicit `refetchInterval`; design §3.2 specs 5s. `useMetrics` uses `staleTime: 2000` vs design `4s`. Cosmetic.
- **P2-7 `QueryClientProvider` placement.** Design §2.1 puts the provider in `main.tsx`; here it's in `App.tsx` (`App.tsx:795`). Functionally equivalent — not a defect.

### Standards (repo invariants + Fowler baseline)
- **P2-8 Additivity is satisfied, with one minor insertion.** `routes.ts` only adds an import + tail delegation block (`:3509-3521`); existing handlers untouched ✓. `daemon-api.ts` only adds `readonly tsRing` to the seam ✓. The one place "existing logic" is technically touched: `daemon.ts:3185` inserts `void this.pushTsSample();` inside the **existing** `_stateInterval` callback, plus a new private `pushTsSample()` method and two private fields. This is a single additive statement inside an existing handler body — borderline vs. design §0.1 ("must NOT edit any existing route body"). It is necessary to feed the ring and does not change prior behavior, so it's acceptable, but worth noting it is the only edit inside an existing block.
- **P2-9 `computeHealthScore` double-computes.** `dashboard-api.ts:3283` computes a full `HealthScore` (with `queueDepth: 1` placeholder) that is **never returned** — the dispatcher (`handleDashboardApi` `:3462`) only reads its `passRate/errorRate/budget` and then re-runs `finalizeHealthScore`. The in-function `finalizeHealthScore` call and the returned object are dead weight. Simplify: have `computeHealthScore` return just the raw components.
- **P2-10 Path-traversal surface on `/api/checkpoint?planPath=`.** `loadCheckpointState` (`:3368`) passes `planNameFromPath(planPath)` (basename + extension strip) into `loadCheckpoint(...)`. `loadCheckpoint` itself is not in the diff, so traversal containment depends on its implementation. `basename()` removes directory separators, so the constructed `checkpoint-<name>.json` is constrained to `outputDir`, but this should be confirmed — P2 security note, not a confirmed bug.
- **P2-11 Diff hygiene.** `code-backend.diff` is UTF-16 and truncated (no `dashboard-api.ts` body), duplicating what `code-frontend.diff` already contains. The frontend diff also shows mangled non-ASCII in comments (e.g. `ÔÇö`, `┬º` for `—`/`§`) — likely an encoding artifact of the diff export, not the source, but worth re-exporting the backend diff cleanly so reviewers can diff it independently.

### Readability (positive)
- Naming is clear (`pushTsSample`, `createTsRing`, `finalizeHealthScore`, `LoopStreamProvider`, `apiFetch`), single-responsibility modules, the two documented seams (`lib/api.ts`, `useLoopStream`) are the only places that `fetch`/`WebSocket`, satisfying design §0 invariant 5. RAF batching, reconnect backoff, and poll fallback are implemented and tested. No obvious Feature Envy / Duplicated Code / Shotgun Surgery in the added surface.

---

## Backend additivity check (invariant §0.1)
| File | Change | Touches existing logic? |
|------|--------|--------------------------|
| `src/routes.ts` | import + tail `handleDashboardApi` delegation | No (existing handlers unchanged) |
| `src/daemon-api.ts` | `+ readonly tsRing: TsRing` on seam interface | No (additive field) |
| `src/daemon.ts` | `+ readonly tsRing`; `+1 line` inside existing `_stateInterval`; new private `pushTsSample()` | One additive line inside existing callback (P2-8) |
| `src/dashboard-api.ts` | entire new module | N/A (new) |

**Conclusion:** additive-only; existing route behavior is preserved. The only edit inside an existing block is the single `void this.pushTsSample();` line required to feed the ring.

---

## Summary
- **Standards axis:** 0 hard violations; P2-8/P2-9/P2-10 judgment calls. Worst item: P2-9 dead compute in `computeHealthScore`.
- **Spec axis:** design largely followed; worst item: P2-1 (24h timeseries window coverage) — a real functional gap vs the contract.
- **Security axis:** worst item: P1-2 (client-exposed bearer key). No secrets committed.
- **Verdict:** APPROVE with minor fixes — resolve P1-1 and P1-2 before merge; fold P2 deviations into a follow-up.
