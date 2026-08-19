# Plan Writing Guide — agent-loop

A reference for authoring `.plan.yaml` files that the agent-loop executes correctly.
If the loop keeps producing "wrong plans," it is almost always because one of the
rules below was violated. Read this before writing or editing any plan under `plans/`.

> Loaded automatically by the loop via `AGENTS.md`. When in doubt, follow this guide
> over any guess.

---

## 0. Machine-enforced contract (run this before saving)

This guide is prose, but the rules are **checkable**. A dedicated structural
validator enforces the field contract that the executor does *not* check at load
time. Run it on any plan before committing:

```powershell
bun run loop.ts validate --plan "plans/my-plan.yaml"
```

- Exit `0` → plan passes the structural schema.
- Exit `1` → one or more schema errors printed as `- [<rule>] <detail>`.

The validator (`src/plan-schema.ts`, `validatePlanSchema`) catches:

| Rule | What it catches |
|------|-----------------|
| `empty-command` | A task with no `command` (or whitespace only) — **except `type: agent` tasks**, which execute a `prompt` instead (see §3B). The executor runs nothing and the phase "passes" — the #1 silent no-op. |
| `duplicate-id` | Two tasks share an `id`; breaks resume + checkpoint keying. |
| `unknown-llm-provider` | `llm.provider` isn't `openai` / `anthropic` / `opencode`; executor would silently default to `openai`. |
| `missing-llm-prompt` | An `llm` block with no `prompt` (must request `{passed, reason, confidence}`). |
| `missing-llm-tool` | MCP-form `llm` (`mcpServer`+`tool`) with no `tool`; defaults to `''` and no-ops. |
| `validator-without-criteria` | A `validator` block with no `criteria` rubric. |

It deliberately **does not** duplicate the other gates (run in addition to it):

- `constitution.ts` (`checkPlanAgainstConstitution`) — already runs at plan load and
  enforces `read-state-first`, `verify-last`, denylisted paths, non-empty tasks.
- `phase-graph.ts` (`topoSortLayers`) — throws on dangling `dependsOn` / cycles at DAG build.
- `expandComposites` — throws on an unknown `use` reference at plan load.

**Treat `validate` as the pre-flight.** A plan that passes both `validate` and the
constitution gate is structurally guaranteed to run; only *behavioral* quality
(the LLM prompts, the artifacts, the worktree paths) remains a human review item.

---

## 1. Mental model (how your YAML is executed)

`src/plan-executor.ts` reads your YAML once (`beforeLoop`) and turns **each task into a
phase**. Phases run **sequentially** through a state machine `init → run → verify → done`.

Each phase's `command` is executed via `shell.ts`, which writes the command verbatim to a
**temp `.cmd` file** on Windows (`/bin/sh -c` on Unix) so quotes, spaces, and special
characters survive shell parsing correctly. The temp file is cleaned up after the process exits.

For every task the executor does **both**:

1. **Runs `command`** as a shell command. It must exit `0` or the phase is marked `fail`.
2. **Optionally runs an LLM judgment** (if the task has an `llm:` block) on the command's
   output. The LLM returns a verdict; its `reason` is written to `<plan>-report.md`.

Key consequence: **an `llm:` block does NOT replace `command`.** The command always runs.
So a task that only needs an LLM decision still needs a real `command` (often a scan /
read step whose output the LLM judges). Do not leave `command` empty or pointing at a
dummy — point it at the step whose output the LLM should assess.

The one exception is `type: agent` tasks (§3B): they carry a required `prompt` instead
of a `command` and hand the whole task to an agent backend. That is the only task kind
that does not run a shell command.

At the end (`afterLoop`) the executor writes `status`, `durationMs`, `completedAt` back
into your YAML and emits a `-report.md` from the LLM phase. **You do not hand-write those
fields** — they are machine-owned. (Existing plans that contain them were produced by a run.)

---

## 2. Required schema

```yaml
planName: my-plan-name          # REQUIRED — unique, kebab-case
tasks:
  - id: step-one                # REQUIRED — unique string, used as phase name
    command: echo "doing step one"   # REQUIRED — shell cmd, must exit 0
    timeoutMs: 30000            # optional, default 30000
    # llm is optional — see §4
  - id: judge-step
    command: type some-output.txt   # command ALWAYS runs; LLM judges its stdout
    timeoutMs: 60000
    llm:
      provider: opencode        # 'openai' | 'anthropic' | 'opencode'
      prompt: >-
        You are a design audit agent. Read stdout. Return JSON:
        { "passed": boolean, "reason": "markdown report", "confidence": 0-1 }.
```

That is the entire contract. `planName` + a list of tasks, each with a unique `id` and a
`command` that exits 0. Everything else is optional.

---

## 3. Field reference

