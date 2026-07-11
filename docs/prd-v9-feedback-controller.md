# PRD: v9 Feedback Controller (Self-Healing Between Output and Input)

**Status:** Ready for agent (drafted from design grill)
**Author:** Sisyphus (agent) via `/to-prd`
**Depends on:** ADR-0012 (Feedback Controller design)

## Problem Statement

The agent-loop heals failures with a *dumb* core: on non-zero exit it runs `healCommand`
up to `maxRetries` times and re-runs the phase. It has no failure classification, no
backoff, no evidence persistence, and no daemon failure-hook integration. Three forked
engine-fix test sessions and the production-techniques audit exposed the concrete cost:

- Shell quoting on Windows (`cmd.exe /c` strips embedded quotes) breaks every `--dir` stage
  whose path contains spaces — and the heal re-run inherits the same broken command.
- Child `opencode run` sessions nondeterministically fail on model-entitlement mismatch,
  indistinguishable from a real code error.
- The daemon passes `onPhaseFailed: () => {}`, so daemon-mode failures are silently invisible.
- `PhaseResult.evidencePath` is dead — no evidence is ever persisted.
- There is no classification of *why* a phase failed, so every failure is retried identically.

The user wants an "ultimate self-healing system between output and input": a seam that
sits between a phase's **output** (`PhaseResult`) and the next phase's **input**
(`.build/*.md`), and that classifies, heals, sanitizes, and validates the handoff.

## Solution

Replace `RecoveryStrategy.healAndRetry` with a **Feedback Controller** — the engine's
systematic heal primitive. It classifies each failure (signature check + optional LLM
judge), applies a deterministic policy (heal-with-backoff vs terminal-halt), persists
evidence per attempt, and validates the context handoff to the next phase. The mechanism
is core (always present); the LLM judge activates per-plan via `feedbackController: true`.

This closes audit gaps T7 (evidence) and T9 (categorization + backoff), fixes engine bugs
F1 (shell exec), F2 (model-pin preflight), and F4 (daemon failure hooks), and folds in the
remaining v9 scope: maker-checker default-on (T4), and a structured-spec artifact (T1).

## User Stories

1. As a loop operator, I want failures classified as transient vs terminal, so that transient
   errors are retried and terminal errors halt cleanly instead of wasting retries.
2. As a loop operator, I want exponential backoff with jitter between heal retries, so that
   transient races (network, model entitlement) recover without hammering.
3. As a loop operator, I want the LLM judge to classify novel errors only when a plan opts in
   (`feedbackController: true`), so that default behavior stays fast and deterministic.
4. As a loop operator, I want the deterministic policy — not the LLM — to decide the action,
   so that R4 ("LLM verdicts are advisory only") is preserved.
5. As a loop operator, I want every phase attempt and every heal attempt to persist its
   stdout/stderr to `_agent-loop-output/evidence/<phase>-<ts>.log` and populate
   `evidencePath`, so that failures are debuggable after the fact.
6. As a loop operator, I want the daemon to route failures through the controller's broadcast
   (not a no-op `() => {}`), so that daemon-mode failures are visible.
7. As a loop operator, I want a model-pin pre-flight check before each `opencode run` child
   stage, so that model-entitlement mismatches are caught before the stage runs.
8. As a loop operator, I want shell command execution to preserve embedded quotes/spaces on
   Windows, so that `--dir` paths with spaces (e.g. the vault path) work in every stage.
9. As a loop operator, I want maker-checker (adversarial review) enabled by default for L2+
   runs, so that every change gets reviewed without opt-in.
10. As a loop author, I want to express a plan's intent as a structured, machine-parseable
    spec (goal, scope, nonGoals, acceptanceCriteria, techStack), so that a spec-review gate
    can validate it before coding.
11. As a loop operator, I want plans that do NOT set `feedbackController: true` to behave
    exactly as today, so that the upgrade is non-breaking.
12. As a future maintainer, I want the `recovery.ts` docstring corrected (heal is live, not
    "unwired"), so that I am not misled about the current state.

## Implementation Decisions

- **New module `src/feedback-controller.ts`** owns the post-failure path. It replaces
  `RecoveryStrategy.healAndRetry` as the engine's heal primitive.
