# Implement heal wiring — Work Plan (ADR-0011 → real)

> Status: PLANNED, NOT STARTED. This plan turns ADR-0011 (`docs/adr/0011-heal-wiring.md`)
> into a concrete implementation. It edits `src/` — so it requires L2 (source editing)
> enabled in `AGENTS.md` before execution. ADR-0011 itself is spec-only; this plan DOES it.

## TL;DR (machine)
Deliverables: wire `healCommand`/`maxRetries` from `build-app-pipeline.yaml`'s `code`
stage into the engine. Edits: `src/types.ts` (PhaseDef +2 fields), `src/plan-executor.ts`
(beforeLoop maps the 2 fields), `src/execute-phases.ts` (revive post-fail heal/retry
block via `RecoveryStrategy.healAndRetry`). Adds a regression test in `src/` (or
`__tests__/`). NO new behavior for stages without `healCommand`. 4 todos, 2 waves.
Medium effort, Low-Medium risk. Requires L2.

## Scope
### Must have
- Add `healCommand?: string` + `maxRetries?: number` to `PhaseDef` (`src/types.ts:3-12`).
  `PlanYamlTask` already declares them (`:77-78`) — no change there.
- Map `task.healCommand` + `task.maxRetries` in `beforeLoop` (`src/plan-executor.ts:25-38`)
  so a phase carries the config when the YAML provides it.
- Revive the post-fail heal/retry block in `src/execute-phases.ts:104-110`: when
  `phase.healCommand` is present and a `runCommand`/`ctx` is injected, call
  `RecoveryStrategy.healAndRetry(ctx, phase, result, { healCommand, maxRetries })`. On
  `healed: true` continue to next phase; on exhaust → existing `failTerminal` path.
- Add a regression test: a phase with `healCommand` that fails once then heals → ends
  `pass`; a phase whose heal never succeeds → ends `fail` after `maxRetries` attempts.
- Keep `verify` non-LLM hard gate untouched; heal applies ONLY to stages that opt in
  via `healCommand` (today: `code`).

### Must NOT have (guardrails)
- MUST NOT add `healCommand`/`maxRetries` to `verify` or to LLM-judged stages
  (`design-critique`/`review`/`evaluate`) — rail R4 (verify is the exit-0 gate) and
  ADR-0009 (heal is post-execution, command-exit-driven) hold.
- MUST NOT introduce parallel execution (ADR-0002 / CONTEXT.md v8). Heal re-runs are
  sequential.
- MUST NOT change `PhaseDef.llm` shape or the `resolveHardcoded` LLM-verdict contract
  (`loop-runner.ts:120-125` — `passed:false` still does not fail a phase unless command
  exits non-zero).
- MUST NOT modify `build-app-pipeline.yaml` (authored by the prior plan) except to add a
  one-line comment if the owner wants to note the seam is now live (optional, not required).
- MUST NOT push/merge without human approval (AGENTS.md).
- MUST respect AGENTS.md "max 3 fix attempts" — `maxRetries: 3` in the template already
  matches; do not raise it.

## Preconditions
1. **L2 enabled** — this plan edits `src/`. AGENTS.md forbids source edits until L2.
2. **Tests runnable** — `bun test` (package.json `test` script) must pass before/after.
3. No concurrent plan editing the same three files.

