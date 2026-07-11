# agent-loop-arch-cleanup - Work Plan

## TL;DR (For humans)

**What you'll get:** Three targeted architecture cleanups for agent-loop in sequence: (1) extract a clean JSON-RPC transport layer and fix the LLM eval pipeline, (2) simplify state persistence by removing dead code and fixing a stale-state bug, (3) delete two orphan files (daemon-runner.ts + api.ts) and fold their functionality into the proper Daemon class.

**Why this approach:** Ordered by increasing blast radius — each candidate shrinks the codebase and tightens boundaries before touching the next. The JSON-RPC extraction fixes a dynamic-import workaround that was the weakest link in the LLM eval chain. State persistence cleanup is isolated (state.json is dead I/O). Daemon deletion is the last step because it requires all files involved in Candidate 3 and 2 to be settled first.

**What it will NOT do:** NOT change LLM provider logic, NOT change the plugin system, NOT add new features, NOT rename or restructure files outside the specified list, NOT change any YAML/plan-related code, NOT touch the orchestrator or worktree modules, NOT modify any config/env loading logic.

**Effort:** Medium  
**Risk:** Low — each candidate has a confirmed deletion test, existing test suite has 438 tests to catch regressions, and the blast radius of every change was verified.

**Decisions to sanity-check:** (1) json-rpc.ts interface (SpawnedProcess class for reusable, standalone send() for one-shot), (2) maker-checker `typeof === 'boolean'` guard adopted as standard, (3) daemon interval runs in-process tick instead of spawning subprocess per tick, (4) `--daemon` flag redirects to Daemon class not deleted.

Your next move: **Approve** this plan so I can write the full execution plan. Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Low risk — 3 candidates sequenced by increasing blast radius. ~180 LOC new (json-rpc.ts), ~250 LOC deleted (state-writer.ts + daemon-runner.ts + api.ts + dead code). Tests-after strategy with 438 existing tests as regression anchor. 4 waves, 12 todos.

## Scope
### Must have
- Candidate 3: Extract json-rpc.ts, convert dynamic imports to static, dedup maker-checker eval pipeline, remove dead config fields
- Candidate 2: Delete state-writer.ts, fold into state.ts, stop writing state.json, fix stale currentState bug
- Candidate 1: Delete daemon-runner.ts + api.ts, redirect --daemon flag, add interval tick to Daemon class
- Agent-executed QA for every todo: happy path + failure path with evidence captured

### Must NOT have
- No LLM provider logic changes (llm.ts, provider selection, callOpenCode)
- No plugin system changes (plugin-hooks.ts, plugin-loader.ts)
- No trigger module changes (triggers.ts)
- No test refactoring beyond what's needed to match deleted/renamed files
- No new external dependencies
- No feature additions or behavior changes
- No renaming of existing public APIs except `runDaemon` barrel export removal
- No changes to any YAML/plan config format

## Verification strategy
- Test decision: **tests-after** — existing 438-test suite is the regression guard; new tests for json-rpc.ts only
- Build: `bun run build` (or `bun run typecheck`) after each candidate completes
- Test run: `bun test` (or specific test file: `bun test __tests__/json-rpc.test.ts`)
- Lint: `bun run lint` if available
- Evidence: `.omo/evidence/task-<N>-agent-loop-arch-cleanup.txt`

## Execution strategy
### Execution waves
All 3 candidates are **sequential** (each depends on the priors being settled). Within each candidate, tasks can be parallelized where they touch different files.

