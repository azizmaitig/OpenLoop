# 0004 — Extract shared `executePhases()` for loop + daemon

## Context

`loop.ts` (`runLoop`/`tick`) and `daemon.ts` (`processQueue`) both execute
phases: iterate over tasks, call MCP tools / LLM, evaluate results, persist
state. The core algorithm is the same, but implemented independently in each
path with slightly different signatures and error handling.

This duplication means:
- A fix to phase execution in one path doesn't reach the other
- Testing phase logic requires running either the full loop or the full daemon
- Adding a feature (retry, new evaluation mode) must be done twice

## Decision

Extract a shared `executePhases()` function that both paths call:

```typescript
// Shared module (e.g., src/execute-phases.ts)
async function executePhases(
  phases: PhaseDef[],
  deps: ExecutionDeps
): Promise<PhaseResult[]>

interface ExecutionDeps {
  mcp: MCPClient
  llm: LLMProvider
  evaluate: (result: PhaseResult) => Promise<Judgment>
  saveState: (results: PhaseResult[]) => Promise<void>
}
```

- `loop.ts` calls it in `tick()` with its real deps
- `daemon.ts` calls it in `processQueue()` with its real deps
- Tests call it with fake deps to verify phase logic in isolation

## Rationale

| Concern | Before | After |
|---------|--------|-------|
| Phase execution LOC | ~90 in loop.ts + ~70 in daemon.ts = ~160 duplicated | ~100 in one module |
| Testing | Must run full loop or full daemon | Call executePhases() with mocks |
| Fix locality | Fix in one path, other path stays buggy | Fix once, both paths benefit |

Passes the deletion test: removing `executePhases()` would force the algorithm
back into both callers, not eliminate it.

## Considered Options

- **Make daemon use loop.ts's tick directly** — discarded. tick() is coupled
  to loop lifecycle (state machine transitions, iteration counting), which
  the daemon doesn't need.
- **Extract as a method on a shared class** — discarded. A standalone function
  with explicit deps is more testable and has no lifecycle to manage.

## Consequences

- `loop.ts` shrinks by ~30 LOC, `daemon.ts` by ~50 LOC
- Phase execution logic lives in exactly one file
- New evaluation modes or retry policies only need to change one function
- The `ExecutionDeps` interface is a hypothetical seam (one implementation
  today), but pays for itself in testability

## Related

- ADR-0003: Daemon module slice (routes + task-processor) — complementary
  extraction; both reduce daemon.ts LOC and improve testability