## Verification strategy
- Test decision: tests-after. Each edit is small and covered by the new regression test.
- Evidence: `.omo/evidence/task-<N>-heal-wiring.<ext>`
- Validation commands (worker MUST run):
  - Typecheck/build: `bun run build` (or `bunx tsc --noEmit`) — no type errors after
    adding `PhaseDef` fields.
  - Regression test: `bun test src/heal-wiring.test.ts` (or the project's test entry) —
    both scenarios (heal success, heal exhaust) pass.
  - Integration smoke: substitute `{{TARGET_DIR}}` in `build-app-pipeline.yaml`, run
    `bun run loop.ts start --plan <substituted>.yaml --max-iterations 1` and confirm a
    deliberately-broken `code` stage triggers up to 3 heal attempts before failing (or
    heals and continues). This is owner-gated (needs opencode on PATH + L2 + a target dir).
  - Guard check: a stage WITHOUT `healCommand` still fails immediately on non-zero exit
    (no behavior change for existing plans).

## Execution strategy
### Parallel execution waves
Wave 1 — types.ts field + plan-executor mapping (independent, small).
Wave 2 — execute-phases revival + regression test.

### Dependency matrix
| Todo | Depends on | Blocks | Parallel with |
| --- | --- | --- | --- |
| 1 add PhaseDef heal fields | — | 2 | — |
| 2 map fields in beforeLoop | 1 | 3 | — |
| 3 revive heal block in execute-phases | 2 | 4 | — |
| 4 add regression test + run suite | 3 | F1-F2 | — |

## Todos
- [ ] 1. Add `healCommand?` + `maxRetries?` to `PhaseDef` in `src/types.ts:3-12`
  What to do: insert the two optional fields after `pluginHooks?: string[]`. No change to
  `PlanYamlTask` (already has them). Run typecheck.
  Must NOT do: change `PlanYamlTask`; change `PhaseDef` runtime behavior elsewhere.
  Acceptance: `bunx tsc --noEmit` clean; `PhaseDef` now has healCommand/maxRetries optional.
  Commit: Y | feat(engine): add healCommand/maxRetries to PhaseDef
  Evidence: .omo/evidence/task-1-heal-wiring.md

- [ ] 2. Map heal fields in `beforeLoop` (`src/plan-executor.ts:25-38`)
  What to do: inside the `doc.tasks.map(...)` that builds `phases`, add
  `healCommand: task.healCommand, maxRetries: task.maxRetries,`. Confirm a phase now carries
  them when the YAML sets them.
  Must NOT do: change field names; add mapping for fields not in PlanYamlTask.
  Acceptance: unit check — parse a YAML with `code.healCommand` + `maxRetries:3`, call
  `beforeLoop`, assert the returned phase has `healCommand` and `maxRetries===3`.
  Commit: Y | feat(engine): map healCommand/maxRetries in plan-executor beforeLoop
  Evidence: .omo/evidence/task-2-heal-wiring.md

- [ ] 3. Revive post-fail heal/retry block in `src/execute-phases.ts:104-110`
  What to do: replace the dead-code comment with a real post-fail branch:
  `if (result.exitCode !== 0 && phase.healCommand && ctx.runCommand) { const { healed } =
  await RecoveryStrategy.healAndRetry(ctx, phase, result, { healCommand: phase.healCommand,
  maxRetries: phase.maxRetries ?? 1 }); if (healed) { /* continue */ } else { /* existing
  failTerminal path */ } }`. `RecoveryStrategy.healAndRetry` already exists in recovery.ts
  (no change there).
  Must NOT do: attach an `llm` block; change the verify gate; add parallelism.
  Acceptance: the branch is reached only when `phase.healCommand` is set; non-heal stages
  behave exactly as before (fail on non-zero exit).
  Commit: Y | feat(engine): revive heal/retry block via RecoveryStrategy.healAndRetry
  Evidence: .omo/evidence/task-3-heal-wiring.md

- [ ] 4. Add regression test + run full suite
  What to do: add `__tests__/heal-wiring.test.ts` (or equivalent) covering (a) phase with
  healCommand that fails once then heals → ends `pass`; (b) heal never succeeds → ends
  `fail` after `maxRetries` attempts; (c) phase WITHOUT healCommand fails immediately on
  non-zero exit (no behavior change). Run `bun test`.
  Must NOT do: mock away the real retry loop; skip the no-heal regression.
  Acceptance: `bun test` green; all 3 scenarios pass.
  Commit: Y | test(engine): regression tests for heal/retry wiring
  Evidence: .omo/evidence/task-4-heal-wiring.md

## Final verification wave
- [ ] F1. Type-check + build clean (`bunx tsc --noEmit` / `bun run build`).
- [ ] F2. `bun test` green, including the 3 heal scenarios; no pre-existing failures
  introduced.
- [ ] F3. Scope audit: only `src/types.ts`, `src/plan-executor.ts`, `src/execute-phases.ts`,
  and the new test file changed; `verify`/LLM stages untouched; no new parallelism.
- [ ] F4. Integration smoke (owner-gated): substituted `build-app-pipeline.yaml` run shows
  `code` heal attempts on a forced failure.

## Commit strategy
Conventional commits per todo. No squashed commit.

## Success criteria
- `PhaseDef` carries `healCommand?`/`maxRetries?`; `beforeLoop` maps them.
- A `code` stage failure in `build-app-pipeline.yaml` triggers up to 3 heal attempts
  before failing; on successful heal the pipeline continues.
- Stages without `healCommand` are unchanged.
- Regression tests pass; build/typecheck clean.

(End of file)
