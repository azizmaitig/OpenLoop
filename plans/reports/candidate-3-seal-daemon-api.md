# Candidate 3 — Seal the leaky DaemonAPI seam

**Depends on:** Candidates 1 + 2 (already done in the same working tree, their changes are dirty in daemon.ts / loop-runner.ts).

**Task:** Add `callLLM`, `saveTaskHistory`, `listTaskHistory`, `updateStateMd`, `isSafeCommand` to `DaemonAPI` (daemon-api.ts). Expose them in `daemon.ts`. Rewrite `routes.ts` and `task-processor.ts` to call `api.callLLM(...)` / `ctx.callLLM(...)` — delete direct imports.

**Friction:**
- `src/routes.ts` imports `callLLM`, `readTaskHistory`, `listTaskHistory`, `updateStateMd`, `isSafeCommand` directly (bypasses `DaemonAPI`)
- `src/task-processor.ts` imports `callLLM`, `updateStateMd`, `isSafeCommand` directly (bypasses `TaskContext`)
- `processQueue` in task-processor has two budget paths (inline 133-163 vs `Guard.shouldRun` at 144) — unify on `Guard`

**Files:** `src/daemon-api.ts`, `src/daemon.ts`, `src/routes.ts`, `src/task-processor.ts`, `src/recovery.ts`

**Tests:** after the refactor, `routes.test.ts` should be able to mock `DaemonAPI` alone and cover `/api/llm`, `/api/history`, pause. Add those tests. Existing suites must stay green.

**Tree hygiene:** daemon.ts is already dirty (C1 + C2 edits). Work in a **dedicated git worktree** off clean main so C3 lands as its own clean commit. The C3 changes will be interleaved with C1+C2 in the original dirty tree — that's fine, the worktree gives you a clean per-concern commit.
