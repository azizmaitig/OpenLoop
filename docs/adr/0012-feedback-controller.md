# 0012 — v9 Feedback Controller (self-healing between output and input)

## Status

Proposed for v9. Supersedes the simple `healCommand`/`maxRetries` seam specified in
ADR-0011 (which has since been implemented as the current `RecoveryStrategy.healAndRetry`
core at `src/recovery.ts:108-130`).

## Context

The loop today heals with a *dumb* core: on non-zero exit, run `healCommand` up to
`maxRetries` times and re-run the phase. It has **no failure classification, no backoff,
no evidence persistence, and no daemon failure-hook integration**. The production-techniques
audit (T7/T9) and the three forked engine-fix test sessions surfaced the concrete pain:

- **F1** — `cmd.exe /c` strips embedded quotes, so any `--dir` path with spaces (the vault
  path always contains `obsidian\second brain`) breaks every stage. The heal re-run inherits
  the same broken command.
- **F2** — child `opencode run` sessions nondeterministically fail with
  `"Console Go: Request model does not match the authorized model"` when they fall back to an
  unauthorized default model. No classification distinguishes this from a real code error.
- **F3** — `RecoveryStrategy.healAndRetry` was dead code until v8; the audit confirms it is
  now live (`execute-phases.ts:108-119`).
- **F4** — the daemon passes `onPhaseFailed: () => {}`, silently disabling failure hooks in
  daemon mode. The heal path is the *only* failure surface, so daemon failures are invisible.
- **T7** — `PhaseResult.evidencePath` is defined but always `''` (dead field).
- **T9** — no error categorization (transient vs terminal), no backoff.

We want an "ultimate self-healing system between output and input": a seam that sits
between a phase's **output** (`PhaseResult`: exitCode, stdout, stderr, evidence) and the
next phase's **input** (the `.build/*.md` file it reads), and that *classifies, heals,
sanitizes, and validates* the handoff.

## Decision

Introduce a **Feedback Controller** that *replaces* `RecoveryStrategy.healAndRetry` as the
engine's heal primitive. The mechanism is **core** (always present); the **LLM judge is
activated per-plan** via a new `feedbackController: true` flag on the plan YAML. This
reconciles the user's two fork choices ("per-plan opt-in plugin" + "replace healAndRetry
core"): the *capability* is core, the *LLM classification activation* is opt-in.

### Architecture

```
phase N output → PhaseResult {exitCode, stdout, stderr, evidencePath}
                        │
                        ▼
        ┌─────────────────────────────────────┐
        │         Feedback Controller          │  (replaces healAndRetry)
        │  1. run guard (budget/pause/safety)  │
        │  2. if fail: capture evidence (T7)   │
        │  3. classify:                        │
        │       - signature check (F1/F2 known │
        │         patterns → transient/terminal)│
        │       - IF plan.feedbackController:   │
        │           LLM judge → structured obj │
        │  4. deterministic policy decides:    │
        │       - transient → heal + backoff   │
        │         (1s→2s→4s→cap30s, jitter)    │
        │         re-inject failure ctx        │
        │       - terminal → failTerminal +    │
        │         broadcast (fixes F4)         │
        │  5. sanitize + validate .build handoff│
        └─────────────────────────────────────┘
                        │
                        ▼
        phase N+1 input ← .build/*.md
```

### LLM judge contract (when activated)

The judge returns a **structured object**, never free text:

```ts
interface FeedbackClassification {
  category: 'pass' | 'transient' | 'terminal';
  retryable: boolean;
  reason: string;
  healHint: string;   // concrete fix direction for the heal command
}
```

### R4 reconciliation (the key tension)

The project's established principle (CONTEXT.md R4, `loop-runner.ts:120-125`) is
**"LLM verdicts are advisory only; exit-code is authoritative."** An LLM that *controls*
retry/halt would reverse this. Resolution: **the LLM judge classifies (advisory); a
deterministic policy decides the action** by consuming the classification as one input
alongside exit-code and signature. The LLM never unilaterally halts or retries. This
preserves R4 while still using LLM judgment for novel-error categorization.

### Backoff

Exponential backoff with jitter: `delay = min(30000, 1000 * 2^(attempt-1))` + random jitter
±250ms. Handles F1/F2 transient races without hammering.

### Evidence (closes T7)

Every phase attempt **and** every heal attempt writes stdout/stderr to
`_agent-loop-output/evidence/<phase>-<timestamp>.log` and populates `evidencePath` on the
`PhaseResult`. The heal-attempt trail is preserved so a successful retry is debuggable.

### Daemon failure hooks (fixes F4)

The controller owns the failure path, so `onPhaseFailed` is called normally in both
`runLoop()` and `tick()`. The daemon must stop passing `() => {}` and instead route to the
controller's broadcast.

## Consequences

- v9 is a **coherent major version**: controller + F1 (shell-exec hardening) + F2 (model-pin
  pre-flight) + F4 (daemon failure hooks) + T7 (evidencePath) + T4 (maker-checker default-on)
  + structured-spec gap (T1).
- Plans that do NOT set `feedbackController: true` behave exactly as today (dumb core heal).
  This keeps the "ultimate self-healing" bypassable — a deliberate v9 scope boundary, not a
  bug. The audit gap T4 (maker-checker not default-on) stays open until a later default flip.
- `recovery.ts` docstring ("DEFINED, UNWIRED") is corrected — the heal is now live and is
  being replaced, not revived.
- New `src/feedback-controller.ts` module; `RecoveryStrategy.healAndRetry` deprecated and
  removed after migration.

## Trade-offs considered

- **Signature-only classification** (recommended initially) rejected in favor of LLM-judged
  because the user wants richer categorization of novel errors. Cost: added latency +
  nondeterminism on classified failures, mitigated by the deterministic policy gate.
- **Plugin hook (onPhaseError) wrapper** rejected in favor of core replacement because the
  user wants the controller to *own* the failure path (fixes F4 uniformly).

## References

- `src/recovery.ts:108-130` (current healAndRetry — replaced)
- `src/execute-phases.ts:108-119` (current live caller — rerouted to controller)
- `src/shell.ts` (F1 — temp-.cmd quoting fix)
- `docs/adr/0011-heal-wiring.md` (superseded; was spec-only, now implemented then replaced)
- `docs/adr/0009-recovery-guard-separation.md` (guard/recovery seam preserved)
- Audit report `docs/audit-production-techniques.md` (T7/T9 findings)
- Forked engine-fix sessions: F1 (shell quoting), F2 (model entitlement), F4 (daemon silent failure)
