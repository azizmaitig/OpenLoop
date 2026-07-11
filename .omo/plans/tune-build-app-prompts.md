# Tune build-app-pipeline prompts + fix shell quoting — Work Plan

> Status: DRAFTED, NOT STARTED. Companion to `.omo/plans/heal-wiring-impl.md` (Gap A, now
> CLOSED) and the Gap B truncated smoke run (`.omo/smoke/truncated-run.log`).
> This plan tunes the stage prompts for a real target stack AND fixes the engine
> shell-quoting bug that the smoke run surfaced. Edits `src/shell.ts` (L2) + the plan
> YAML. Requires L2 (already enabled, STATE.md).

## TL;DR (machine)
Two deliverables:
1. **Engine fix (blocks everything on Windows):** `src/shell.ts` double-wraps commands
   in `cmd.exe /d /c "..."`, stripping inner double quotes. Any stage command whose
   `--dir`/path contains spaces (the vault path ALWAYS does: `obsidian\second brain`)
   fails with "Failed to change directory". Fix the quoting so `opencode run "..." --dir
   "<path with spaces>"` survives.
2. **Prompt tuning:** sharpen each stage's `opencode run "..."` body for a concrete stack
   (throwaway Vite React app at `loop-factory/first-test`), add an explicit websearch
   directive to `research`, and document the `{{TARGET_DIR}}` substitution step.

Medium effort, Medium risk (shell.ts is shared by all command execution).

## Smoke-run evidence (Gap B discovery)
Truncated run (`read-state`, `planning`, `research` only) results:
- `read-state` PASS (41ms) — `type STATE.md`, no opencode, no --dir.
- `planning` FAIL (2816ms) — `Error: Failed to change directory to "D:\projects\obsidian\second`
- `research` FAIL (2004ms) — same error.
Reproduced directly: `runCommand('opencode run "echo hi" --dir "D:\...\second brain\..."')`
→ exit 1, same stderr. Direct PowerShell `opencode run "..." --dir "..."` WORKS — so the
bug is the engine's `cmd.exe /c` double-wrap, not opencode or the path itself.

## Root cause
`src/shell.ts` `buildShellArgs` returns `{ cmd: ['cmd.exe','/d','/c', command], shell:false }`.
`command` already contains double-quoted segments (the opencode prompt + `--dir "..."`).
`cmd.exe /c "opencode run "prompt" --dir "path with spaces""` → cmd strips the INNER
quotes → `--dir` receives `D:\projects\obsidian\second` (truncated at the space).

## Scope

### Must have
- **S1 (engine):** fix `buildShellArgs` so commands with embedded quotes/spaces in args
  survive. Options (pick one, document why):
  - (a) Pass the command unquoted to `cmd.exe /d /c` (no outer wrap) — `cmd.exe /d /c <command>`
    where `<command>` is the raw string. Windows cmd treats the post-`/c` token as a single
    unparsed string, preserving inner quotes. MATCHES how direct PowerShell invocation works.
  - (b) Switch to `shell: true` and pass the command as a single string (let Bun/sh handle
    quoting). Risk: cross-platform parsing differences.
  - (c) Use `ChildProcess` with `shell: false` and split args manually (no cmd.exe at all on
    a quoted-arg basis). Most robust but largest change.
  Recommend (a): minimal diff, matches the working direct-invocation behavior.
- **S2 (prompt):** substitute `{{TARGET_DIR}}` for `D:\projects\obsidian\second brain\10-Projects\11-Active\loop-factory\first-test` and sharpen stage prompts:
  - `planning`: anchor on "hello-world Vite + React + TypeScript single-page app" so the spec
    is concrete, not generic.
  - `research`: ADD explicit websearch directive — "Use the websearch tool and web fetch for
    current library docs (React 18/19, Vite 5/6, Bun vs npm). Cite sources in research.md.
    Evidence must come from fetched docs, not memory." This is the MCP-use hook the user asked
    about — confirm the child `opencode run` session inherits vault `opencode.json` MCPs
    (websearch:true, playwright, github) by virtue of `--dir` being inside the vault tree.
  - `design`/`code`/`test`/`review`/`evaluate`/`verify`: keep structure, sharpen MVP scope to
    the throwaway app (counter component, build+test green).
