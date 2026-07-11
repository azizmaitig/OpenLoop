# Work Plan — Unify `ExecutionResult` (RC-1)

**Project**: agent-loop (D:\projects\obsidian\second brain\10-Projects\11-Active\agent-loop)
**Source**: `/improve-codebase-architecture` review → RC-1, grilled via `/grill-with-docs`.
**Scope**: Medium (B) — one shared `ExecutionResult` base extended by `PhaseResult` and `Task`.

---

## Decision record (from grilling)

| Fork | Decision |
|------|----------|
| Scope | B — shared `ExecutionResult` base, `PhaseResult` + `Task` extend it |
| 2a | Two distinct status enums: `OutcomeStatus` (outcome) vs `TaskStatus` (lifecycle) |
| 2b | Minimal base: exactly the 5 shared fields; `error` stays on `Task` only |
| Task layout | `Task.result?: ExecutionResult` (nested, clean seam) |
| 3a | Slim `CheckpointEntry { status, durationMs, exitCode }` — honest slim type |
| 3b | Delete orphan `state.json` + its (non-existent) writer |
| 3c | Phase-ordering (`Record` vs array) deferred to separate pass |
| 4a | Nest `Task.result?` (A) — full churn, one seam |
| 4b | TDD — fix test factories FIRST, then production |
| 4c | No ADR; add `ExecutionResult` to `CONTEXT.md` glossary |

---

## Target types (src/types.ts)

```typescript
export type OutcomeStatus = 'pass' | 'fail' | 'error';

export interface ExecutionResult {
  status: OutcomeStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// PhaseResult extends the shared outcome
export interface PhaseResult extends ExecutionResult {
  evidencePath: string;
  judgment?: Judgment;
  pluginResults?: Record<string, any>;
}

// Task keeps its own lifecycle enum; outcome nested under result?
export interface Task {
  id: string;
  command: string;
  lifecycle: TaskStatus;          // was: status
  result?: ExecutionResult;       // was: exitCode/stdout/stderr/durationMs inline
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutMs?: number;
  error?: string;
  llm?: { mcpServer: string; tool: string; prompt: string };
}

// Slim checkpoint entry — intentionally NOT a full ExecutionResult
export interface CheckpointEntry {
  status: OutcomeStatus;
  durationMs: number;
  exitCode: number;
}
// CheckpointState.results: Record<string, CheckpointEntry>
```

`LoopState.phaseResults` stays `Record<string, PhaseResult>` (ordering = separate pass).

---

## Tasks (atomic, ordered)

### T1 — types.ts: add shared types
- Add `OutcomeStatus`, `ExecutionResult`, `CheckpointEntry`.
- Change `PhaseResult` to `extends ExecutionResult` (keep `evidencePath`/`judgment?`/`pluginResults?`).
- Change `Task.status` → `Task.lifecycle: TaskStatus`; move `exitCode/stdout/stderr/durationMs` into `result?`.
- Change `CheckpointState.results` to `Record<string, CheckpointEntry>` (status typed `OutcomeStatus`).

### T2 — Fix test factories FIRST (TDD gate)
File: `__tests__/execute-phases.test.ts`
- `makePhase`: remove phantom `evalPrompt`/`evalModel` (lines 13-14).
- `makeConfig`: remove phantom `mode` (line 23); `planPath` already valid.
- `makeState`: `currentState: 'idle'` → `'init'` (valid `StateMachineState`).
- Any other test file referencing `Task.status` / `task.exitCode` etc. updated after T3-T4 reveal sites.
- These won't fully compile until T1 lands, but must be correct against the new types.

### T3 — src/task-processor.ts: build `Task` with `result?`
- Where a command result is captured, set `result: { status, exitCode, stdout, stderr, durationMs }` and `lifecycle` instead of top-level `exitCode/stdout/stderr/durationMs` + `status`.

### T4 — Migrate all `Task` read/write sites (from explore blast-radius map)
- `src/task-queue.ts`, `src/history.ts`, `src/routes.ts`, `src/orchestrator.ts`: change `task.exitCode` → `task.result?.exitCode` (and stdout/stderr/durationMs similarly); `task.status` → `task.lifecycle`.
- Every `Task` construction literal updated.

### T5 — src/checkpoint.ts: write `CheckpointEntry`
- Replace inline `{ status: string, durationMs, exitCode }` object builds with typed `CheckpointEntry` (status typed `OutcomeStatus`).

### T6 — Delete `state.json`
- Confirm no `src/` reference (grep `state.json`); delete the orphan file under `_agent-loop-output/`.
- If any writer exists, remove it.

### T7 — CONTEXT.md glossary
- Add term: **`ExecutionResult`** — the canonical shape for "the outcome of running a command" (status/exitCode/stdout/stderr/durationMs). Extended by `PhaseResult` (loop phases) and nested in `Task.result` (daemon queue). Distinct from `TaskStatus` (queue lifecycle).
- No ADR (routine consolidation).

### T8 — Verify
- `bun test __tests__/` — all 438+ pass.
- `bun run loop.ts start --task demo` smoke (if quick).
- `lsp_diagnostics` clean on changed files.

---

## Out of scope (separate passes)
- RC-2 retry/heal seam (heal block is dead code)
- RC-3 transition-effects testability
- RC-4 DaemonAPI narrowing
- RC-5 runIntervalTick extraction
- RC-6 plan-executor globals
- LoopState.phaseResults ordering (Record → ordered)

## Risks
- **T4 churn**: many sites; explore map must be exhaustive. If a site is missed, `bun test` catches it (type error).
- **`Task` is widely used in daemon tests**: those factories also need `lifecycle` + `result?` shape. T2 covers execute-phases; daemon/task-queue/orchestrator test factories covered in T4.
