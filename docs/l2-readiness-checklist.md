# L2 Readiness Checklist

> **Source of truth** for the "No auto-fix until L2 checklist complete" mandate
> (AGENTS.md → Human gates). v11 (ADR-0024, D5): before the loop may spawn a
> `type: agent` task, the plan YAML must declare `l2.checklist: done`
> (human-written). This document defines what "done" means. The mechanical
> checks are executable via [`scripts/check-l2-readiness.ps1`](../scripts/check-l2-readiness.ps1);
> the human ticks below are judgment calls that no script can make for you.

---

## 1. Mechanical checks (script: `scripts/check-l2-readiness.ps1`)

These are machine-checkable prerequisites. The script reports PASS/FAIL per
check and exits non-zero when a blocking check fails. It never prints secrets —
only booleans and presence reports.

| # | Check | What proves it | Blocking |
|---|-------|----------------|----------|
| M1 | opencode server up | `GET /api/health` on `opencodeServer.url` (default `http://127.0.0.1:4096`) returns `{healthy: true}` | ✅ |
| M2 | Round-trip proven (smoke test) | create session → `POST /session/{id}/prompt_async` with a trivial prompt → an assistant message is received back on `GET /api/session/{id}/event` → session aborted | ✅ |
| M3 | Target repo is git OR backup confirmed | target dir is a git worktree (`.git` present) **or** a `.bak` backup exists (non-git target, T6 backup path) | ✅ |
| M4 | Working tree clean (git targets) | `git status --porcelain` on the target repo is empty — no uncommitted WIP to corrupt | ✅ |
| M5 | Baseline tests documented | the baseline failure set (current: 17 fail + 4 environment errors) is recorded in `docs/test-baseline.md` and matches `bun test` output | ✅ |
| M6 | Worktree create/discard OK | `POST /experimental/worktree` + `DELETE /experimental/worktree` round-trip on the live server succeeds (isolation path the loop will use) | ✅ |
| M7 | Budget configured | `LOOP_DAILY_RUN_CAP` set (or a budget config present) so the loop can flip to report-only at 80% | ✅ |

> M2/M6 are live checks against the running server. If the server is down,
> the script reports FAIL for M1 (and skips M2/M6 with a clear note) — you
> cannot prove L2 readiness with the agent backend offline.

## 2. Human ticks (not scriptable — sign them yourself)

These are the judgment calls. Each plan that spawns agent tasks must have all
of them true, and the human declares so by writing `l2.checklist: done` in the
plan YAML.

| # | Tick | Meaning |
|---|------|---------|
| H1 | L2 enabled | The human explicitly enables L2 for this run (AGENTS.md: "Do NOT edit source until the human explicitly enables L2"). |
| H2 | Plan scope approved | The plan does one concern, its tasks are the intended ones, and nothing bundled unrelated work. |
| H3 | Constitution verified against prompts | Every `type: agent` prompt in the plan was read and checked against the constitution denylist (no `.env`, `auth/`, `payments/`, `secrets/`, `credentials/`, `.pem`, `.key` references). |
| H4 | 3-attempt cap accepted | The operator accepts the max-3-fix-attempts rule (AGENTS.md Code discipline) for this run. |
| H5 | Notification channel configured | Someone will be notified of run outcomes (Slack / issue / STATE.md High Priority) — silent failures are not acceptable. |

## 3. How to declare the flag

```yaml
# plans/<plan>.yaml — top level, next to planName (NOT per task)
planName: my-agent-plan
l2:
  checklist: done   # ← human-written, after ALL M1-M7 + H1-H5 are true
tasks:
  - id: read-state
    command: type STATE.md
  - id: analyze
    type: agent
    prompt: <agent prompt verified against the constitution (H3)>
  - id: verify
    command: bun test
```

- **Absent** → the executor refuses to spawn the agent task
  (`L2 gate violation … does not declare l2.checklist: done`).
- **Any value other than `done`** → schema violation `invalid-l2-checklist`
  (typo guard: `pending`, `true`, `yes` are all rejected).
- Command-only (L1) plans never spawn agent tasks → they do NOT need the flag.

## 4. When to re-run

Re-run the checklist (script + human ticks) whenever any of these change:

- The opencode server (version, model, port) — M1/M2/M6
- The target repo or its backup state — M3/M4
- The baseline failure set — M5
- Budget/limits — M7
- The plan itself (new agent task, new prompt) — H1-H5

---

*Last updated: 2026-08-20 (T7, v11 D5).*