- **S3 (doc):** add a one-line "substitution" note to build-app-pipeline.yaml header pointing
  at the PowerShell `-replace` snippet (already in the header; confirm it produces a valid,
  space-safe run.yaml).

### Must NOT have (guardrails)
- MUST NOT change the heal wiring (Gap A is closed; do not regress it).
- MUST NOT enable the `deploy` stage (human approval required, out of scope).
- MUST NOT alter `verify` as the non-LLM exit-0 gate (R4).
- MUST NOT push/merge without human approval.
- MUST NOT raise `maxRetries` above 3 (AGENTS.md max-3-fix-attempts).

## Preconditions
1. L2 enabled (STATE.md l2_enabled=true — already set this session).
2. `bun test` green before/after (heal-wiring suite + existing).
3. The shell fix MUST be verified against a path-with-spaces command (regression test).

## Verification strategy
- **Engine (S1):** add `__tests__/shell-quoting.test.ts` — assert
  `runCommand('opencode run "x" --dir "C:/path with spaces/app"')` does NOT throw
  "Failed to change directory" (use a harmless echo-arg command, not real opencode, to avoid
  LLM cost; e.g. `cmd.exe /c "echo --dir" "C:/path with spaces"` style probe, or a node script
  that logs argv). Acceptance: command with spaces in a quoted arg survives.
- **Prompt (S2):** re-run the truncated smoke (read-state/planning/research) after S1 — all 3
  must PASS, and research.md must contain web-search-sourced citations.
- **Full smoke (owner-gated):** run the FULL 10-stage pipeline on first-test with
  `--max-iterations 1`; confirm code builds + tests pass + heal retries on a forced failure.
- **Regression:** `bun test` green including heal-wiring + shell-quoting.

## Execution strategy
Wave 1 — S1 (shell fix) + shell-quoting test (independent, blocks S2 verification).
Wave 2 — S2 (prompt sharpening) + S3 (doc note).
Wave 3 — re-run truncated smoke; full smoke owner-gated.

## Todos
- [ ] 1. Fix `src/shell.ts` buildShellArgs quoting for paths-with-spaces (S1)
  Commit: fix(engine): preserve inner quotes in shell command execution
- [ ] 2. Add `__tests__/shell-quoting.test.ts` proving space-in-quoted-arg survives (S1)
  Commit: test(engine): regression for shell quoting with paths containing spaces
- [ ] 3. Substitute + sharpen stage prompts for Vite/React throwaway stack (S2)
  Commit: docs(plan): tune build-app stage prompts for Vite/React, add websearch directive
- [ ] 4. Re-run truncated smoke; confirm planning/research PASS + research cites web (S2/S3)
  Commit: n/a (evidence only) — record in .omo/evidence/
- [ ] F1. bun test green (heal-wiring + shell-quoting + existing)
- [ ] F2. Full 10-stage smoke on first-test PASS (owner-gated, needs go-ahead)

## Success criteria
- `opencode run "..." --dir "<path with spaces>"` executes without "Failed to change
  directory" (engine bug fixed).
- The build-app pipeline runs end-to-end on a real throwaway app; research phase uses
  websearch and cites sources.
- Heal wiring (Gap A) still intact; no regression.

## MCP-use answer (recorded for the user)
The loop CAN use MCPs (websearch, playwright, github) in the research (and any) phase:
`opencode run` spawns a child session that inherits the vault `opencode.json` MCP servers
because `--dir` points inside the vault tree. websearch is `tools.websearch:true` there.
Two blockers were found: (1) the shell-quoting bug prevents any `--dir` stage from starting
(fixed by S1); (2) the research prompt does not explicitly request websearch — S2 adds that
directive so usage is guaranteed, not discretionary.

(End of file)
