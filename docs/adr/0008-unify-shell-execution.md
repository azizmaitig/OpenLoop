# 0008 — Unify shell execution into `src/shell.ts`

## Context

Shell command execution was implemented independently in four files, each with different error handling, platform detection, and safety checks:

| File | Function | Error handling | Platform | Safety |
|------|----------|---------------|----------|--------|
| `src/execute-phases.ts` | `executeShellCommand` | Returns `PhaseResult` with `exitCode`/`stdout`/`stderr` | Hardcoded `cmd.exe` | None |
| `src/worktree.ts` | `exec` | Throws on non-zero exit | `isWindows ? cmd.exe : /bin/sh` | `isSafeCommand` check |
| `src/task-processor.ts` | inline `Bun.spawn` | Returns `SpawnResult` | `Bun.spawn` directly, `.ps1`→`powershell -File` | `isSafeCommand` check |
| `src/orchestrator.ts` | inline `isSafePath` | N/A (safety-only) | N/A | `PATH_UNSAFE_CHARS` regex |

This means:
- A behavior change to shell execution (timeout, platform handling, safety) requires edits in 3-4 places
- Each implementation has minor behavioral differences (one throws, one returns, one uses `cmd.exe` always)
- Safety checks (`isSafeCommand`, `isSafePath`) are duplicated with slightly different regexes

## Decision

Create `src/shell.ts` with a unified interface and three exports:

```typescript
interface RunOptions {
  cwd?: string;
  timeoutMs?: number;       // default 60000
  env?: Record<string, string>;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runCommand(
  command: string,
  opts?: RunOptions
): Promise<RunResult>

// Path traversal check
function isSafePath(path: string): boolean

// Command injection check
function isSafeCommand(command: string): boolean
```

- Platform detection uses `os.platform()` internally
- Timeout via `AbortController` + `executeWithTimeout`
- `runCommand` does NOT throw — wraps errors into `RunResult` with `exitCode: -1`
- `isSafeCommand` and `isSafePath` consolidated from their split implementations

### Refactored consumers

| Consumer | Before | After |
|----------|--------|-------|
| `execute-phases.ts` | `executeShellCommand` (private, 25 LOC) | delegates to `runCommand` |
| `worktree.ts` | `exec` (private, 30 LOC) | delegates to `runCommand` |
| `task-processor.ts` | inline `Bun.spawn` for shell path | `runCommand` for shell, keeps direct for opencode/ps1 |
| `orchestrator.ts` | `PATH_UNSAFE_CHARS` + `isSafePath` | `isSafePath` from `shell.ts` |
| `routes.ts` | `isSafeCommand` imported from `task-processor.ts` | `isSafeCommand` from `shell.ts` |

## Rationale

| Concern | Before | After |
|---------|--------|-------|
| Shell execution LOC | ~90 LOC across 4 files | ~100 LOC in one module |
| Behavioral consistency | 3 different error models (throw, return, catch) | 1 error model |
| Safety checks | 2 regexes in 2 files | 1 source of truth |
| Platform handling | `cmd.exe` hardcoded in one, `isWindows` in another | unified behind `os.platform()` |

Passes the deletion test: removing `runCommand` would force shell execution logic back into 4 callers, not eliminate it.

## Considered Options

- **Keep as-is** — rejected. Every shell-related fix needs 3-4 edits. Already caused bugs (Windows CI .ps1 handling was only fixed in `task-processor.ts`, not propagated).
- **Extract with options bag (Option 1, chosen)** — `runCommand(command, opts?)` with a single `RunOptions` interface. One function, one error model, safety baked in. Highest depth.
- **Extract as a builder class** — discarded. No lifecycle or state to manage. A function with an options bag is strictly simpler and equally testable.
- **Extract as higher-order wrapper** — discarded. Targeting shell execution itself with clear parameters is more straightforward.

## Consequences

- `execute-phases.ts`: removed `executeShellCommand` (25 LOC), imports `runCommand` and `isSafeCommand` from `shell.ts`
- `worktree.ts`: removed `isWindows`, `buildArgs`, `exec` (~30 LOC), imports `runCommand` from `shell.ts`
- `task-processor.ts`: uses `runCommand` for shell path, keeps direct `Bun.spawn` for `.ps1` (must avoid shell wrapping) and opencode (needs special piped-IO handling)
- `orchestrator.ts`: removed `PATH_UNSAFE_CHARS`/`isSafePath` (~10 LOC), imports from `shell.ts`
- `routes.ts`: import source changed from `task-processor.ts` to `shell.ts`
- `shell.ts` is now the single seam for shell execution. Tests and consumers cross this seam.

## Related

- ADR-0004: Shared `executePhases()` — complementary extraction for phase execution
- The `.ps1` → `powershell -File` routing is kept in `task-processor.ts` because it applies to direct `Bun.spawn` (non-shell) path, not the `runCommand` path