- **Integration point**: `executePhaseGroup` (execute-phases.ts) reroutes its post-fail
  branch from `RecoveryStrategy.healAndRetry` to `FeedbackController.handle(result, phase,
  ctx)`. The controller internally decides heal vs terminal.
- **Classification**:
  - Signature pass: known transient patterns (ETIMEDOUT, ENOSPC, "model does not match",
    network reset) → `transient`; everything else → `terminal` by default.
  - If `plan.feedbackController` is true: an LLM judge returns the structured contract
    `{ category: 'pass'|'transient'|'terminal', retryable: boolean, reason: string,
    healHint: string }`. The judge is advisory.
- **Deterministic policy**: consumes `(exitCode, signatureClass, llmClass?)` and emits one
  of `{ heal, terminal }`. The LLM classification is one input; it cannot unilaterally halt
  or retry. This preserves R4.
- **Backoff**: `delay = min(30000, 1000 * 2^(attempt-1))` + random jitter ±250ms.
- **Evidence**: every attempt writes to `_agent-loop-output/evidence/<phase>-<ts>.log` and
  sets `result.evidencePath`. The heal-attempt trail is preserved.
- **Shell exec (F1)**: `src/shell.ts` preserves embedded quotes/spaces on Windows (the
  temp-`.cmd` approach validated in the engine-fix sessions).
- **Model-pin pre-flight (F2)**: a `preflight.ts` helper validates the child model against
  authorized providers before spawning; fails fast with a clear message instead of a
  mid-run provider rejection.
- **Daemon (F4)**: `tick()` routes `onPhaseFailed` to the controller's broadcast instead of
  `() => {}`.
- **Maker-checker (T4)**: default `enabled: true` in the plugin registration; L2+ plans get
  adversarial review automatically.
- **Structured spec (T1)**: a `SpecDef` type; the `planning` phase writes a parseable spec;
  a `spec-review` gate validates required fields before `design-critique`.
- **`recovery.ts`**: `healAndRetry` deprecated; removed after migration. Docstring corrected.
- **ADR-0012** records the design + R4 reconciliation.

## Testing Decisions

- **Good test = external behavior, not internals.** Assert on: classification outcome,
  policy decision, backoff timing bounds, evidence file existence, and broadcast calls —
  not on private helper internals.
- **Highest seam**: `executePhaseGroup` with an injected failing phase. Assert dumb-core
  behavior is unchanged when `feedbackController` is absent; with it present, the LLM judge
  is invoked, classification consumed, backoff applied, evidence written.
- **Unit seams** (preferred over new ones):
  - `feedback-controller.ts` pure functions: `classifyBySignature(stderr)`,
    `decidePolicy(exitCode, signatureClass, llmClass?)`, `computeBackoff(attempt)`.
  - `shell.ts`: quoting regression (command with quoted arg containing spaces survives).
  - `preflight.ts`: model-entitlement check returns Reject for an unauthorized model.
- **Prior art**: `__tests__/heal-wiring.test.ts` (3 scenarios: heal-success / heal-exhaust /
  no-heal) is the template — extend it for classification + backoff. The shell-quoting test
  from the engine-fix sessions is the template for F1.
- **Daemon**: a test asserting `tick()` failure routes to broadcast (not swallowed).

## Out of Scope

- Self-advancing pipeline (ADR-0010 StageManager) — separate future change.
- Parallel phase execution (ADR-0002 reaffirms sequential).
- Container/sandbox isolation (T8) — out of v9 scope.
- MCP server discovery / reconnect (T6) — out of v9 scope.
- Making `feedbackController` default-on globally (kept opt-in in v9; audit gap T4 partially
  closed via maker-checker default-on instead).

## Further Notes

- The "ultimate self-healing" is deliberately bypassable: only plans with
  `feedbackController: true` activate the LLM judge. This is a v9 scope boundary, not a
  defect.
- ADR-0011 (heal-wiring spec) is superseded: it was spec-only, got implemented as the
  current `healAndRetry`, and is now replaced by the controller.
- All changes must be made in git worktrees per AGENTS.md; no commit/push without explicit
  human approval.
