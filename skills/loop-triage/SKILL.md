---
name: loop-triage
description: >
  Daily triage of loop state. Reads STATE.md, produces a prioritized report
  via LLM evaluation, and logs the run. Integrates with budget guard
  (LOOP_DAILY_RUN_CAP) and writes to loop-run-log.md.
user_invocable: true
---

# Loop Triage (agent-loop)

You are an expert engineering triage agent for the agent-loop project. Your job is to scan the current loop state and produce a clean, prioritized list of things the loop should consider acting on.

## Trigger

This runs automatically via cron (`0 9 * * *`), configured in `plans/daily-triage-cron.yaml`. The orchestrator loads the cron trigger and runs `plans/daily-triage.yaml` on schedule.

## Plan

The triage is executed by the plan executor at `plans/daily-triage.yaml` with 3 phases:

| Phase | Action | Detail |
|-------|--------|--------|
| `read-state` | `type STATE.md` | Read current loop state into stdout |
| `llm-triage` | `type STATE.md` + LLM evaluation | Prompt instructs LLM to read STATE.md content and produce triage report as JSON judgment |
| `write-report` | Append timestamp to `loop-run-log.md` | Records that a triage run occurred |

## Manual invocation

```bash
# Single triage run via plan executor
bun run loop.ts start --plan plans/daily-triage.yaml --max-iterations 1

# With LLM controller and agentmemory
bun run loop.ts start --plan plans/daily-triage.yaml --llm openai,evaluate --memory

# Via daemon with cron
bun run loop.ts daemon --loops-config plans/daily-triage-cron.yaml
```

## Inputs

- `STATE.md` — the current loop state file (the only input; no external sources)
- `AGENTS.md` (Budget section) — daily run caps and kill-switch flags (read before each run)
- `loop-run-log.md` — recent run history (used to check budget consumption)
- `AGENTS.md` (Safety/guardrails section) — binding constraints enforced before triage

## Output

The LLM evaluation produces a judgment with these fields:
- `passed` (boolean) — whether the loop state is healthy
- `reason` (string) — the full triage report in markdown, covering:
  - High-Priority Items (act on these)
  - Watch Items (monitor, do not act yet)
  - Recent Noise (ignored this run)
- `confidence` (0-1) — confidence in the assessment

The plan executor writes `status`, `durationMs`, and `completedAt` back to `plans/daily-triage.yaml` after each run. Full phase results (including the LLM judgment) are captured in `_agent-loop-output/state.json`.

## Budget guard integration

Before each triage run, the loop checks `AGENTS.md` (Budget section) and `LOOP_DAILY_RUN_CAP`:

- **Runs < 80% of cap** — full triage (L1 report-only by default)
- **Runs >= 80% but < 100%** — report-only mode (no sub-agents, no auto-fix)
- **Runs >= 100%** or `loop-pause-all` is active — exit immediately with a one-line note in STATE.md

The budget status is written to `loop-run-log.md` via `src/run-log.ts`:

```json
{"run_id":"<ISO8601>","pattern":"daily-triage","runs_count":1,"outcome":"pass","timestamp":"...","duration_ms":...}
```

## Rules

- Be brutally concise. The loop and the human reading STATE.md will thank you.
- Only put something in High-Priority if a reasonable engineer would want to know about it today.
- When in doubt, put it in Watch or Noise rather than creating work.
- Never propose architectural overhauls during triage — this skill is for signal, not invention.
- Do NOT read external sources (no GitHub, no CI, no issues) — STATE.md only.
- Respect `AGENTS.md` (Safety/guardrails section) — constraints are binding and override triage priorities.
- Do not edit source code during triage (L1 mode). L2+ requires human approval per AGENTS.md.

## Workflow

```
[Start] → Read AGENTS.md (Safety/guardrails → Budget) → Check budget guard → 
  Read STATE.md → LLM triage evaluation → Log run →
  Update STATE.md footer → [End]
```

## Related files

| File | Purpose |
|------|---------|
| `plans/daily-triage.yaml` | Plan executor YAML (3 phases) |
| `plans/daily-triage-cron.yaml` | Orchestrator loops config (cron: 0 9 * * *) |
| `STATE.md` | Current loop state (read + updated by triage) |
| `loop-run-log.md` | Run history (appended by triage) |
| `AGENTS.md` (Budget section) | Daily caps and kill-switch |
| `AGENTS.md` (Safety/guardrails section) | Binding constraints |
| `_agent-loop-output/state.json` | Full phase results including LLM judgment |
| `src/budget.ts` | Budget guard implementation |
| `src/run-log.ts` | Run log append/read implementation |
