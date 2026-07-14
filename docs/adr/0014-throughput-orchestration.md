# 0014 — Throughput & orchestration optimizations (parallel phases, atomic composites, bounded concurrency)

## Status

Accepted.

## Context

Web research (2026) on optimizing autonomous agent loops surfaced three
high-leverage, low-risk wins that map directly onto `agent-loop`'s architecture:

1. **Context/loop cost** — every phase result in `execute-phases.ts` is re-fed to
   the LLM each iteration and re-billed on every turn (AI University; fast.io).
   Independent phases are currently executed strictly sequentially, so a 5-phase
   run always pays 5 serial round-trips even when phases share no data.
2. **LLM-call reduction via meta-tools** — bundling recurring phase-sequences into
   a single composite unit cuts LLM calls up to 11.9% and *raises* task success
   (arXiv 2601.22037, AWO). `plan-executor.ts` already maps tasks → `PhaseDef[]`,
   so a composite is a natural extension of that mapping.
3. **Concurrency headroom** — `LoopOrchestrator` (`src/orchestrator.ts`) can spawn
   many concurrent child loops, but nothing bounds how many run at once. Under
   load they thrash shared resources (budget, collision detection) with no
   back-pressure. Research (orchestration-playbook; chaitanyaprabuddha) recommends
   a configured cap, clamped by live budget state, with queue-and-pause back-pressure.

The project already has crash recovery (`checkpoint.ts`), a daily budget guard
(`budget.ts`), and priority collision detection (`collision.ts`) — this ADR adds
throughput without disturbing those.

## Decision

### A. Parallel independent phases (explicit DAG)

`PhaseDef` gains a `dependsOn: string[]` field. `execute-phases.ts` topologically
sorts the phase list into layers; phases within a layer run concurrently via
`Promise.all`. Phases with no `dependsOn` (or empty) default to **sequential, in
declared order** — preserving today's behavior for existing plans.

- **Layer failure semantics:** if any phase in a concurrent layer fails, the
  layer's remaining in-flight siblings are **aborted immediately** (AbortController).
  This matches the project's safety-first L1/L2 posture (no partial side-effects).
  Completed phases in the layer are checkpointed; the run proceeds to the
  failure/heal path.
- New module `src/phase-graph.ts` owns the topo-sort + layering (kept out of
  `execute-phases.ts` per ADR-0004's "one responsibility per module" spirit).

### B. Atomic composites (manual, plan-authored)

A `.plan.yaml` may declare a `composites:` block — named, reusable phase
sequences. A task references one via `use: <name>`. In `plan-executor.ts`'s
`beforeLoop`, a composite flagged `atomic: true` is inlined as a **single
`PhaseDef`** with one combined shell command and **one LLM evaluation** for the
whole sequence (realizing the research's LLM-call reduction). Non-atomic
composites expand to their sub-phases (DRY authoring only).

- `CompositeDef` and the `use` reference live in `types.ts`.
- `PLAN-WRITING-GUIDE.md` documents the `composites:` / `atomic:` syntax.

### C. Bounded orchestrator concurrency (cap + budget clamp + pause/queue)

`LoopOrchestrator` gains a semaphore sized by `maxConcurrentLoops` (config key +
`_loops.yaml` field, default 4). The *effective* concurrency is
`min(maxConcurrentLoops, maxByBudget)` where
`maxByBudget = floor((dailyCap - used) / avgCostPerLoop)` (avgCostPerLoop a
configurable estimate; budget state read from `budget.ts`).

- When effective headroom is 0, pending child loops are **paused and queued**, not
  dropped; they resume when budget recovers or cap is raised.
- `collision.ts` priority still governs *which* queued loop runs next (high-priority
  preempts). The semaphore only bounds *how many*, not *which*.

## Rationale

| Concern | Chosen | Rejected because |
|---------|--------|------------------|
| Phase independence declaration | `dependsOn: string[]` (explicit DAG) | `runMode` flag = coarser, can't express arbitrary DAGs; auto-detect from `produces`/`consumes` = fragile silent mis-ordering |
| Layer failure | abort siblings immediately | let-finish = risks partial side-effects under L2; conflicts with safety-first posture |
| Composite model | atomic single `PhaseDef` + 1 eval | reuse-macro only = no LLM-call reduction (the whole point of the research) |
| Concurrency bound | config cap **clamped by budget** | config-only = ignores live spend; budget-only = volatile thrash as budget burns |
| Budget exhaustion | pause + queue | drop/skip = loses work, needs external re-trigger |

## Consequences

- **New/changed files**
  - `src/types.ts` — `PhaseDef.dependsOn`, `CompositeDef`, `use` reference
  - `src/phase-graph.ts` — new: topo-sort + layering
  - `src/execute-phases.ts` — layer-aware concurrent execution + abort-on-fail
  - `src/plan-executor.ts` — composite expansion (atomic + non-atomic)
  - `src/orchestrator.ts` — semaphore, budget clamp, pause/queue
  - `src/budget.ts` — expose remaining-budget helper for the clamp
  - `PLAN-WRITING-GUIDE.md` — `composites:` / `atomic:` docs
  - `_loops.yaml` — `maxConcurrentLoops` schema (optional, default 4)
- **Behavior preserved:** plans without `dependsOn`/composites run exactly as
  today (sequential, per-phase eval). Standalone `start` mode unchanged; only
  daemon/orchestrator child-loop scheduling is affected by C.
- **Tests:** new `__tests__/phase-graph.test.ts`, extended `execute-phases.test.ts`
  (concurrent layer + abort), `plan-executor.test.ts` (composite expansion),
  `orchestrator.test.ts` (semaphore + budget clamp + queue). Existing ~485 tests
  stay green.
- **No new npm dependencies.** Bun-only, zero build step preserved.

## Compliance with existing constraints

- **No loop-runner.ts / loop.ts / cli.ts changes** ✅ — execution changes live in
  `execute-phases.ts` + new `phase-graph.ts`; composite mapping in `plan-executor.ts`.
- **Checkpoint contract preserved** ✅ — checkpoints still written per completed
  phase/layer; plan YAML still only mutated on full success.
- **Budget guard intact** ✅ — C *uses* `budget.ts`, does not bypass it.
- **L1/L2 safety** ✅ — abort-on-fail + atomic composites operate within existing
  safety model; implementation happens in git worktrees with a verifier gate.

## Related

- ADR-0004 (execute-phases extraction) — A extends the same module's contract.
- ADR-0012 (feedback controller) — C's budget clamp complements v9's failure policy.
- Research: arXiv 2601.22037 (AWO meta-tools); AI University token-optimization;
  orchestration-playbook circuit-breaker/concurrency patterns.
