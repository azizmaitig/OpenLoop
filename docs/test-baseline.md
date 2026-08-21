# Test Baseline — agent-loop (v11 track)

> Source of truth for M5 in `docs/l2-readiness-checklist.md`: the known,
> accepted failure set before any v11 agent run. A run must not exceed this
> baseline — anything new is a regression.

## Baseline (verified 2026-08-20, session T6)

| Metric | Value | Notes |
|--------|-------|-------|
| Targeted tests (v11 changes) | 83/83 pass | T6-specific: worktree-manager, executor threading, loop-core lifecycle |
| Full suite | 716 pass (693 + 23 new) | exact baseline across 2 runs |
| Expected failures | 17 fail | pre-existing, environmental |
| Environment errors | 4 errors | pre-existing, environmental |
| Typecheck | 3 pre-existing | zero new |

## Acceptance rule

- New regression (pass count drops, new fail/error appears) → **STOP**, report
  before any further L2 run.
- Baseline drift must be recorded here with date + evidence before it is
  accepted.

---

*Last updated: 2026-08-20 (T6 verification, carried into T7).*