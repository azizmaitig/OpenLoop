# AGENTS.md — agent-loop

This repo is a continuous-loop orchestrator (Bun + TypeScript, v8). Reading this
file is required before any loop work. The vault root `AGENTS.md` does NOT cover
this project — follow the rules here.

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

## Commands (Bun — no build step, TS runs directly)
- `bun run loop.ts start --task demo` — single bounded run
- `bun run loop.ts start --phases scan,analyze`
- `bun run loop.ts daemon --port 3000 --cron "*/5 * * * *" --plan plans/x.yaml`
- `bun run loop.ts init [dir]` — scaffold convention files
- `bun test` — full suite (33 test files, ~438 tests in `__tests__/`)
- No `build`/`compile`: Bun executes `.ts` on the fly. Don't add a transpile step.

## L1 / L2 modes (human gate)
- Start in **L1 report-only**. Read `STATE.md` before, update it after every run.
- Do NOT edit source until the human explicitly enables L2.
- L2 implementer runs inside a git worktree; a verifier sub-agent APPROVE/REJECTs.

## Safety / guardrails (binding — see `loop-constraints.md`)
- Never push / merge / close issues or PRs without human approval.
- Never touch `.env`, `.env.*`, `auth/`, `payments/`, `secrets/`, `credentials/`,
  or infra configs without approval.
- Max 3 fix attempts per item; escalate after.
- If token spend hits 80% of daily cap → switch to report-only (`loop-pause-all`
  label = exit immediately).
- Use a git worktree for every code-changing attempt; discard after REJECT.

## Plans (`.plan.yaml`)
- Before authoring any plan under `plans/`, read `PLAN-WRITING-GUIDE.md`.
- A plan missing `read-state`, a real `command` on LLM tasks, absolute paths, a
  verify/build final task, or bundling unrelated fixes is WRONG.
- One concern per plan. L1 = report-only; never edit source until L2 enabled.

## Daemon HTTP API
- If `LOOP_API_KEY` is set, requests need `Authorization: Bearer <key>`.
  No key configured = open access (localhost only). Don't expose the port.
