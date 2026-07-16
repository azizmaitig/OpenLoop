# 0011 — Wiring healCommand / maxRetries into the engine (implemented)

## Status

**Implemented** (commit `f865f97`+ via ADR-0011 heal seam in `src/execute-phases.ts`).
This ADR originally specified the wiring as a future change. The three surgical edits
described below were applied in a later fix cycle and are now live:

1. `src/types.ts` — `PhaseDef` carries `healCommand?` / `maxRetries?`
2. `src/plan-executor.ts` — `beforeLoop` maps them from YAML
3. `src/execute-phases.ts` — post-fail heal/retry block revived (lines ~332-352)

The heal seam is **exit-code gated only** (no LLM verifier) and runs on the **working
tree** (no git worktree isolation — see `src/recovery.ts` header for the current design).
The `healCommand` is a static YAML string, not LLM-generated.

## Context

ARD-0009 established that the per-phase heal/retry seam was **dead code**:
`execute-phases.ts` read `healCommand`/`maxRetries` off the phase via `as unknown as
Record`, but `PhaseDef` (`src/types.ts:3-12`) had no such fields and `plan-executor.ts`
(`:25-38`) only copied `id`→`name`, `command`, `timeoutMs`, `llm`. So in plan-driven mode
those values were always `undefined` and the `if` never entered. ADR-0009 deleted the dead
block rather than reviving it.

The build-app-pipeline template nonetheless authored `healCommand` + `maxRetries: 3` on
the `code` stage. Until this ADR was implemented, those fields were **no-ops**: a `code`
failure ended the run via the command's non-zero exit, gated only by timeoutMs +
the `--max-iterations` cap.

`src/recovery.ts` already defined `RecoveryStrategy.healAndRetry` (with a `HealConfig`
shape `{ healCommand, maxRetries }`). It had **no live caller** until the ADR was
implemented. The wiring was small — a mapping addition plus re-invoking the block.

## Implementation (three surgical edits)

### 1. `src/types.ts` — add heal fields to `PhaseDef`

```ts
export interface PhaseDef {
  name: string;
  command: string;
  expectedExitCode: number;
  timeoutMs: number;
  llm?: /* existing union */;
  pluginHooks?: string[];
  healCommand?: string;
  maxRetries?: number;
}
```

(`PlanYamlTask` already declared `healCommand?`/`maxRetries?` at `src/types.ts:77-78`.
Only `PhaseDef` needed the addition.)

### 2. `src/plan-executor.ts` — map the fields in `beforeLoop`

Inside the `doc.tasks.map(...)` that builds `phases`:

```ts
healCommand: task.healCommand,
maxRetries: task.maxRetries,
```

so a phase carries the heal config when the YAML provides it.

### 3. `src/execute-phases.ts` — revive the post-fail heal/retry block

A post-fail branch at `:332-352` calls `RecoveryStrategy.healAndRetry` when
`phase.healCommand` is present:

```ts
if (phase.healCommand) {
  const { healed } = await RecoveryStrategy.healAndRetry(
    { taskQueue, broadcast, runCommand: (cmd, timeoutMs) => runCommand(cmd, { timeoutMs }) },
    phase,
    result,
    { healCommand: phase.healCommand, maxRetries: phase.maxRetries ?? 1 },
  );
  if (healed) { /* mark phase passed, continue */ }
}
```

`RecoveryStrategy.healAndRetry` (recovery.ts) implements the loop: run `healCommand`
up to `maxRetries` times, and on heal success re-run `phase.command`; if the re-run
exits 0, mutate `result` to `pass` in place.

### Constraints preserved

- No parallel execution (ADR-0002 / CONTEXT.md v8). Heal re-runs are sequential.
- `verify` remains the non-LLM hard gate; heal only applies to stages that opt in via
  `healCommand`. It does NOT attach an `llm` block or change the exit-code contract.
- Max attempts per the template is `maxRetries: 3`; escalate to `failTerminal` after
  exhaustion — consistent with AGENTS.md "max 3 fix attempts per item."

## Consequences

- The `code` stage's `healCommand`/`maxRetries` are live: a build/test failure triggers
  up to `maxRetries` heal attempts before the run fails, instead of terminating on first
  failure.
- `design-critique` / `review` / `evaluate` LLM `passed:false` still do NOT fail a phase
  unless the command exits non-zero (`loop-runner.ts` resolveHardcoded) — unaffected.

## References

- `src/types.ts` (PhaseDef — has healCommand/maxRetries)
- `src/plan-executor.ts` (beforeLoop — maps the fields from YAML)
- `src/execute-phases.ts:332-352` (post-fail heal/retry block)
- `src/recovery.ts` (`RecoveryStrategy.healAndRetry` + `HealConfig`)
- `src/loop-runner.ts` (resolveHardcoded — LLM passed:false does not fail phase)
- `docs/adr/0009-recovery-guard-separation.md` (heal left unwired, later revived)