| Field | Required | Default | Notes |
|---|---|---|---|
| `planName` | yes | — | Unique kebab-case name. Missing → executor throws. |
| `tasks[].id` | yes | — | Unique. Becomes the phase name. Duplicates break resume. |
| `tasks[].command` | yes* | — | Shell command. **Must exit 0.** Always executed, even with `llm`. *Not allowed on `type: agent` tasks — those carry `prompt` instead (§3B). |
| `tasks[].type` | no | `command` | Task-kind discriminator: `command` (default) \| `agent`. `agent` = executed by an agent backend, not a shell (§3B). |
| `tasks[].prompt` | no* | — | *Required when `type: agent`. The instruction handed to the agent backend — what the agent executes. |
| `tasks[].agent` | no | `openhands` | Agent backend name (`openhands` today; ACP later). |
| `tasks[].model` | no | (server defaults) | Per-task model override `{ provider, model }`. Overrides the Agent Server's server-level LLM defaults for this conversation. |
| `tasks[].workspace` | no | `local` | Agent tasks only. `{ type: local \| docker }`. `local` = loop working directory; `docker` = per-task sandboxed container mounting the loop cwd at `/workspace` for untrusted work (§3B). |
| `tasks[].timeoutMs` | no | `30000` | Bumps to `120000` for builds / installs / anything slow. |
| `tasks[].llm.provider` | no | `openai` | `openai` \| `anthropic` \| `opencode`. |
| `tasks[].llm.prompt` | no* | `''` | *Required if `llm` present. Must ask for `passed`/`reason`/`confidence`. |
| `tasks[].llm.mcpServer` + `tool` | no | — | Alternative to `provider`: call an MCP tool instead of an LLM. |
| `tasks[].healCommand` | no | — | Recovery command run when the task fails (see `minimal-fix` skill). |
| `tasks[].maxRetries` | no | — | Retry count before escalation. |
| `tasks[].produces` | no | — | **Artifact gate.** Path to a file this task MUST produce. After the command exits 0, the executor checks this file exists and fails the phase if missing. Catches silent failures where the LLM exits 0 without producing the expected artifact. |
| `tasks[].producedMustHaveContent` | no | `false` | When `true`, the `produces` file must also be non-empty (zero-length file fails the gate). |
| `tasks[].validator.criteria` | no* | — | **Output quality gate.** After the command exits 0, an LLM grades the phase output against this rubric. If it fails, re-runs once (`maxRetries` cap 1) then **fail-opens** — phase always passes, validation recorded in `STATE.md`. *Required if `validator` block present. |
| `tasks[].validator.maxRetries` | no | `1` | Re-run attempts on validation failure. Capped at 1 (Conductor semantics). |
| `tasks[].validator.llm` | no | (env) | Optional LLM override for the validator. Same shape as `tasks[].llm`. Defaults to `LLM_PROVIDER`/`LLM_API_KEY`/`LLM_MODEL` env vars. |

Do **not** author `status`, `durationMs`, `completedAt`, `confidence`, or `dependsOn` by
hand (except `dependsOn` — see §3A) — the executor owns the rest.

---

## 3A. Daemon runtime & plan-level config

Your plan runs inside a daemon. How the daemon runs — which port, how fast, how often —
is controlled by **two layers**:

1. **CLI flags** when you start the daemon (`bun run loop.ts daemon ...`)
2. **`daemon:` block** at the top of your plan YAML

### 3A.1 CLI flags (how you start it)

```powershell
bun run loop.ts daemon --port 3000 --plan "plans/my-plan.yaml"
```

| Flag | What it does | Required? | Default |
|------|-------------|-----------|---------|
| `--port <number>` | Serves the dashboard Web UI on this port | no | `3000` |
| `--plan "path/to.yaml"` | Load phases from this YAML file | no (uses built-in demo) | — |
| `--cron "* * * * *"` | Re-trigger the plan on a cron schedule (every minute, every hour, etc.) | no | — |

**`--plan` without `--cron`:** The daemon still runs your plan continuously — it executes
phases, then loops back and runs them again. The warning `--plan provided without --cron`
is misleading; your plan runs fine. See §3A.2 for the gap between iterations.

**`--plan` with `--cron`:** Adds a **separate** timer that re-enqueues the whole plan on
the cron schedule. Use this when you want a fixed time between runs (e.g. `0 9 * * *` =
once daily at 9am). Without it, the daemon runs the plan back-to-back in its own tick loop.

**`--cron` without `--plan`:** Does nothing useful — cron triggers an empty queue.

### 3A.2 The gap between iterations (and how to remove it)

When you run `--plan` without `--cron`, this is what happens internally:

```
[tick] run all 4 phases (takes ~5s) → wait 60s → [tick] run all 4 phases → wait 60s → ...
```

The 60-second wait comes from `daemon.intervalMs` which defaults to **60000ms** in the
daemon config. If your phases finish fast, you sit idle most of the time.

**To tighten the gap, pass the interval at startup — the interval lives in the daemon
config, NOT in the plan YAML:**

```powershell
# tighter loop: interval comes from the daemon config, not the plan
bun run loop.ts daemon --port 3000 --plan "plans/my-plan.yaml" --daemon
```

The loop will then execute phases, loop, and execute again as fast as the phases
themselves take. Set `intervalMs: 0` in the daemon config for zero delay.

### 3A.3 The `daemon:` block is NOT parsed from the plan

> **Note:** `daemon.intervalMs` is **not** a field the executor reads from
> your plan YAML. `PlanYamlDoc` (src/types.ts) has no `daemon` key. The loop
> interval comes from the CLI/`--daemon` flag or the in-process config
> (`LoopConfig.daemon.intervalMs`), not from the `.plan.yaml`. Do **not** add a
> `daemon:` block to a plan expecting the executor to honor it — it is silently
> ignored.

If you genuinely need per-plan interval control, that requires a code change to
`plan-executor.ts`/`LoopConfig` (add `daemon` to `PlanYamlDoc` and merge it in
`beforeLoop`) — file an issue; it is intentionally out of scope for plan authors
today.

### 3A.4 Quick comparison — three ways to run

| Command | Dashboard? | Plan runs? | Gap between iterations |
|---------|-----------|-----------|----------------------|
| `bun run loop.ts daemon --port 3000 --plan "plans/x.yaml"` | ✅ port 3000 | ✅ continuously | 60s (set `daemon.intervalMs` to shrink it) |
| `bun run loop.ts daemon --port 3000 --plan "plans/x.yaml" --cron "* * * * *"` | ✅ port 3000 | ✅ on cron schedule | (cron-driven, ignores intervalMs) |
| `bun run loop.ts start --plan "plans/x.yaml" --max-iterations Infinity` | ❌ (terminal only) | ✅ continuously | **0** — immediate loop-back, no wait |
| `bun run loop.ts start --plan "plans/x.yaml"` | ❌ (terminal only) | ✅ once, then exits | — |

**The `start` mode** runs the plan in your terminal with no dashboard. Useful for testing
or when you don't need the live UI. `--max-iterations Infinity` makes it run forever
until Ctrl+C.

