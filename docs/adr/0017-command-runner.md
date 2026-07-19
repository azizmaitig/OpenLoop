# ADR-0017: CommandRunner — unify command-string parsing and dispatch

**Status:** Proposed (design settled, not implemented)

**Context:** agent-loop has at least 5 separate modules that build or parse shell command strings (`task-processor.ts`, `orchestrator.ts`, `llm.ts`, `worktree.ts`, `plan-executor.ts`), using 3 incompatible strategies: (1) `Bun.spawn(argv)` with naive `split(/\s+/)`, (2) `powershell.exe -File` with the same split, (3) `shell.ts:runCommand()` with temp `.cmd` files. ADR-0008 consolidated shell *execution* into `shell.ts`, but the *parsing* (string → argv) and *dispatch* (opencode vs ps1 vs shell) remained duplicated. A `tokenizeCommand()` fix was applied ad-hoc in `task-processor.ts` for Bug 2 — this ADR formalises that function into a proper module.

**Decision:** Extract a `CommandRunner` module with two pure functions:

```ts
interface CommandRunner {
  /** Parse a command string into an argv array, respecting double-quoted
   *  segments so space-containing paths stay intact. Strips wrapping quotes.
   *  Identical behaviour to the existing tokenizeCommand(). Returns string[]. */
  parse(command: string): string[];

  /** Dispatch a parsed argv array to the correct spawn strategy, then
   *  execute. Per-kind timeout defaults:
   *    - opencode:  max(300_000, opts.timeoutMs)
   *    - ps1:       opts.timeoutMs
   *    - shell:     opts.timeoutMs                          */
  dispatch(argv: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
}
```

Key scope decisions (grilled and agreed):
- **parse + dispatch only.** Execution (the actual `Bun.spawn()` call) stays in `shell.ts`. CommandRunner chooses which path (opencode direct spawn, powershell -File, or shell.ts), but does not reimplement I/O.
- **`parse()` returns `string[]`** (not a tagged union). The kind detection is a trivial check on `argv[0]` that `dispatch()` already does internally.
- **Per-kind timeout overrides** for opencode (300s default) vs ps1/shell (caller-provided), matching the existing `task-processor.ts` behaviour.

**Positive consequences:**
- All command-string-to-argv parsing routes through one seam, tested once
- `task-processor.ts`'s 3-way spawn branch (22 lines) collapses to a single `CommandRunner.dispatch()` call
- `llm.ts:callOpenCode()` and `orchestrator.ts` string builders also route through the same seam
- `tokenizeCommand()` graduates from ad-hoc fix to first-class module with tests
- ADR-0008's intent (consolidated spawn path) completed — shell.ts becomes the execution backend, CommandRunner the dispatch frontend

**Negative consequences:**
- One more module in the codebase (but it replaces ~80 LOC of dispersed duplication)
- `llm.ts` PS-string path needs careful adaptation (it builds PowerShell arguments differently)
- Migration requires updating 5 callers across 2-3 incremental steps (low risk, zero behavioural change per step)
