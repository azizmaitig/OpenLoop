# ADR-0018 — L1 idea intake & speckit execution design (spec-factory)

- **Status:** Accepted
- **Date:** 2026-07-19
- **Supersedes:** drafts in `parallel loops/spec-factory/.scratch/` (reference prototype, not authoritative)
- **Related:** ADR-0001 (parallel N+1/N), ADR-0002 (spec-kit modes), CONTEXT.md (spec-factory ubiquitous language)
- **Scope:** `agent-loop/plans/spec-creator.yaml` — the L1 (spec-creation) plan. No `agent-loop/src/` or `spec-factory/` edits (both locked).

## Context

The L1 `draft-increment` task in `spec-creator.yaml` was a `Write-Host` placeholder. The handoff
identified the blocking open question: **how does L1 receive the user's one-line idea, and how does it
physically run the speckit chain?**

Investigation findings that shaped this decision:

- `speckit.*` are **agent-native slash commands** (`.opencode/commands/speckit.*.md`), not standalone
  CLI binaries. They read `$ARGUMENTS` and write into `specs/<NNN>-<short-name>/`. They are discovered
  by an `opencode` session from the **current working directory**'s `.opencode/commands/`.
- The spec-factory workspace (`parallel loops/spec-factory/`) has `.opencode/commands/speckit.*` and a
  properly `specify init`'d `.specify/` tree, but **no named agent** — commands resolve by CWD.
- The two-daemon topology (issue5-run.ps1) runs `bun run loop.ts daemon` from the **agent-loop** root,
  with `--plan` pointing at `agent-loop/plans/spec-creator.yaml`. So `draft-increment` executes as a
  PowerShell command string *inside the engine's phase executor*, from the agent-loop CWD. To run
  speckit, that command must `Push-Location` into the spec-factory workspace first.
- Locked: handoff = filesystem (no message bus); L1 = spec text only (report-only / L1), never edits
  product source; Issue 6 pacing = exactly ONE `evolve-N` per cron cycle.

## Decision

### 1. Idea intake = filesystem inbox
L1 reads ideas from `parallel loops/spec-factory/specs/ideas/inbox.md`.
- One idea per non-empty line.
- L1 consumes the **top** line per cron cycle (pacing: one evolve per cycle), then removes it from the
  file so it is not re-drafted.
- Human-authored only. L1 never invents topics — preserves its locked spec-text/report-only boundary.

### 2. L1 execution model = three `opencode run` calls with CWD isolation
`draft-increment` shells out (PowerShell) to THREE separate `opencode run` calls, each
the exact command a human types in the manual flow (no `; then` chaining):

```
Push-Location <spec-factory workspace>
opencode run "/speckit.specify <idea>"
opencode run "/speckit.plan"
opencode run "/speckit.tasks"
Pop-Location
```

- **No `--dir` flag:** `opencode run --dir "<space-path>"` crashes with "Failed to change
  directory" (PLAN-WRITING-GUIDE P2). Instead, the script `Push-Location`s into the spec-factory
  workspace so `.opencode/commands/speckit.*` and `.specify/` resolve from the CWD.
- The constitution is respected automatically (speckit.specify loads `.specify/memory/constitution.md`).
- After the chain, the script runs an **artifact guard**: if no `evolve-*.md` was created in the
  specs workspace, it exits 1 (chain ran but produced nothing — caught before `verify-draft`).
- The opencode binary is resolved from PATH first, with a documented fallback to the npm-global
  install (`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`).

### 3. Per-cycle task order in `spec-creator.yaml`
`gate-evolve` (lease/pacing) runs FIRST. If it exits 1, the plan task fails → L1 idles this cycle
(no draft). Only if the gate passes does an `read-inbox` task run; if the inbox is empty, `draft-increment`
idles (exits 0, no evolve written). This keeps Issue 6's "ONE evolve per cycle" invariant.

### 4. Inbox empty / gate blocked → idle, not error
`draft-increment` must exit 0 (and write nothing) when there is no idea to draft, so the daemon does not
treat "nothing to do" as a failure. Only a *real* speckit failure should fail the task.

## Consequences

- **Positive:** No new HTTP server, no new agent definition, no engine changes. Reuses the existing
  `opencode` CLI + the already-installed speckit commands. The inbox is human-editable and observable.
- **Positive:** Pacing + lease gating already enforced by `l1-evolve-gate.ps1`; this ADR only wires the
  *intake* and *execution* halves around it.
- **Negative:** Three `opencode run` calls, each long-running (LLM). `draft-increment` timeout (600000 ms)
  covers all three. Cron cadence (`*/15`) must exceed total chain duration that in practice is 2–10 min.
- **Negative:** Each `opencode run` call creates a NEW session/agent context. The three speckit commands
  do NOT share memory across invocations — they rely on the filesystem (`.specify/feature.json`,
  `specs/<NNN>-<name>/spec.md`) as the handoff. This matches the "handoff = filesystem" invariant.
- **Risk:** opencode binary resolution from PATH depends on the engine's environment. Mitigation: PATH
  is checked first; the npm-global fallback covers the standard install path. If neither resolves, the
  script exits 1 with a clear error message ("Install opencode or pass -Opencode <path>").

## Out of scope (locked)
- Editing `agent-loop/src/`, `spec-factory/` contents, or the daemon engine.
- L2 wiring (already complete and tested).
- The separate daemon-autonomy bug (cron `unref` + space-path spawn) — loops remain MANUAL until fixed.