---

When a task declares `dependsOn:`, the executor builds a dependency DAG at runtime.
Phases whose dependencies are all satisfied run **concurrently** in the same layer.
A layer waits for all its phases before proceeding to the next.

```yaml
planName: parallel-example
tasks:
  - id: checkout
    command: git clone ...
  - id: lint
    command: bun run lint
    dependsOn: [checkout]
  - id: test
    command: bun run test
    dependsOn: [checkout]
  - id: report
    command: ./merge-reports.sh
    dependsOn: [lint, test]
```

In this plan `lint` and `test` run concurrently after `checkout`. If either fails,
the sibling is aborted via `AbortController` and the layer fails immediately.

**Rules:**
- `dependsOn` references other task `id`s in the same plan.
- Reference a non-existent `id` → executor throws at plan load.
- Circular dependencies → executor throws at plan load.
- If **no task** has `dependsOn`, phases run sequentially as before.
- Phases with `dependsOn: []` (explicitly empty) are treated as having no
  dependencies and can group with other independent phases in layer 0.

---

## 3B. Agent tasks (`type: agent`)

v10 adds a second task kind: **agent tasks** run by an agent backend (OpenHands Agent
Server, ADR-0023) instead of a shell command. They are opt-in per task and governed by
the same L1/L2 human gates as everything else.

```yaml
tasks:
  - id: analyze-auth
    type: agent            # REQUIRED — the task-kind discriminator
    prompt: >-             # REQUIRED — the instruction the agent executes
      Analyze the auth module and report security issues. Read the code, plan,
      edit if needed, run tests.
    agent: openhands       # optional — backend name (openhands today, ACP later)
    model:                 # optional — per-task model override
      provider: ollama
      model: qwen2.5-coder
    workspace:             # optional — local (default) | docker
      type: docker
    timeoutMs: 120000      # optional — same as command tasks
```

**Rules (all enforced at parse time by the schema validator):**

- `type: agent` is **mutually exclusive** with `command` — both present → `agent-with-command` error. Agent tasks execute a `prompt`, not a shell command.
- `prompt` is **required** on agent tasks — missing → `missing-agent-prompt` error.
- `workspace.type` must be `local` or `docker` — anything else → `unknown-workspace-type` error. `local` (default) runs the agent in the loop's working directory; `docker` runs it in a per-task sandboxed container for untrusted work (§3B.1).
- **Agent tasks cannot be the plan's first or last task** — schema gates `agent-grounding` (first) and `agent-verify-gate` (last). The run must be grounded by a command task (e.g. `type STATE.md`) and closed by a command verify task (build/test/lint/verify), so the loop's own guards bracket agent work. Composite `use` tasks are resolved, so an agent sub-phase cannot smuggle into a boundary position either.
- `model: { provider, model }` overrides the Agent Server's server-level LLM defaults for that conversation (§3B.2).
- The existing `llm:` block is untouched — it stays advisory grading, orthogonal to execution. The normal `verify` phase gates agent results like any other task.
- Agent tasks mix freely with command tasks in one DAG — `dependsOn` is kind-agnostic.

**Execution is wired** (T2–T5, not a stub): an agent task creates a conversation on the
sidecar, sends the prompt, polls to a terminal state, and maps the result to a normal
`PhaseResult` — `finished` passes, `failed`/`aborted`/`stopped` fail (`src/agent-executor.ts`,
`src/agent-server.ts`, `src/docker.ts`). A hard per-phase `timeoutMs` bounds the
conversation.

A mixed plan — command grounding/verification + local trusted analysis + docker
sandboxed edit:

```yaml
planName: agent-mixed-workspace
tasks:
  - id: read-state
    command: type STATE.md          # grounding must be a command task

  - id: audit-local
    type: agent
    prompt: >-
      Read the repository and produce a triage report of the auth module.
      Do not edit anything — report only.
    model:                          # cheap model for analysis
      provider: ollama
      model: qwen2.5-coder

  - id: patch-untrusted
    type: agent
    prompt: >-
      Implement the approved fixes from the triage report. Run the project's
      tests before finishing.
    workspace:
      type: docker                  # hard enforcement for the edit task

  - id: verify
    command: bun test               # verification must be a command task
    timeoutMs: 120000
```

### 3B.1 Trust tier (denylist-as-prompt, docker as hard enforcement)

Agent actions bypass the command guard — `shell.ts`'s `isSafeCommand` never sees what an
agent does. The denylist is therefore a **two-layer control** (ADR-0023 decision 7):

1. **Soft — denylist-as-prompt.** `buildDenylistPromptInstruction` (`src/constitution.ts`)
   prepends a `SAFETY CONSTRAINT` block to **every** agent prompt, enumerating the tokens
   `.env`, `auth/`, `payments/`, `secrets/`, `credentials/` as binding: the agent MUST NOT
   access, create, modify, or delete any path containing them, and must STOP and report a
   conflict instead of proceeding. It is prepended (not appended) so a trailing "ignore
   everything above" cannot neutralize it.
2. **Hard — `workspace.type: docker`.** The container mounts only the loop cwd
   (`-v <cwd>:/workspace`, conversation workingDir `/workspace`) and runs the agent
   sandboxed with no host access beyond that mount. Use docker for untrusted work;
   `local` runs the agent in the loop's working directory (the L2 git worktree when
   running L2) and is trusted by comparison.

Both layers sit under the existing **L1/L2 human gates** — the trust tier is opt-in per
task, and L1 remains report-only: no agent task runs until a human enables L2.

### 3B.2 Sidecar configuration (`agentServer.*`)

The sidecar is **loop-level config** (`LoopConfig.agentServer`, defaults in
`src/config.ts`) — not a plan-YAML field. From the CLI it is set via
`LOOP_AGENT_SERVER_*` environment variables (see the table). The env surface
applies to `start` and daemon `--plan` runs; multi-loop `--loops-config`
children require programmatic config (or the subprocess fallback, which
inherits the env).

