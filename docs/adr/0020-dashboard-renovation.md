# ADR-0020: Dashboard Renovation — Spec-Layer Awareness + Visual Polish

- **Status:** Accepted (grilled 2026-07-20)
- **Supersedes:** ADR-0013 (dashboard observability) — extends, does not replace
- **Out of scope:** v9 feedback-controller (separate future change)

## Context

The agent-loop engine now runs a spec-driven pipeline (L1/L2/L3 daemons operating
on `spec-factory/specs/`). The dashboard (`dashboard/`, Vite+React SPA served by
the daemon at `/dashboard`) visualizes the *engine* (loops, tasks, metrics, DAG)
but has zero visibility into the *spec layer* that the loops actually orchestrate.
Additionally, the existing dark UI is functional but visually generic, and the
dashboard test suite carries 18 stale failures from a `buildRfNodes` signature
change that was never reflected in the test.

## Decision

Renovate the dashboard along two axes:

1. **Visual (A1 — polish-in-place).** Retain the existing dark CSS-var design
   system. Improve spacing, typographic hierarchy, and component consistency. No
   new visual identity, no architectural CSS rewrite.

2. **Spec-layer awareness (B1+B2+B3+B4).** Add three new tabs to `TabNav`
   (`specs`, `orchestration`, `evolve`) alongside the existing `ops`/`diag`/`dag`:
   - **specs (B1+B4):** pipeline board of all specs with lifecycle status
     (Draft→Reviewed→In Progress→Built→Verified); click a spec to see
     traceability to loop runs / tasks that touched it.
   - **orchestration (B2):** view of the three daemon loops (L1/L2/L3), current
     activity, and hand-off flow.
   - **evolve (B3):** inbox rendering `.build/spec-evolve/spec-evolve-proposals.md`
     as a review queue.

### Data & liveness
- Spec data is read from the **filesystem** (`spec-factory/specs/*`,
  `.build/spec-evolve/*`), NOT the daemon WebSocket. Each spec screen gets a
  **manual refresh button** — no polling, no daemon file-watch, no daemon change.
- Loop/orchestration state reuses existing daemon REST endpoints (`/state`,
  `/api/history`) already consumed by current screens.

### Test hygiene (prerequisite)
- Fix the 18 stale `WorkflowGraph.test.tsx` cases to the current 3-arg
  `buildRfNodes(dagNodes, positions, draggedPositions: Map)` signature. The
  component is correct; the test is outdated.

## Consequences

- Positive: dashboard becomes the single observability surface for the whole
  spec-driven system; engine views preserved; test suite green.
- Positive: no daemon changes required (manual-refresh + REST reuse).
- Negative: spec views are not real-time (manual refresh only) — acceptable
  because spec lifecycle changes slowly.
- Negative: new tab screens add surface area to maintain.

## Success criteria
- All dashboard tests green (18 stale fixed + new spec-screen tests).
- New tabs render real spec data (no mocks).
- `bun test` (dashboard) green; `bun run build` succeeds.
- Within existing dark CSS-var system.
