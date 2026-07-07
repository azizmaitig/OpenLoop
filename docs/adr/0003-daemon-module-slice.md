# 0003 — Daemon module slice (routes + task-processor)

Extract HTTP/WebSocket route handlers and task processing logic from `daemon.ts`
into separate modules behind interface seams, leaving `daemon.ts` as orchestration
only.

## 2026-07-07: Added js-yaml dependency for YAML consolidation

ADR-0002 chose a custom YAML parser for the plan file because a single small schema
didn't justify a dependency. With 4 independent YAML parsers now spread across
`state.ts`, `plan-executor.ts`, `orchestrator.ts`, and supporting files (~390 LOC
total), a consolidated parser in `yaml.ts` using `js-yaml` is smaller, more
maintainable, and has a well-known behaviour surface.

This revises ADR-0002's dependency rationale for the project as a whole: the zero-dep
policy still holds for new code where a few lines of custom logic suffice, but
repetitive infrastructure at this scale (>300 LOC of hand-rolled parsers) now
justifies a dependency.

## Context

`daemon.ts` is 572 LOC handling:

- HTTP server setup and lifecycle
- REST route handlers (health, state, task CRUD, loops CRUD, LLM proxy, pause)
- WebSocket setup and state broadcasting
- Task queue processing with budget guard
- Direct field access to `Daemon` class internals from route handlers

All three concerns — serving, routing, processing — live in one class with no
internal seams, making them impossible to test in isolation or swap independently.

## Decision

Extract into three modules:

### 1. `routes.ts` — Router/handler module

- Exports `registerRoutes(server, api: DaemonAPI)` — registers all REST + WS handlers
- Receives a `DaemonAPI` interface with only the methods routes need:

```typescript
interface DaemonAPI {
  getState(): DaemonStatus & { queueLength: number; currentTask: Task | null }
  start(): Promise<void>
  stop(): void
  taskQueue: TaskQueue
  triggerManager: TriggerManager
  orchestrator: LoopOrchestrator
  broadcast(type: string, data: unknown): void
}
```

- No access to `Daemon` internals beyond the interface
- Testable by passing a mock `DaemonAPI`

### 2. `task-processor.ts` — Task execution module

- Exports `processTask(context: TaskContext)` — isolated task execution
- Receives a `TaskContext` value object:

```typescript
interface TaskContext {
  task: Task
  config: { baseDir: string; stateMdPath: string }
  deps: {
    saveTaskHistory: (task: Task) => Promise<void>
    updateStateMd: (fm: StateMdFrontmatter) => Promise<void>
    callLLM: typeof callLLM
    checkBudget: () => ReturnType<typeof checkBudget>
    mcpClient: MCPClient
  }
}
```

- Testable by passing a fake `TaskContext` (no IO)

### 3. `daemon.ts` — Orchestration only (~160 LOC)

- Config loading, server lifecycle (start/stop), composing routes + task-processor
- Wires real implementations into the seams at startup

## Rationale

| Concern | Before | After |
|---------|--------|-------|
| Route testing | Must instantiate full Daemon with live server | Pass mock DaemonAPI to registerRoutes() |
| Task processing testing | Daemon.processQueue is private, tied to class state | Pure function, call with TaskContext |
| LOC per file | 572 | ~160 (daemon) + ~80 (routes) + ~80 (task-processor) |
| Cognitive load per file | HTTP, WS, task logic, budget, LLM — all mixed | One concern per file |

The three modules pass the deletion test: removing any one of them would
concentrate its concern back into daemon.ts, not eliminate it.

## Considered Options

- **Keep monolithic daemon.ts** — discarded. Routes cannot be unit-tested; task
  processing cannot be run without a live server.
- **Extract only routes, leave task processing in daemon.ts** — discarded.
  processQueue is the other independently-testable behaviour, and extracting
  only routes leaves daemon.ts at ~400 LOC with mixed concerns.
- **Extract into a single `daemon-lib.ts`** — discarded. Routes and task processing
  have no shared logic that would justify grouping them; they depend on different
  parts of the daemon state.

## Consequences

- Routes can be unit-tested by constructing a mock `DaemonAPI` and calling
  `registerRoutes` against a test server.
- Task processing can be unit-tested by calling `processTask` with synthetic
  `TaskContext` — no server, no WebSocket, no real MCP.
- `daemon.ts` becomes a thin wiring module — easy to understand, hard to grow.
- The two seams (`DaemonAPI`, `TaskContext`) are hypothetical until a second
  route implementation or task processor exists. If they never materialize, the
  interfaces still pay for themselves in testability.

## Related

- Supersedes the monolithic daemon architecture described in CONTEXT.md
- YAML consolidation (separate change) will add `js-yaml` as a dependency,
  revising ADR-0002's zero-dep rationale for this project