| Key / env var | Default | What it does |
|-----|---------|--------------|
| `agentServer.manage` / `LOOP_AGENT_SERVER_MANAGE` | `true` | `true`: the loop lazily spawns and owns the sidecar (`uvx --from openhands-agent-server agent-server[.exe]`, health-gated, bounded restart then ABORT). `false`: connect to a BYO server `url` with no process ownership (systemd/Docker-managed). |
| `agentServer.url` / `LOOP_AGENT_SERVER_URL` | `http://127.0.0.1:8000` | Base URL of the Agent Server REST API. |
| `agentServer.port` / `LOOP_AGENT_SERVER_PORT` | `8000` | Port the spawned sidecar listens on (spawn arg when `manage: true`). |
| `agentServer.readyTimeoutMs` / `LOOP_AGENT_SERVER_READY_TIMEOUT_MS` | `20000` | How long a freshly spawned sidecar has to become healthy. The 5s default failed on Windows Docker Desktop (port wiring takes ~8s+, measured 2026-08-19); raise further for uvx cold installs. |
| `agentServer.maxRestarts` / `LOOP_AGENT_SERVER_MAX_RESTARTS` | `3` | Restart budget after the initial spawn before the loop ABORTs. |
| `agentServer.defaults` / `LOOP_AGENT_SERVER_DEFAULTS_*` | — | Server-level LLM defaults for every agent conversation: `model`, `baseUrl`, `apiKey` (+ optional `provider`). **`model` must carry a LiteLLM-known provider prefix** — e.g. `openai/deepseek-v4-flash-free` with an OpenAI-compatible `baseUrl` (like the opencode compat shim, `scripts/opencode-compat-server.ts`). `apiKey` must be non-empty — LiteLLM refuses keyless requests even for keyless gateways (any dummy value works against a local shim). Per-task `model:` overrides the model part only. |

Operational notes (found by the real-server test, 2026-08-19): **`baseUrl` must be the provider's API root — LiteLLM does not append `/v1`** (`https://api.example.com/v1` for OpenAI-compatible providers, or the request 404s). **Providers retire models**: NVIDIA returned `410 Gone` for `deepseek-ai/deepseek-v4-flash` (EOL 2026-08-07) — use the dated snapshot (`deepseek-ai/deepseek-v4-flash-0731`) and re-check the provider catalog when a conversation errors with 4xx. |

Example (opencode serve + the compat shim, free DeepSeek V4 Flash):

```powershell
$env:LOOP_AGENT_SERVER_DEFAULTS_MODEL = "openai/deepseek-v4-flash-free"
$env:LOOP_AGENT_SERVER_DEFAULTS_BASE_URL = "http://host.docker.internal:4097"
$env:LOOP_AGENT_SERVER_DEFAULTS_API_KEY = "sk-none"
$env:LOOP_AGENT_SERVER_READY_TIMEOUT_MS = "120000"
bun run loop.ts start --plan plans/my-agent-plan.yaml
```

One sidecar is shared across all child loops (one conversation per loop). Docker tasks
**always** provision their own containerized sidecar regardless of `manage` — one
container = one agent server = per-conversation isolation.

### 3B.3 Cost discipline (agent conversations are real money)

An agent conversation consumes **real model tokens on every run** — create conversation →
send prompt → poll → delete. The loop's **budget guard counts runs, not tokens**
(`loop-run-log.md` vs the daily run cap); a token-heavy agent plan can exhaust cost
silently without ever tripping the run budget (ADR-0023, consequences / out of scope).

Plan-level discipline is the v10 mitigation (a per-agent token counter is explicitly out
of scope):

- **One concern per agent task.** A prompt that asks for triage AND implementation AND a
  test run is several conversations of drift. Split into tasks wired with `dependsOn`.
- **Right-size the model.** Use `model:` overrides for cheap providers on analysis tasks
  (e.g. ollama for audit, a frontier model for the hard edit) — per-task provider
  switching is the point of the override.
- **Ground cheap, verify real.** The first and last tasks are command tasks by schema
  gate anyway — keep grounding and verification shell, not agent.
- **`docker` only for genuinely untrusted work.** Containers add image-pull + startup
  overhead per task; use `local` for trusted in-loop work.
- **Set a realistic `timeoutMs`.** A conversation killed by timeout still burned tokens
  up to the kill — budget the phase for the agent's worst case, not the happy path.
- **Watch scheduled plans.** A cron'd agent plan multiplies token spend per tick; review
  it against the daily token cap (`AGENTS.md` → Budget) before scheduling.

## 4. Reusable composite sequences (Feature B)

Plan YAML can define reusable phase sequences under a top-level `composites:` block.
A task references a composite via `use:`.

```yaml
planName: composite-example
composites:
  - id: build-and-test
    phases:
      - id: compile
        command: bun run build
        timeoutMs: 120000
      - id: test
        command: bun run test
    atomic: true        # run all sub-phases as ONE shell command + ONE LLM eval

tasks:
  - id: setup
    command: echo "ready"
  - id: do-build
    command: placeholder   # overridden by the composite
    use: build-and-test
```

**Atomic (`atomic: true`):** The sub-phase commands are joined with `&&` and
executed as a single `PhaseDef`. One shell invocation, one LLM judgment —
the entire sequence is treated as one unit by the loop state machine.

**Non-atomic (`atomic: false` or omitted):** The composite is expanded inline:
each sub-phase becomes its own task with a prefix id
(`<task-id>:<sub-phase-id>`). Normal phase-level granularity applies
(hooks, healing, checkpoint per sub-phase).

**Unknown `use:` id** → executor throws at plan load.

---

## 5. LLM judgment contract

When a task has `llm:`, the prompt **must instruct the model to return**:

