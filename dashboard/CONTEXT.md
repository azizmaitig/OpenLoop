# Dashboard Renovation â€” CONTEXT

> Grill-with-docs output for the dashboard renovation. Source of truth for the
> spec-layer awareness + visual polish work. v9 feedback-controller is OUT of scope.

## Why this exists

The agent-loop daemon now runs a **spec-driven pipeline** (L1 drafts â†’ L2
implements+stamps `built` â†’ L3 evolves config), operating on
`12-active loop/specs/`. The dashboard, however, still treats the
system like a generic task runner â€” it shows loops, tasks, and metrics, but is
**blind to the spec layer**. After the spec-driven feature landed, the dashboard
needs renovation to (a) surface that pipeline and (b) tighten its existing
visual design.

## Decisions (from grill)

### A â€” Visual direction: A1 (polish-in-place)
- Keep the existing dark technical CSS-var system (`--ok/--crit/--warn/--accent/
  --bg-elev-2`). No risky re-skin, no new identity.
- Tighten: spacing, typography hierarchy, info density, consistent component
  language across cards/panels.

### B â€” Spec-layer awareness: B1 + B2 + B3 + B4 (all four)
- **B1 Spec pipeline board** â€” all specs (001â€“007â€¦) as lifecycle cards/stages
  (Draft â†’ Reviewed â†’ In Progress â†’ Built â†’ Verified), clickable to detail.
- **B2 L1/L2/L3 orchestration view** â€” visualize the three daemon loops, what
  each is doing now, and how they hand off (L1 â†’ specs â†’ L2 â†’ built â†’ L3 â†’ evolve).
- **B3 Evolve proposal inbox** â€” surface `.build/spec-evolve/spec-evolve-proposals.md`
  entries as a review queue in the UI (currently read as markdown).
- **B4 Specâ†”task traceability** â€” click a spec, see which loop runs / tasks
  touched it.

### 3a â€” Screen scope: KEEP all existing + ADD new spec screens
- Existing `ops` / `diag` / `dag` screens stay (engine views, tested).
- New tabs join `TabNav`: `specs` (B1+B4), `orchestration` (B2), `evolve` (B3).

### 3b â€” Live data: MANUAL refresh button (no polling, no daemon change)
- Spec layer lives in **files**, not the WebSocket. Add a refresh button per
  spec screen; no file-watcher, no daemon modification.

### 3c â€” Definition of Done
- All 18 stale dashboard tests fixed/updated + new spec-screen tests green.
- New tabs render **real** spec data from `spec-factory` (not mocked).
- `bun test` (dashboard) fully green; `bun run build` succeeds.
- Stays within the existing dark CSS-var system (A1).

## Data sources (paths)
- Specs: `D:\projects\obsidian\second brain\10-Projects\12-active loop\<NNN-*>\{spec.md,plan.md,tasks.md,...}`
- Status parse: `spec.md` front-matter `**Status**: <Draft|Built|...>`.
- Evolve proposals: `agent-loop\.build\spec-evolve\spec-evolve-proposals.md`.
- Loop state (L1/L2/L3): daemon REST `/state`, `/api/history` (per existing hooks).

## Prerequisite (unblocks green base)
- The 18 `WorkflowGraph.test.tsx` failures are a **stale test**: it calls the old
  4-arg `buildRfNodes(nodes, positions, selectedNodeId, dragged)` signature.
  Current `WorkflowGraph.tsx` is 3-arg `buildRfNodes(dagNodes, positions,
  draggedPositions: Map)` â€” selection moved into the zustand store. Fix the test
  to the current signature; the component is correct.

