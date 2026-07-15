# AGENTS.md — agent-loop

This repo is a continuous-loop orchestrator (Bun + TypeScript, v8). Reading this
file is required before any loop work. The vault root `AGENTS.md` does NOT cover
this project — follow the rules here.

---

## This is a loop system — by design (read before running anything)

Loops are not a bug risk here — they ARE the architecture, and they **stack**.
An agent debugging "why did it run again?" must know which of these fired:

- **Daemon continuous loop** — `Daemon.runIntervalTick()` (`src/daemon.ts`)
  drives via `setInterval` and forces `maxIterations: Infinity`. It **never
  self-terminates**; only SIGINT/SIGTERM stops it. Treat any `daemon`/`cron` run
  as perpetual — stop it with Ctrl-C, never wait.
- **Bounded run loop** — `runLoop()` (`src/loop-runner.ts`) is capped at
  `maxIterations: 20` by the CLI. Each pass the 4-state FSM decides
  `LOOP` / `COMPLETE` / `FAILED` / `ABORT`. LLM-controller mode can override via MCP.
- **FSM loop-back edge** — the `verify →LOOP→ init` transition
  (`src/state-machine.ts`, applied via `src/transition.ts`) is the explicit loop
  *within* one run. Inspect this first when a run repeats unexpectedly.
- **Concurrent child loops** — `LoopOrchestrator.addChild()` / `startChild()`
  (`src/orchestrator.ts`) run **multiple concurrent child loops** from
  `_loops.yaml` or `--plan --cron`. A daemon can supervise many at once.
- **Auto-heal for-loop** — verify tasks with `healCommand` re-run a fix up to
  `maxRetries` via a `for` loop in `src/execute-phases.ts` (+ `src/recovery.ts`
  feedback controller, v9). Operational retry, NOT an FSM state.
- **Recurring triggers** — `CronTrigger` / `FileWatchTrigger` (`src/triggers.ts`)
  spawn loop runs on schedule/file events — a recurring system even without the
  daemon `setInterval`.
- Crash handlers (uncaughtException / unhandledRejection / SIGINT prompt) set
  state to `ABORT` so it never sticks in `run`.

---

## Commands (Bun — no build step, TS runs directly)

- `bun run loop.ts start --task demo` — single bounded run
- `bun run loop.ts start --phases scan,analyze`
- `bun run loop.ts daemon --port 3000 --cron "*/5 * * * *" --plan plans/x.yaml`
- `bun run loop.ts daemon --loops-config _loops.yaml` — multi-loop orchestration
- `bun run loop.ts init [dir]` — scaffold convention files (`STATE.md`, `AGENTS.md`)
- `bun test` — full suite (~485 tests in `__tests__/`)
- No `build`/`compile`: Bun executes `.ts` on the fly. Don't add a transpile step.

---

## Active loop configuration

| Pattern | Cadence | Status | Command |
|---------|---------|--------|---------|
| Daily Triage | 1d | L1 report-only | `opencode run "Run loop-triage" --agent loop-triage` via systemd (external, not in _loops.yaml) |
| Calendar Design Upscale | weekly (Sun 8:00) | enabled | `bun run loop.ts daemon --loops-config _loops.yaml` |

Configured loops live in `_loops.yaml` — see that file for the full list (calendar-design-upscale). Demo loops (file-watch-demo, cron-demo) are available but disabled.

### Human gates
- No auto-fix until L2 checklist complete.
- All high-risk paths require human review (see Paths denylist below).
- Review STATE.md daily.

### Worktrees
- Use an explicit `git worktree` and run opencode with `--dir <worktree>` for implementer runs (L2+).
- One worktree per fix attempt; discard after verifier REJECT.

### Connectors (MCP)
- MCP optional for L1 report-only loops.
- For L2+: GitHub MCP can read CI/issues; scope connectors to read + comment until trusted.

---

## L1 / L2 modes (human gate)

- Start in **L1 report-only**. Read `STATE.md` before, update it after every run.
- Do NOT edit source until the human explicitly enables L2.
- L2 implementer runs inside a git worktree; a verifier sub-agent APPROVE/REJECTs.

---

## Safety / guardrails (binding)

All agents working in this repo MUST follow these rules. They are non-negotiable.

### Push & Merge
- Don't push before telling the human.
- Never auto-merge to main without human approval.
- Always create a draft PR first; let the human review before marking ready.

### Paths (never edit without approval)
- Never edit `.env`, `.env.*`, `auth/`, `payments/`, `secrets/`, `credentials/`.
- Never edit infrastructure configs without human approval.

### Code discipline
- Always run tests before proposing a fix.
- Never disable tests to make CI green.
- Never refactor unrelated code — one fix per run.
- Max 3 fix attempts per item; escalate after.
- Use a git worktree for every code-changing attempt; discard after REJECT.

### Communication
- Always tell the human what you're about to do before doing it.
- Never close an issue or PR without the human's approval.

### Budget
- If token spend hits 80% of daily cap, switch to report-only.
- If `loop-pause-all` label is active, exit immediately.

---

## Budget (daily limits)

| Loop | Max runs/day | Max tokens/day | Max sub-agent spawns/run |
|------|--------------|----------------|--------------------------|
| Daily Triage | 2 | 100k | 0 (L1) / 2 (L2) |

### On budget exceed
1. Pause schedulers (`scheduler_delete` or disable automations).
2. Append event to `loop-run-log.md`.
3. Notify human (Slack / issue / STATE.md High Priority).

### Kill switch
- Command or issue label: `loop-pause-all`.
- Resume only after human clears the flag in STATE.md.

---

## Plans (`.plan.yaml`)

- Before authoring any plan under `plans/`, read `PLAN-WRITING-GUIDE.md`.
- A plan missing `read-state`, a real `command` on LLM tasks, correct path convention
  (absolute for cross-project, relative for in-loop), a verify/build final task, or
  bundling unrelated fixes is WRONG.
- One concern per plan. L1 = report-only; never edit source until L2 enabled.

---

## Daemon HTTP API

- If `LOOP_API_KEY` is set, requests need `Authorization: Bearer <key>`.
  No key configured = open access (localhost only). Don't expose the port.

---

## Dashboard SPA

- **Source** lives in `dashboard/` (Vite + React TypeScript SPA).
- **Build output** goes to `public/dashboard/` (`vite.config.ts: outDir: '../public/dashboard'`).
- The daemon serves the dashboard from `public/dashboard/` at `/dashboard#/`.
- **Do NOT edit files in `public/dashboard/` directly** — they are build artifacts and will be overwritten.
- After changing `dashboard/src/`, rebuild with: `cd dashboard && bun run build`.
- Tests: `cd dashboard && bun test`.