```json
{ "passed": boolean, "reason": "<markdown report>", "confidence": 0.0-1.0 }
```

- `reason` is what gets written to `<plan>-report.md`. Make it a real, skimmable report,
  not a one-liner.
- `passed: false` does **not** by itself fail the phase unless the command also exits
  non-zero. Use the command's exit code as the hard gate; use `passed` as the human-facing
  verdict in the report.
- Keep the prompt scoped: one judgment per task. Don't ask the LLM to also fix things.

### 5.1 Validator gate

The `validator:` block on a task adds a second LLM call after the command exits 0. It grades the phase output against a `criteria` rubric, re-runs once on fail (capped at 1), and always fail-opens — the phase always passes, but the validation result is recorded in STATE.md.

```yaml
tasks:
  - id: code-gen
    command: type prompt.txt
    llm:
      provider: opencode
      prompt: Generate a FastAPI auth endpoint
    validator:
      criteria: |
        The generated code must:
        1. Include a SQLAlchemy model with email + password_hash
        2. Include Pydantic schemas for request/response
        3. Use async route handlers with type annotations
      maxRetries: 1
```

**When to use it:** Code / report / analysis generation where the output must follow a specific format. Any `llm:` task where the agent exits 0 but produces poor-quality output. The validator re-runs the same command once on failure; the second output is final regardless (fail-open).

**What it does NOT replace:** `evaluatePhase` (the built-in exit-code + LLM judgment) still runs independently. `healCommand` still handles command failures (non-zero exit). The validator only fires on successful runs that produce bad content.

---

## 6. Guardrails every plan MUST respect

These come from `AGENTS.md`. A plan that violates them is a
"wrong plan" even if it executes.

- **Read `STATE.md` first.** The first task should be a `read-state` step (`type STATE.md`
  or `cat STATE.md`) so the run is grounded in current reality.
- **L1 = report-only.** Until a human explicitly enables L2, plans must NOT edit source
  code. Audit / triage / design plans are fine; implementation plans are not.
- **End with verification.** The last task must be a verify step (build / lint / tests)
  that exits 0. No verify phase = no proof the work held.
- **One concern per plan.** Don't bundle unrelated fixes. "Refactor X and fix Y and add Z"
  is three plans. Loop rule: *one fix per run, never refactor unrelated code.*
- **Code-changing plans use a git worktree** and run the project's documented tests before
  proposing a fix. Max **3 fix attempts** per item; escalate after.
- **Never** push, merge, close issues/PRs, or edit `.env` / `auth/` / `payments/` / `secrets/`
  without explicit human approval.
- **Agent tasks get the denylist as prompt instruction, not enforcement.** Agent actions
  bypass the command guard, so the denylist is prepended to every agent prompt as a
  binding instruction; hard enforcement is the `docker` workspace. Both sit under the
  L1/L2 human gates (§3B.1).
- **Paths: match the established convention.** The loop runs from the `agent-loop` project
  root, so `.\scripts\foo.ps1` (relative) is the proven, working form used by every
  `design-calendar-*.yaml` plan. **For in-loop plans (audit/maintenance/triage)**, use
  relative paths. **For cross-project build plans**, use absolute paths for `--dir` and
  `produces:`. Plan-internal references (prompt files, reports) are relative to the loop
  root for in-loop plans, or relative to `--dir` for cross-project plans. Never use `..\`
  parent-relative — it is fragile and may resolve incorrectly.

- **read-state command: `type STATE.md` is fine (relative, no quotes needed).** The loop
  now writes commands verbatim to a temp `.cmd` file before execution (see §1), so quoted
  paths like `type "D:\path with spaces\STATE.md"` work correctly. `type STATE.md` (relative,
  no quotes) is still the shortest and clearest pattern — use it.

- **Windows process spawning: understand UseShellExecute.** If your plan references scripts
  that launch executables via `System.Diagnostics.Process` (like `run-phase.ps1` launching
  `opencode`), note that npm-installed CLIs are `.cmd` shims, not `.exe` files.
  `Process.Start` with `UseShellExecute = $false` can only resolve `.exe` on `PATH` — `.cmd`
  shims are invisible. The script must set `UseShellExecute = $true` to let the shell
  resolve the shim via `PATHEXT`. Without this, implement phases fail with
  "Le fichier spécifié est introuvable" even though the script itself runs fine.
  (This is a PowerShell/.NET gotcha, not an agent-loop bug.)

### 6.1 Worktree path alignment (if a code phase creates a worktree)

When a code phase runs `git -C <vault> worktree add <dir> <branch>`, the worktree lands at
`<target>-build` (a **sibling** of `<target>`), not inside `<target>`. The plan's `command`
keeps `--dir <target>`, so every downstream phase (`test`, `review`, `evaluate`, `verify`)
looks in `<target>`, finds **nothing**, and fails — even though the code was generated
correctly one directory over.

**Rule:** if a code phase creates a git worktree, the worktree path becomes the effective
`--dir` for **all** subsequent phases that read generated code. Update every downstream
`--dir` to the worktree (e.g. `<target>-build`), or the run proceeds down a broken
dependency chain (see failure mode #7). For 6B plans where the sub-agent itself runs the
worktree command inside `opencode run`, pass the resolved worktree path back out (via a
`produces:` file the loop reads, or hardcode the known `<target>-build` name) so later
phases point at it.

---

## 7. Two plan archetypes

The loop supports two styles for **command tasks**. Pick the right one for your goal.
(Native agent-backend execution via `type: agent` is a distinct task kind, not a third
archetype — see §3B.)

### 7A. Audit / maintenance — pure shell (no LLM)

Use for scans, reports, data processing, cron jobs. All phases run `powershell.exe` or other
shell commands. Fast, deterministic, no LLM cost.

```yaml
planName: calendar-a11y-hardening
tasks:
  - id: read-state
    command: type STATE.md
    timeoutMs: 5000
  - id: scan-reality
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass
      -File .\scripts\scan-reality.ps1
      -TargetDir "D:\projects\obsidian\second brain\10-Projects\11-Active\calendar-app"
    timeoutMs: 30000
  - id: fix-contrast-tokens
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass
      -File .\scripts\fix-contrast.ps1
      -TargetDir "D:\projects\obsidian\second brain\10-Projects\11-Active\calendar-app"
    timeoutMs: 30000
    healCommand: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass
      -File .\scripts\fix-contrast.ps1 -retry
    maxRetries: 3
  - id: verify-build
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass
      -File .\scripts\verify-build.ps1
    timeoutMs: 120000
