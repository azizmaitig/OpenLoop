# ADR-0023 — Agent Server sidecar execution (v10)

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** none
- **Related:** ADR-0012 (feedback controller — future `agentHeal` seam), ADR-0017 (CommandRunner deep-module pattern), ADR-0009 (recovery/guard separation), `research/openhands-integration.md` (decision-grade mechanism research)
- **Scope:** `src/agent-server.ts` (new sidecar manager), `src/agent-executor.ts` (new executor), `src/types.ts` (PhaseDef `type: agent`), `src/plan-executor.ts` + `src/execute-phases.ts` (dispatch), `src/config.ts` (`agentServer.*` config), `docs/adr/`, `PLAN-WRITING-GUIDE.md` (task schema)

## Context

agent-loop v8 runs plan tasks as shell commands and MCP/LLM steps. Those can't do real agentic work: understand a repo, plan, edit files, run tests, observe failures, iterate. OpenHands (Agent Canvas) provides exactly that — an agent runtime with tools, workspaces, and a sandbox. Research (`research/openhands-integration.md`) resolved the integration-mechanism fork from primary sources:

- **Agent Server sidecar** (Python FastAPI, REST + WS) — viable, full conversation lifecycle control.
- **ACP client** — viable long-term (`@agentclientprotocol/sdk`, TypeScript), but OpenHands ACP is mediated through the Agent Server; ecosystem still maturing.
- **MCP adapter** — DOES NOT EXIST: `mcp_router.py` only configures outbound MCP tools for the agent; it does not expose agent sessions inbound.
- **SDK embedding** — IMPOSSIBLE: the SDK is Python-only; agent-loop is Bun/TS with a deliberate zero-build, no-Python-at-runtime posture.

Additionally, an agent task is a **backdoor past the command denylist** (`constitution.ts` `isSafeCommand` never sees agent actions) — a new trust boundary must be declared, not assumed.

Seven decisions, resolved by grilling (ADR-0023 grilling session, 2026-08-17).

## Decision

### 1. v10 scope = executor only
The OpenHands integration lands in two halves. v10 ships **execution only**: `type: agent` phase tasks driven by the Agent Server. The healing half — an OpenHands agent as *investigate-and-fix* (`agentHeal`, a third recovery action beside `healAndRetry`/`failTerminal`, ADR-0009) — composes on the v9 feedback controller (ADR-0012) AFTER v9 ships. It is not in v10.

### 2. Sidecar = daemon-owned singleton with `manage` flag
New `src/agent-server.ts` deep module (ADR-0017 pattern) owns spawn/health/restart of the OpenHands Agent Server process. Lazy-spawn on first agent task; `GET /api/health` gates every agent task; bounded restart (3×, mirroring `maxRetries`) then ABORT. Shared across ALL child loops — each loop gets its own *conversation* on the one server (conversations are isolated). `agentServer.manage: true|false` config flip: `false` = connect to a BYO server URL (systemd/Docker-managed), no process ownership.

### 3. Task model = `type: agent` discriminator
`type` is the task-kind discriminator, mutually exclusive with `command` (both present → validation error). An agent task carries `prompt` (required), optional `agent` (backend name; `openhands` today, ACP later), `model`, `workspace`, `timeoutMs`, `dependsOn`. The existing `llm:` block is untouched — it is advisory grading, orthogonal to execution. Agent tasks mix freely with command tasks in one DAG (`dependsOn` is kind-agnostic).

### 4. Task result = terminal conversation state → PhaseResult
The executor translates the conversation's terminal state into a `PhaseResult` (pass/fail; stdout = last agent message / event summary). The normal `verify` phase gates the result like any task — **no new FSM states**. Crash checkpoint semantics unchanged.

### 5. Workspaces = local AND docker, both live in v10
`workspace.type: local` (default) runs the agent in the loop's working directory (for L2: the git worktree — the existing worktree mandate stays authoritative). `workspace.type: docker` runs it in a sandboxed container (`/workspace` mount — the verified agent-server image convention, per primary-source research in issue #30) — the hard enforcement for untrusted work. The client provisions the container per task (`docker run -d --rm -p 0:8000 -v <cwd>:/workspace <agent-server image>`); one container = one agent server = per-conversation isolation. Both are real in v10, not schema-reserved.

### 6. Model config = server defaults + per-task override
The sidecar manager injects server-level LLM defaults at spawn (config file/env via `OPENHANDS_AGENT_SERVER_CONFIG_PATH`; LiteLLM-backed). A task's `model:` block overrides at conversation creation. Per-task provider switching (ollama for cheap analysis, claude for hard edits) works without repeating config.

### 7. Agent tasks = explicit trust tier
Agent tasks are a distinct trust boundary: opt-in per task, governed by the existing L1/L2 human gates. The command denylist (`shell.ts`) does NOT see agent actions, so the denylist is passed into the prompt as instruction (soft). Hard enforcement arrives via `workspace.type: docker` for untrusted work.

## Considered Options

- **ACP client as v10 mechanism** — rejected for v10: OpenHands ACP is mediated through the Agent Server anyway (still needs the sidecar), and the ecosystem is newer. Deferred as Phase 2: a Bun/TS ACP client (`@agentclientprotocol/sdk`) for driving any ACP agent (Claude Code, Codex, Gemini) through one interface. Revisit after v10 stabilizes.
- **MCP adapter** — dead end: OpenHands ships no inbound agent-session MCP server.
- **SDK embedding** — impossible: Python-only SDK, Bun/TS process.

## Consequences

- **Positive:** The loop gains real agentic execution — understand/plan/edit/test/iterate — as a first-class task kind, while keeping the 4-state FSM and checkpoint semantics untouched.
- **Positive:** Sidecar singleton + conversations-per-loop fits the multi-loop orchestration story (Loop A→backend refactor, Loop B→tests, Loop C→docs) without N Python processes.
- **Positive:** `manage: false` makes the backend an ops concern when the user wants it — the loop degrades to a client.
- **Negative:** Python ≥ 3.12 becomes a runtime prerequisite for agent tasks (uvx or Docker image) — a new class of dependency for a zero-build Bun project. Spawn-failure must surface a clear diagnostic at the first agent task.
- **Negative:** Trust tier means an agent task can touch denylisted paths in local mode — mitigated by human gates + prompt-level instruction until docker workspace is used.
- **Negative:** Agent conversations consume real model tokens; the budget guard counts *runs*, not tokens — a token-heavy agent plan can exhaust cost silently. Mitigation is plan-level discipline in v10 (spec-level guidance, not a new counter).

## Out of Scope

- `agentHeal` (agent-investigate-fix recovery action) — deferred until v9 feedback controller ships (ADR-0012)
- ACP client (Phase 2) — universal agent interface
- Conversation resume from the event log after sidecar restart — deferred; v10 restarts the server and fails the in-flight phase into normal recovery
- New budget accounting for agent tokens — plan-level discipline only