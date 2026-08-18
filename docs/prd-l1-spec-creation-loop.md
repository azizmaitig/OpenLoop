# PRD: L1 spec-creation loop — intake, speckit execution, and two-loop pipeline

> **Status:** Draft — intended for `azizmaitig/Loop` issue tracker, but GitHub auth unavailable on this machine.
> **Created:** 2026-07-19
> **Labels:** `ready-for-agent`
> **Related:** ADR-0018, `spec-creator.yaml`, `12e2b00`

## Problem Statement

The L1 (spec-creation) loop's `draft-increment` task in `spec-creator.yaml` was a `Write-Host` placeholder — it could not actually produce spec checkpoints. Separately, a daemon autonomy bug (cron `unref` + space-path spawn) prevented the two-loop topology from running unattended: L1's cron wouldn't survive more than one tick, and L2's `watchDir` trigger spawned commands with fragmented paths. Together these blocked the spec-factory prototype from reaching autonomous two-loop operation.

Without a working L1, the entire parallel two-loop pipeline (L1 drafts N+1 while L2 builds N) is non-functional: L2 is wired and tested but has no specs to build.

## Solution

Replace the placeholder with a real idea intake + speckit execution pipeline that respects the locked design constraints (no engine edits, no spec-factory edits, filesystem handoff, Issue 6 pacing). The daemon autonomy bugs are fixed in a separate branch and need to be merged.

The L1 loop now:
1. Reads one human-authored idea line from `specs/ideas/inbox.md` (filesystem inbox, one per cron cycle)
2. Runs three `opencode run` calls — `/speckit.specify <idea>`, `/speckit.plan`, `/speckit.tasks` — from the spec-factory workspace CWD
3. Verifies an `evolve-N.md` checkpoint appeared in the specs workspace (artifact guard)
4. The existing `verify-draft` task confirms at most one unconsumed evolve-N exists (Issue 6 pacing)

Idle contract: empty inbox or blocked gate → exit 0, no false failures.

## User Stories

1. As a developer running the spec-factory prototype, I want L1 to read my one-line idea from an inbox file, so that human intent feeds the spec pipeline without manual intervention at cron time.
2. As a developer, I want L1 to run the full speckit chain (`/speckit.specify` → `/speckit.plan` → `/speckit.tasks`) autonomously, so that `evolve-N.md` checkpoints appear in the specs workspace without me typing each command.
3. As a developer, I want L1 to draft exactly ONE `evolve-N` per cron cycle and respect the lease/pacing gate (no N+1 until L2 has claimed or built N), so that the Issue 6 pacing invariant holds and we never get two unconsumed checkpoints.
4. As a developer, I want L1 to idle cleanly (exit 0, no checkpoint produced) when the inbox is empty or the gate is blocked, so that the daemon does not register "nothing to do" as a failure.
5. As a developer, I want L1 to fail loudly (non-zero exit) when the speckit chain crashes or produces no artifact, so that silent no-ops are caught.
6. As a developer, I want the two daemons (L1 port 3001, L2 port 3002) to survive cron ticks and file-watch events without leaking process handles or fragmenting space-containing paths, so that the two-loop topology runs unattended.
7. As a developer, I want L2's `watchDir` trigger to pick up a new `evolve-N.md` from the specs workspace, claim it via lease, build it in a git worktree via `/speckit.implement`, and stamp `built-N`, so that the parallel pipeline (L1 drafts N+1 while L2 builds N) operates end-to-end.
8. As a developer, I want the L1→L2 handoff fully wired, so that I can drop a one-line idea in the inbox and eventually get working code in a worktree, without any manual step between.

## Implementation Decisions