```

### 7B. Build / create — LLM-powered via `opencode run` (RECOMMENDED for apps)

Use when you need an agent to **plan, design, write code, or review**. Each phase delegates
the generative work to `opencode run`, which spawns a sub-agent with its own model. The
output flows through `.build/` files so each phase starts from fresh context (no chat drift).

The canonical template lives at `.omo/plans/build-app-pipeline.yaml`. Pattern:

### 7B.0 Resolve agents & skills from your vault — do NOT hardcode

The #1 failure mode in 6B plans is baking in a specific `--agent` name (e.g.
`code-reviewer`) that doesn't match your current vault, or that can't do what the
phase asks (see §8 #14). **Agents and skills are discovered at plan-authoring
time from your vault, not recalled from memory.** Before writing a 6B plan:

1. **Enumerate what's actually available.** Run `opencode agent list` to see the
   agent personas in your vault (and which are marked `(subagent)`). Run
   `opencode run --help` to confirm the flags your build supports — do not assume
   an agent name from a previous session still exists or still behaves the same.
2. **Check write permission per agent.** Some personas (e.g. `code-reviewer`) are
   **read-only**: they have no file-write tool, so they can *print* a verdict to
   stdout but cannot *create* the artifact file. A `produces:` gate on a phase that
   assigns such an agent will correctly FAIL (the file never appears). Cross-check
   each agent's tool capabilities against the `produces:` you intend to set.
3. **Assign, don't hardcode.** Record the resolved assignment next to each phase as
   a YAML comment so the loop and future editors know it was vault-resolved:

     # design:          agent=architect     (verify it can write) → produces .build/design.md
     # design-critique: agent=code-reviewer (read-only) → stdout redirected to artifact
     # review:          agent=code-reviewer (read-only) → stdout redirected to artifact

4. **Skills have no `opencode run` flag.** `opencode run` accepts `--agent` but
   there is **no `--skill` flag**. To give a phase specialized knowledge, either
   (a) pick an agent persona whose bundled skills cover the phase, or (b) name the
   skill(s) explicitly in the prompt and instruct the sub-agent to load them via
   its own skill tool. Verify the skill exists in your vault before referencing it
   (e.g. list available skills from your agent/skill registry).

**Rule of thumb:** generative/write phases → default agent (has write); pure
review/critique phases → read-only specialist whose stdout is **redirected** to the
artifact via `> .build/<file>.md`. Never assign a read-only agent to a
`produces:`-gated write without the redirect.

```yaml
# Cross-project 6B build plan.
# <LOOP_ROOT> = absolute path to the agent-loop project (replace this placeholder).
# Artifacts live in <LOOP_ROOT>/.build/ so BOTH the loop (the produces: gate) and every
# sub-agent (running in --dir <target>) read/write the SAME absolute files. Do NOT use
# relative .build/ — a sub-agent in --dir <target> would write to <target>/.build and the
# loop would never find it (this is why older templates silently no-op'd).
planName: my-app-build
tasks:
  - id: read-state
    command: type STATE.md
    timeoutMs: 5000

  - id: planning
    command: >-
      opencode run -m <provider/model>
      "Read <LOOP_ROOT>/.build/STATE.md if present. Write a product spec to
      <LOOP_ROOT>/.build/spec.md. Print ONLY the spec text. Exit 0 when done."
      --dir "D:\target\dir"
    timeoutMs: 180000
    produces: "<LOOP_ROOT>/.build/spec.md"

  - id: research
    command: >-
      opencode run -m <provider/model>
      "Read <LOOP_ROOT>/.build/spec.md. Research the tech stack, risks, and unknowns.
      Write findings to <LOOP_ROOT>/.build/research.md. Print ONLY the findings. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 180000
    produces: "<LOOP_ROOT>/.build/research.md"

  # design: agent=architect (verify it has file-write in your vault; if read-only,
  # drop --agent so the default agent writes the artifact).
  - id: design
    command: >-
      opencode run --agent architect -m <provider/model>
      "Read <LOOP_ROOT>/.build/spec.md and <LOOP_ROOT>/.build/research.md.
      Write a technical design to <LOOP_ROOT>/.build/design.md. Print ONLY the design. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 180000
    produces: "<LOOP_ROOT>/.build/design.md"

  # design-critique: code-reviewer is READ-ONLY (no file-write tool). The shell redirect
  # `> <LOOP_ROOT>/.build/design-critique.md` captures its stdout into the artifact so the
  # produces: gate is satisfied without the agent ever needing write permission.
  - id: design-critique
    command: >-
      opencode run --agent code-reviewer -m <provider/model>
      "Read <LOOP_ROOT>/.build/design.md and <LOOP_ROOT>/.build/spec.md. Critique against
      the spec. Print a verdict with APPROVE/REVISE and P0-P2 issues."
      --dir "D:\target\dir"
      > "<LOOP_ROOT>/.build/design-critique.md"
    timeoutMs: 120000
    produces: "<LOOP_ROOT>/.build/design-critique.md"

  # Read the critique so code avoids the flagged issues (closes the feedback loop).
  - id: code
    command: >-
      opencode run -m <provider/model>
      "Read <LOOP_ROOT>/.build/design.md, <LOOP_ROOT>/.build/spec.md, and
      <LOOP_ROOT>/.build/design-critique.md. Implement the app in the working directory
      (--dir target). Write the diff to <LOOP_ROOT>/.build/code.diff. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 300000
    produces: "<LOOP_ROOT>/.build/code.diff"
    healCommand: >-
      opencode run -m <provider/model>
      "Re-read <LOOP_ROOT>/.build/code.diff and the failing build output; fix the failures.
      Exit 0." --dir "D:\target\dir"
    maxRetries: 3

  # review: code-reviewer is READ-ONLY — redirect its stdout to the artifact.
  - id: review
    command: >-
      opencode run --agent code-reviewer -m <provider/model>
      "Read <LOOP_ROOT>/.build/code.diff and <LOOP_ROOT>/.build/design.md. Code review:
      correctness, security, readability, design adherence. Print findings."
      --dir "D:\target\dir"
      > "<LOOP_ROOT>/.build/review.md"
    timeoutMs: 120000
    produces: "<LOOP_ROOT>/.build/review.md"

  # verify: prefer a REAL shell build+test that exits non-zero on failure (see §5).
  # Wrapping the build in `opencode run` hides failures behind a 0 exit code (self-grading).
  - id: verify
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass
      -Command "Set-Location 'D:\target\dir'; bun run build; if ($LASTEXITCODE -ne 0) { exit 1 }; bun test"
    timeoutMs: 120000
