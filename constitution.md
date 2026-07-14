# Constitution — agent-loop

A versioned, machine-enforced set of plan-shape rules. The loop reads
this at plan load (`src/plan-executor.ts` → `src/constitution.ts`,
the pre-flight gate) and refuses to run a plan that violates it.

This is the **spec-kit "constitution" concept, borrowed as a single
enforceable artifact** instead of taking a cross-language dependency on
the external `github/spec-kit` repo. The *idea* (a written,
versioned constitution that gates execution) is high-ROI; the repo
itself is Python/uv, opinionated in ways that fight this loop's
domain, and would add a markdown→YAML translation tax for ~30% of
its value. So: take the concept, drop the dependency.

## Enforced rules (checked by `src/constitution.ts`)

- **read-state-first** — the first task must read `STATE.md`
  (e.g. `type STATE.md`). A run that acts on stale reality is wrong.
- **verify-last** — the final task must be a verification gate
  (build / test / lint / verify) that exits 0. No verify = no proof
  the work held.
- **denylisted-paths** — no task command may reference `.env`,
  `auth/`, `payments/`, `secrets/`, `credentials/`. These are
  binding in `AGENTS.md`; the gate catches them at load, before any
  phase runs.

(Plan-name presence, unique ids, and `dependsOn` validity are
already enforced by the executor. One-concern-per-plan and L1/L2
mode are human-faced and stay in `AGENTS.md` + `PLAN-WRITING-GUIDE.md`.)

## Human-faced rules (not machine-checked)

- One concern per plan. Don't bundle unrelated fixes.
- L1 report-only until a human explicitly enables L2.
- Never push, merge, close issues/PRs, or edit denylisted paths
  without explicit human approval.
- Max 3 fix attempts per item; escalate after.
- Code-changing plans run in a git worktree; a verifier approves
  before merge.

## Amendment

Modifications require: explicit rationale, review by the human, backwards
compatibility assessment. The loop reads the enforced block above;
keep it in sync with `src/constitution.ts` when adding machine-checked
rules.