```
Wave 1: Candidate 3 — LLM eval cleanup (todos 1-4)
Wave 2: Candidate 2 — State persistence cleanup (todos 5-7)
Wave 3: Candidate 1 — Daemon runner deletion (todos 8-11)
Wave 4: Final verification (todos F1-F4)
```

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 (json-rpc.ts) | — | 2, 3 | — |
| 2 (mcp.ts refactor) | 1 | 3 | — |
| 3 (evaluate.ts fix) | 1 | 4 | — |
| 4 (maker-checker cleanup) | 3 | Next candidate | — |
| 5 (fold state-writer into state.ts) | — | 6 | 7 |
| 6 (fix stale currentState) | 5 | 7 | 5 |
| 7 (update consumers) | 5, 6 | Next candidate | 5 |
| 8 (add runIntervalTick to daemon.ts) | — | 9, 10, 11 | — |
| 9 (delete daemon-runner.ts) | 8 | 10 | 8 |
| 10 (delete api.ts) | 8 | 11 | 8 |
| 11 (redirect --daemon flag) | 8, 9, 10 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. Create src/json-rpc.ts — JSON-RPC 2.0 stdio transport module
  What to do / Must NOT do:
    Create `src/json-rpc.ts` with these exports:
    - Types: `JsonRpcRequest`, `JsonRpcSuccess<T>`, `JsonRpcErrorBody`, `JsonRpcError`, `JsonRpcResponse<T>` (discriminated union)
    - Errors: `SpawnError`, `SubprocessError`, `MalformedResponseError` (all `extends Error`)
    - Class: `SpawnedProcess` with constructor(cmd, args, opts?), send\<T\>(request, opts?), close(), kill(), get pid, get running
    - Function: `send\<T\>(cmd, args, request, opts?)` — standalone one-shot wrapper
    - Internal: `buildTransport()`, `writeRequest()`, `readResponse()`, `readLine()` — NOT exported
    - Auto-fill `jsonrpc: '2.0'` and auto-increment numeric `id` in send()
    - Sequential send enforced (single stdin writer + single stdout line reader — NO concurrent send support)
    - Per-request timeout via `AbortSignal` option on send()
    - Uses only `Bun.spawn`, `ReadableStream`, `WritableStream`, `TextEncoder`/`TextDecoder` (zero new deps)
    - Must NOT leak byte-level plumbing (newline framing, stream reader state)
    - Must NOT handle JSON-RPC notifications (only request/response pairs)
  References:
    - Design C from grilling (draft agent-loop-arch-cleanup.md: Fork A section)
    - `src/mcp.ts`(current) — the ~150 lines being extracted from; study the spawn/write/read pattern
  Acceptance criteria:
    - `bun run build` succeeds
    - `bun test __tests__/json-rpc.test.ts` passes (new tests)
  QA scenarios:
    - Happy: SpawnedProcess sends valid request, receives valid response → result matches
    - Failure: Process exits before responding → SubprocessError thrown with exitCode + stderr
    - Failure: Response is malformed JSON → MalformedResponseError thrown with raw text
    - Happy: standalone send() spawns process, sends, receives, cleans up
    - Evidence: `.omo/evidence/task-1-agent-loop-arch-cleanup.md` with test output
  Commit: N (batched after Candidate 3 wave)

- [ ] 2. **Refactor src/mcp.ts — remove transport layer, keep tool execution**
  What to do / Must NOT do:
    - Remove ~150 LOC from mcp.ts: all Bun.spawn/stdio/JSON-parse plumbing
    - Keep: request building (tools/call method), response-to-PhaseResult translation, executeWithTimeout wrapper
    - Replace spawn logic with `import { SpawnedProcess, send } from './json-rpc.js'`
    - Must NOT change `executeMcpPhase` signature — callers depend on it
    - Must NOT change `PhaseResult` structure
  References:
    - `src/mcp.ts:1-179` (full file — current implementation)
    - `src/evaluate.ts` (the only other dynamic-import consumer)
  Acceptance criteria:
    - `bun run build` succeeds
    - All existing MCP tests pass: `bun test __tests__/mcp.test.ts`
  QA scenarios:
    - Happy: executeMcpPhase with valid MCP config returns PhaseResult
    - Failure: MCP server crashes → error propagated through PhaseResult
    - Evidence: .omo/evidence/task-2-agent-loop-arch-cleanup.md with test output
  Commit: YES (batched in Candidate 3 wave)