- **L1 exec model**: Three sequential `opencode run` calls, each the exact command a human types in the manual flow. No `; then` chaining. No `--dir` flag (PLAN-WRITING-GUIDE P2: `opencode run --dir "<space-path>"` crashes).
- **CWD isolation**: The PowerShell helper script `Push-Location`s into the spec-factory workspace so `.opencode/commands/speckit.*` and `.specify/` resolve from CWD. This works regardless of where the engine launched from (agent-loop root).
- **Idea intake**: `specs/ideas/inbox.md`, one non-empty line per idea. L1 consumes the top line per cron cycle and removes it from the file so it is not re-drafted. Human-authored only.
- **Opencode resolution**: Binary resolved from PATH first, with documented fallback to `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`.
- **Artifact guard**: After the speckit chain, the script checks for any `evolve-*.md` in the specs workspace. If none found, exits 1 — catches silent no-ops even if `opencode run` exited 0.
- **Idle contract**: Empty inbox / blocked gate → exit 0, no checkpoint produced, no false failure.
- **Two-daemon topology**: L1 (port 3001, cron `*/15`) drives `spec-creator.yaml`; L2 (port 3002, `watchDir`) drives `spec-executor.yaml`. NOT one `_loops.yaml` (ADR-0001 Amendment — engine v8 module-level globals require isolation).
- **Daemon autonomy fix**: Merged from `fix/daemon-autonomy-bugs` worktree (commit `d171609`). Fixes: cron setInterval `unref()` removed so the process keeps running; `tokenizeCommand` in `task-processor.ts` replaced string-split with proper argv handling so space-containing paths survive .ps1 spawn.

## Testing Decisions

- **Single seam**: Contract tests on the two PowerShell helper scripts (`l1-read-inbox.ps1`, `l1-draft-increment.ps1`) via a recorder stub for the `opencode` binary. The stub captures argv without running a real LLM.
- **Prior art**: `bug2-space-path.test.ts` (spawn+spy pattern), `loop-plan.test.ts` (config parsing).
- **What is tested** (6 tests, all passing): idle with no idea file, three separate `opencode run` calls with correct command arguments, no `--dir` passed, missing CLI fails fast, read-inbox peels top line and preserves the rest, empty/missing inbox exits 0.
- **What is NOT tested by automation**: Live `opencode run` execution (requires real LLM — manual verification only). L1→L2 end-to-end pipeline (requires two running daemons — covered by manual integration run).
- **A good test** verifies external behavior through the public interface (the PowerShell script's exit code and side effects), not implementation details. The stub tests verify the shell-out contract — what commands the script issues — without needing a real LLM.

## Out of Scope

- **`agent-loop/src/` edits**: The engine is locked. No changes to triggers, task-processor, daemon, or any TypeScript module in `src/`.
- **`spec-factory/` content edits**: The prototype's `.opencode/commands/speckit.*`, `.specify/`, `CONTEXT.md`, and `specs/` are locked reference deliverables.
- **ADR-0017 CommandRunner refactoring**: The handoff identified this as deferred. Low priority vs L1 wiring and daemon autonomy.
- **Formal L1→L2 integration test**: The two-daemon topology requires running daemons, which requires the daemon autonomy fix to be merged. Covered by manual end-to-end run.
- **Collision rule implementation**: The PRD acceptance criteria mention collision escalation (two L2 scans claiming same N). Not yet implemented — deferred.
- **Mode 1 (full) speckit flow**: Only Mode 2 (minimal = one-line idea → automated manual flow) is wired. Mode 1 (full `constitution → specify → plan → tasks`) is deferred.
- **Choosing the concrete throwaway product**: ADR-0002's open slot (Q3=b) remains unfilled.

## Further Notes

- This PRD covers the spec-factory prototype's L1 wiring after the `/grill-with-docs` + `/implement` session of 2026-07-19. The daemon autonomy bugs were fixed in a separate worktree session and need to be merged.
- ADR-0018 (`docs/adr/0018-l1-idea-intake-speckit-execution.md`) records the L1 design decisions. The `spec-creator.yaml` plan, two `.ps1` helper scripts, and 6 TDD tests were committed in `12e2b00`.
- The `issue5-run.ps1` launcher starts both daemons as `Start-Process` with separate PIDs. Windows only. Loops remain MANUAL until the daemon autonomy fix is merged.
- The vault root contains spaces (`D:\projects\obsidian\second brain\...`). Every filesystem operation uses `-LiteralPath` / `Join-Path`. The daemon autonomy fix hardened this at the engine level for all future plan commands.