```

**Agent specialization (`--agent` flag):**
Use `--agent <name>` to route a phase to a specialized persona. **Resolve `<name>` from
`opencode agent list` at authoring time — do not copy a name from an old plan** (see §7B.0).

| Phase | `--agent` | Write? | Why / caveat |
|---|---|---|---|
| design | `architect` | verify | System design. Confirm `architect` has file-write in your vault; if read-only, drop `--agent` so the default agent writes the artifact. |
| design-critique | `code-reviewer` | read-only | Design audit against spec. **Read-only: redirect its stdout to the artifact** (`> .build/...md`) so `produces:` is satisfied. |
| review | `code-reviewer` | read-only | Code review (correctness, security). Same redirect pattern. |
| code / fix | _(none)_ | yes (default) | Subagents like `react-expert` fall back to default; the default agent has file-write, so it can produce diffs/artifacts. |

**Read-only personas cannot satisfy a `produces:` gate on their own** — they print to stdout
but never create files. For critique/review phases this is fine *because* the shell redirect
captures stdout into the artifact. For any phase that must *create* a file, use the default
agent (has write) or a persona you have verified has write permission.

Agents labeled `(subagent)` in `opencode agent list` can still be used with `--agent`. Only
`react-expert` is known to reject and fall back. Test new agents with a quick run, and check
each persona's tool list for a file-write capability before assigning an artifact-producing phase.

**Key differences from 6A:**
- Phases use `opencode run` instead of `powershell.exe` — the LLM does the generative work
- Model is pinned with `-m <provider/model>` (avoids provider auth mismatches)
- Timeouts are larger (3–5 min per LLM phase, 10 min for code gen)
- Each phase reads the `.build/` artifacts from previous phases — zero context drift
- Add `healCommand` + `maxRetries` on `code` and `verify` stages

**Known failure modes of the 6B archetype (and how to prevent them):**

| # | Failure | Symptom | Prevention |
|---|---|---|---|
| 1 | **Silent no-op** | Code phase exits 0 but produces no files. Tests pass on old code. | Add `produces:` with the expected diff/artifact path (absolute, see §7B.0). The executor fails the phase if the file is missing. |
| 2 | **Disconnected critique** | Design-critique finds problems; code phase never reads the critique and ships the same bugs. | Every code prompt must include: "Also read {critique-file} — it tells you what to avoid." |
| 3 | **Phantom fields** | Architect invents field names that don't exist in the real source types (`totalTasks`, `triggers[]`, `stderr`). | Before the design phase, inject real source files as input: "Read src/types.ts before writing any field names. Do not invent fields that don't exist in these types." |
| 4 | **Self-grading** | The agent that builds decides "done." No independent gate catches an empty or wrong result. | Use `produces:` as a deterministic check + a separate verify phase that runs the real build/test (not `opencode run` wrapping the build). |
| 5 | **Agent write restriction** | A read-only persona (e.g. `code-reviewer`) is told to "write X.md"; it only prints to stdout, so the file never appears and `produces:` FAILs — but the phase is already wasted. | For read-only personas, **redirect stdout to the artifact** (`> .build/x.md`) so the shell — not the agent — creates the file. Or use the default agent for write phases. See §7B.0 / §8 #14. |
| 6 | **Subprocess death not detected** | The inner `opencode run` child exited, but the bun parent (running the executor) blocked forever with no timeout firing; the wait never resolved. | Set `timeoutMs` strictly above the inner LLM's max execution time, and ensure the executor has its own subprocess timeout. A hung child must not be able to wedge the loop (see §7B.1). |
| 7 | **Worktree path ≠ `--dir` path** | The code phase creates a git worktree at `<target>-build` (sibling), but downstream phases still `--dir <target>` and find nothing. | If a code phase creates a worktree, the worktree path becomes the effective `--dir` for ALL downstream phases. Update every subsequent `--dir` to the worktree (see §6.1). |
| 8 | **Intermediate `produces`-fail doesn't halt** | design-critique FAILs but the loop proceeds to `code` blind, depending on a file that doesn't exist. | Decide halt-vs-continue policy explicitly (see §5 + checklist #18). A failed artifact gate should stop the run or re-run the upstream phase, not silently continue down a broken dependency 
chain. (§6 Guardrails) |

**6B.1 Execution internals: subprocess wait & timeouts (why #6 matters)**
Each phase's `command` runs in a child process (a temp `.cmd` on Windows). The executor
`await`s that process; it does **not** poll. Consequences:

- **A detached/exited child the executor can't observe will wedge the phase forever.**
  If the inner `opencode run` spawns a grandchild and exits while the grandchild keeps the
  pipe open, the parent wait never resolves and no timeout fires. Mitigate by (a) keeping
  `timeoutMs` above the inner LLM's worst-case runtime, and (b) ensuring the executor's
  subprocess wrapper applies its own kill timeout.
- **`timeoutMs` is the phase budget, not the child's.** The inner `opencode run` has its own
  model latency; your plan's `timeoutMs` must be ≥ that. A 120s phase wrapping a 180s inner
  run will be killed mid-generation.
- **Prefer `opencode run` to finish and exit on its own.** Don't pipe it into long-running
  tail/stream commands that keep the pipe open after the work is done.

**Which to use:**
| Goal | Pattern |
|---|---|
| Audit, triage, cron, data pipeline | 6A — shell-only |
| Build a new app, feature, or component | 6B — LLM-powered via `opencode run` |
| Mixed (e.g. AI plan + shell execute) | Combine both: `opencode run` for generative phases, then `powershell.exe` for install/build/test |

---

## 8. Anti-patterns — "wrong plans" and the fix

| # | Wrong plan | Why it breaks | Fix |
|---|---|---|---|
| 1 | Missing `read-state` first task | Run is ungrounded; acts on stale reality | Add a `type STATE.md` task at the top |
| 2 | `command` omitted on an LLM task | Executor has nothing to run; LLM has no stdout to judge | Point `command` at the scan/read step the LLM should assess |
| 3 | `type "D:\path with spaces\STATE.md"` | Now fixed — the temp `.cmd` file preserves quotes. Previously `cmd /d /c` would strip them. | `type STATE.md` (relative) is still the clearest pattern |
| 4 | No verify/build task at the end | Plan "passes" with no proof the change held | Add `verify-build` (or lint/tests) as final task, exit 0 |
| 5 | Build task with default 30s timeout | Killed at 30s → false failure | Set `timeoutMs: 120000` for builds |
| 6 | Bundles 3 unrelated fixes | Violates "one fix per run"; hard to verify/rollback | Split into separate plans |
| 7 | Edits source in L1 mode | AGENTS.md forbids it until L2 | Keep L1 plans audit-only; enable L2 for code |
| 8 | LLM prompt doesn't request `passed/reason/confidence` | Report is empty/garbage | Mandate the JSON shape in the prompt |
| 9 | Hand-writes `status`/`durationMs` | Overwritten by executor; misleading | Let the executor own those fields |
| 10 | No `healCommand`/`maxRetries` on fix tasks | One failure kills the run; no recovery | Add `healCommand` + `maxRetries: 3` (see `minimal-fix`) |
| 11 | Duplicate `id`s | Breaks resume/checkpoint | Unique ids only |
| 12 | `run-phase.ps1` uses `UseShellExecute = $false` to launch opencode | npm `.cmd` shim is invisible to `Process.Start` | Set `UseShellExecute = $true` in the script |
| 13 | `type ".\STATE.md"` (quoted relative) | Stale — the temp `.cmd` file fix preserves quotes. `.\` prefix is unnecessary, not broken. | Use `type STATE.md` (no prefix) for clearest read-state |
| 14 | `--agent <read-only>` on a `produces:`-gated write phase | The persona (e.g. `code-reviewer`) has no file-write tool; told to "write X.md" but only prints to stdout → file never appears → `produces:` FAILs (or the phase 
runs blind). | Verify each agent's write permission before assigning artifact output (§7B.0). For read-only personas, redirect stdout to the artifact (`> .build/x.md`); for write phases use the default agent. |

---

## 9. Pre-flight checklist

Before saving a plan, confirm:

- [ ] `planName` present and unique
- [ ] Every task has a unique `id` and either a `command` that exits 0 or (`type: agent`) a `prompt`
- [ ] First task reads `STATE.md`
- [ ] Paths use `.\scripts\...` convention (relative to loop root) for scripts; `type STATE.md` for read-state
- [ ] Builds/installs have `timeoutMs: 120000`
- [ ] Exactly one concern per plan
- [ ] Last task is a verify/build that exits 0 (and is NOT a `type: agent` task — §3B)
- [ ] Agent tasks: `prompt` present, first/last tasks are not agent tasks, `workspace.type` is `local`/`docker`, docker used for untrusted work, `model:` right-sized for the task (§3B)
- [ ] Every `llm:` prompt demands `{passed, reason, confidence}`
- [ ] Fix tasks carry `healCommand` + `maxRetries` (L2 only)
- [ ] Generative phases (code, design) have `produces:` set to the expected diff/artifact path
- [ ] Code phase prompts include "also read the critique file" to close the feedback loop
- [ ] Design phase prompts include "read the real source types and do not invent fields"
- [ ] No source edits unless L2 is enabled
- [ ] Did not hand-author `status`/`durationMs`/`completedAt`
- [ ] **#17** Every `--agent` used in a generative/write phase has file-write permission — cross-check each agent's tool capabilities against its `produces:` (§7B.0 / §8 #14)
- [ ] **#18** `produces:`-failure behavior is decided — does the loop **halt** the run, or continue down a broken dependency chain? (failure mode #8)
- [ ] **#19** Worktree path == downstream `--dir` — if a code phase creates a git worktree, every subsequent phase `--dir`s into the worktree, not the original target (§6.1 / failure mode #7)
- [ ] **#20** Subprocess timeout < plan timeout — the inner `opencode run` has its own latency; the phase `timeoutMs` must be ≥ the inner LLM's max execution time, and the executor must have its own subprocess kill timeout 
(§7B.1 / failure mode #6)

---

## 10. Where this lives

`agent-loop/PLAN-WRITING-GUIDE.md`, referenced from `AGENTS.md` so the loop loads it
automatically before every run. Update this guide when the executor schema changes
(`src/types.ts` / `src/plan-executor.ts`).