- [ ] 3. **Fix src/evaluate.ts — replace dynamic import with static import from json-rpc.ts**
  What to do / Must NOT do:
    - Replace `await import('./mcp.js')` on line 70 with `import { send } from './json-rpc.js'` at top of file
    - Build a JSON-RPC request directly instead of constructing a fake PhaseDef to pass to MCP
    - Remove the spurious dynamic import workaround on line 69 (the `import('./mcp.js').catch(() => null)` pattern)
    - Must NOT change `evaluatePhase` signature
    - Must NOT change the fallback logic for `LLM_PROVIDER` vs MCP path
  References:
    - `src/evaluate.ts` (full file — the dynamic import is the only thing changing)
    - Design C grilling outcome: "The 'circular dependency' is entirely imaginary — import graph is a clean DAG"
  Acceptance criteria:
    - `bun run build` succeeds
    - Existing eval tests pass: `bun test __tests__/evaluate.test.ts`
  QA scenarios:
    - Happy: evaluatePhase with MCP provider returns Judgment
    - Failure: MCP process not available → fallback handled, error returned
    - Evidence: .omo/evidence/task-3-agent-loop-arch-cleanup.md with test output
  Commit: YES (batched in Candidate 3 wave)

- [ ] 4. **Clean up maker-checker-plugin.ts — dedup eval pipeline + remove dead config**
  What to do / Must NOT do:
    - Replace `runAiVerification` function (lines 24-48) with a call to `evalWithLlm` from `eval-core.ts`
    - The duplicated pipeline was: `callLLM → parseJsonResponse → check fields` — now calls `evalWithLlm(systemPrompt, userPrompt, llmConfig)`
    - Update `eval-core.ts` `parseJsonResponse` to use the stricter `typeof === 'boolean'` guard (maker-checker's version, more correct)
    - Remove `makerModel`, `checkerModel`, `autoApprove` from maker-checker config types
    - Remove corresponding field declarations from `src/maker-checker-plugin.ts` `MakerCheckerConfig` interface
    - Must NOT change the maker-checker plugin registration signature or plugin hook flow
  References:
    - `src/maker-checker-plugin.ts:24-48` (runAiVerification to replace)
    - `src/eval-core.ts` (evalWithLlm to use, parseJsonResponse to update)
    - `src/maker-checker-plugin.ts` (MakerCheckerConfig: makerModel, checkerModel, autoApprove to remove)
    - Draft: "Maker-checker's stricter typeof guard becomes standard"
  Acceptance criteria:
    - `bun run build` succeeds
    - Existing maker-checker tests pass: `bun test __tests__/maker-checker-plugin.test.ts`
  QA scenarios:
    - Happy: Maker-checker plugin evaluates intent with corrected pipeline → Judgment returned
    - Failure: LLM returns unparseable output → error handled through existing error path
  Commit: YES — `refactor(llm-eval): extract json-rpc.ts, fix eval pipeline, dedup maker-checker` (batches todos 1-4)
  This commit closes Candidate 3.

- [ ] 5. **Fold state-writer.ts into state.ts — remove state.json + fix Promise.all divergence**
  What to do / Must NOT do:
    - Copy `writeBothStates`, `currentState` getter/setter, and `OUTPUT_DIR` from state-writer.ts into state.ts
    - Remove the `writeJsonState` call from `writeBothStates` — stop writing state.json entirely
    - Change `writeBothStates` to `writeState` (single YAML output only) or keep name but remove JSON variant
    - Add explicit `getCurrentState()` / `setCurrentState()` functions to state.ts (replace object-wrapper ref pattern)
    - Wrap the STATE.md write in a try/catch instead of bare Promise.all
    - Delete `src/state-writer.ts`
    - Must NOT change STATE.md format (YAML frontmatter must be identical)
  References:
    - `src/state-writer.ts` (full file - 34 LOC to fold)
    - `src/state.ts` (full file - target to fold into)
    - Draft: "state.json is NEVER read programmatically"
  Acceptance criteria:
    - `bun run build` succeeds
    - State tests pass: `bun test __tests__/state.test.ts`
    - Verify: grep for 'state.json' in src/ returns 0 results
  QA scenarios:
    - Happy: writeState produces STATE.md with correct YAML frontmatter
    - Failure: Filesystem full → write fails gracefully, error logged, previous state preserved
    - Evidence: .omo/evidence/task-5-agent-loop-arch-cleanup.md with test output
  Commit: NO (batched with Candidate 2 wave)

- [ ] 6. **Fix stale currentState bug in daemon-runner.ts**
  What to do / Must NOT do:
    - In daemon-runner.ts, currentState.value is set once at init and NEVER synced during loop
    - Fix: call `setCurrentState()` from state.ts after each daemon loop iteration (before the next tick)
    - This is a temporary fix — Candidate 1 deletes daemon-runner.ts entirely, but we fix now to keep the test suite green during Candidate 2
    - Update import from `state-writer` to `state` for currentState
    - Must NOT change the daemon loop behavior or tick interval
  References:
    - `src/daemon-runner.ts` — the stale state happens because currentState only set in constructor
    - `src/state.ts` — the new getCurrentState/setCurrentState from Todo 5
  Acceptance criteria:
    - `bun run build` succeeds
    - Tests pass: `bun test __tests__/daemon.test.ts`
  QA scenarios:
    - Happy: daemon loop iteration updates currentState → verified via getCurrentState after tick
    - Evidence: `.omo/evidence/task-6-agent-loop-arch-cleanup.md`
  Commit: NO (batched with Candidate 2)

- [ ] 7. **Update all import references from state-writer to state.ts**
  What to do / Must NOT do:
    - Update every file that imports from `state-writer.ts` to import from `state.ts`
    - Files to update: `src/loop-runner.ts`, `src/daemon-runner.ts`, `loop.ts`, and any test files
    - Run: `grep -r "state-writer" src/` and `grep -r "state-writer" __tests__/` to find all references
    - Must NOT change any other import or logic
  References:
    - `src/loop-runner.ts` — imports writeBothStates/currentState from state-writer
    - `src/daemon-runner.ts` — imports currentState from state-writer  
    - `loop.ts` — crash handler imports from state-writer
  Acceptance criteria:
    - `bun run build` succeeds
    - `bun test` passes (full suite, 438 tests)
  Commit: YES — `refactor(state): fold state-writer into state.ts, stop writing state.json, fix stale state` (batches todos 5-7)
  This commit Candidate 2.

- [ ] 8. **Add runIntervalTick() to Daemon class**
  What to do / Must NOT do:
    - Add `runIntervalTick()` method to `src/daemon.ts` that executes one phase group at an interval
    - This is a standalone method, NOT changing `start()`. It is an alternative entry point that mimics daemon-runner's tick loop without the HTTP/WebSocket server.
    - Mimics daemon-runner's tick logic but as a Daemon class method, using loop-runner internals (executePhaseGroup, state updates) instead of spawning subprocesses
    - Must NOT change existing Daemon.start(), taskQueue, or orchestrator behavior
    - Must NOT require any new CLI flags
    - Must NOT replicate the stale-state bug — runIntervalTick must update state via setCurrentState() on every tick
  References:
    - `src/daemon.ts` (full file — current Daemon class)
    - `src/daemon-runner.ts` (the tick pattern to absorb — study the loop body)
    - `src/loop-runner.ts` (runLoop internals to reuse)
  Acceptance criteria:
    - `bun run build` succeeds
    - Existing daemon tests pass: `bun test __tests__/daemon.test.ts`
  QA scenarios:
    - Happy: runIntervalTick fires on schedule and executes phase group
    - Evidence: `.omo/evidence/task-8-agent-loop-arch-cleanup.md`
  Commit: NO (batched with Candidate 1)

- [ ] 9. **Delete src/daemon-runner.ts**
  What to do / Must NOT do:
    - Delete `src/daemon-runner.ts` (114 LOC)
    - Remove `runDaemon` export from `src/index.ts` barrel (NOTE: currently NOT exported from index.ts — this is a safety check; remove if present, skip silently if absent)
    - Update `loop.ts` to redirect `--daemon` CLI flag: instead of calling `runDaemon()`, call `new Daemon().runIntervalTick()` or pass to Daemon.start() with interval config
    - Must NOT leave broken references — every line referencing daemon-runner or runDaemon must be updated
    - Must NOT delete any test file that has useful non-daemon-runner tests
  References:
    - `src/daemon-runner.ts` (full file — to delete)
    - `src/index.ts` — barrel export removal
    - `loop.ts` — flag redirect point
    - Blast radius (explore deep-dive): loop.ts:170 (live runtime via --daemon), index.ts:14-15 (barrel), daemon.test.ts (1 test) 
  Acceptance criteria:
    - `bun run build` succeeds
    - No remaining references to 'daemon-runner' in src/ (excluding tests)
    - Tests pass with remaining daemon tests
  QA: grep src/ for 'daemon-runner' → 0 results. Tests pass.
  Commit: NO (batched with Candidate 1)

- [ ] 10. **Delete src/api.ts**
  What to do / Must NOT do:
    - Delete `src/api.ts` (legacy API server — superseded by routes.ts)
    - Remove `export { startApiServer } from './api.js'` from `src/index.ts:14` (confirmed live export)
    - Delete `__tests__/api.test.ts` (14 tests for now-deleted api.ts — all superseded by route tests)
    - Must NOT break routes.ts or daemon.ts (they don't import api.ts)
  References:
    - `src/api.ts` (full file — to delete)
    - `src/index.ts` — remove barrel export
    - `__tests__/api.test.ts` — delete all 14 tests
    - CONTEXT.md: "api.ts superseded by daemon.ts"
  Acceptance criteria:
    - `bun run build` succeeds
    - grep src/ for 'api.ts' (excluding api.test.ts) → 0 results (no imports to api.ts from src/)
    - Tests pass: `bun test` (api.test.ts now absent)
  QA: grep verification. Test run.
  Commit: NO (batched with Candidate 1)

- [ ] 11. **Redirect --daemon CLI flag + final cleanup**
  What to do / Must NOT do:
    - In `loop.ts`, change the `--daemon` flag handler from `import { runDaemon } from './daemon-runner'` to `import { Daemon } from './daemon'` and call `new Daemon().runIntervalTick()` or equivalent (NOT `start()` — start() launches HTTP server, runIntervalTick mimics daemon-runner's tick loop)
    - Remove `runDaemon` from barrel exports (`src/index.ts`) (NOTE: currently NOT exported — safety check only)
    - Ensure `__tests__/daemon.test.ts` tests that the `--daemon` path uses Daemon class
    - Must NOT change `--daemon` flag's observable behavior (same config, same HTTP port, same interval behavior)
  References:
    - `loop.ts` — the --daemon flag handler
    - `src/daemon.ts` — Daemon class with new runIntervalTick from Todo 8
    - `src/index.ts` — barrel exports
  Acceptance criteria:
    - `bun run build` succeeds
    - `bun test` passes (full suite)
    - The --daemon flag works identically to before (start loop server on same port)
  QA: Run `bun run build && bun test`. Evidence all.
  Commit: YES — `refactor(daemon): delete daemon-runner.ts and api.ts, use Daemon class` (batches todos 8-11)
  This commit Candidate 1. All 3 candidates complete.

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — every todo completed according to acceptance criteria
- [ ] F2. Code quality review — `bun run build && bun test` green
- [ ] F3. Real manual QA — verify `--daemon` flag starts server, state writes to STATE.md only
- [ ] F4. Scope fidelity — no changes outside specified file list

## Commit strategy
Three conventional commits, one per candidate, each preceded by a verification checkpoint:

1. `refactor(llm-eval): extract json-rpc.ts, fix eval-check, dedup-maker-checker` (todos 1-4)
2. `refactor(state): fold state-writer into state.ts, stop writing state.json` (todos 5-7)
3. `refactor(daemon): delete daemon-runner.ts and api.ts, use Daemon class` (todos 8-11)

No intermediate commits between todos within a candidate — batch the entire wave into one commit. Verification run after each commit before proceeding.

## Success criteria
- All 3 commits pushed (or staged for review)
- `bun test` passes (438 existing tests + new json-rpc tests)
- `bun run build` passes
- Dead imports identified at commit 1 are 0
- `state.json` no longer written; `state-writer.ts` file deleted
- `daemon-runner.ts` and `api.ts` files deleted
- No functional regressions in loop execution, daemon mode, or MCP evaluation
