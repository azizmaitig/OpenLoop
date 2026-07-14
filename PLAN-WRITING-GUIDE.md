# Plan Writing Guide — agent-loop

A reference for authoring `.plan.yaml` files that the agent-loop executes correctly.
If the loop keeps producing "wrong plans," it is almost always because one of the
rules below was violated. Read this before writing or editing any plan under `plans/`.

> Loaded automatically by the loop via `AGENTS.md`. When in doubt, follow this guide
> over any guess.

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
| `tasks[].command` | yes | — | Shell command. **Must exit 0.** Always executed, even with `llm`. |
| `tasks[].timeoutMs` | no | `30000` | Bumps to `120000` for builds / installs / anything slow. |
| `tasks[].llm.provider` | no | `openai` | `openai` \| `anthropic` \| `opencode`. |
| `tasks[].llm.prompt` | no* | `''` | *Required if `llm` present. Must ask for `passed`/`reason`/`confidence`. |
| `tasks[].llm.mcpServer` + `tool` | no | — | Alternative to `provider`: call an MCP tool instead of an LLM. |
| `tasks[].healCommand` | no | — | Recovery command run when the task fails (see `minimal-fix` skill). |
| `tasks[].maxRetries` | no | — | Retry count before escalation. |
| `tasks[].produces` | no | — | **Artifact gate.** Path to a file this task MUST produce. After the command exits 0, the executor checks this file exists and fails the phase if missing. Catches silent failures where the LLM exits 0 without producing the expected artifact. |
| `tasks[].producedMustHaveContent` | no | `false` | When `true`, the `produces` file must also be non-empty (zero-length file fails the gate). |

Do **not** author `status`, `durationMs`, `completedAt`, `confidence`, or `dependsOn` by
hand (except `dependsOn` — see §4A) — the executor owns the rest.

---

## 4A. Parallel phases via `dependsOn` (Feature A)

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

## 4B. Reusable composite sequences (Feature B)

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

---

## 5. Guardrails every plan MUST respect

These come from `AGENTS.md` and `loop-constraints.md`. A plan that violates them is a
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
- **Paths: match the established convention.** The loop runs from the `agent-loop` project
  root, so `.\scripts\foo.ps1` (relative) is the proven, working form used by every
  `design-calendar-*.yaml` plan. Use it. Only switch to absolute paths if you know the
  loop will run from a different cwd. Plan-internal references (prompt files, reports) are
  also relative to the loop root.

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

---

## 6. Two plan archetypes

The loop supports two styles. Pick the right one for your goal.

### 6A. Audit / maintenance — pure shell (no LLM)

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

### 6B. Build / create — LLM-powered via `opencode run` (RECOMMENDED for apps)

Use when you need an agent to **plan, design, write code, or review**. Each phase delegates
the generative work to `opencode run`, which spawns a sub-agent with its own model. The
output flows through `.build/` files so each phase starts from fresh context (no chat drift).

The canonical template lives at `.omo/plans/build-app-pipeline.yaml`. Pattern:

```yaml
planName: my-app-build
tasks:
  - id: read-state
    command: type STATE.md
    timeoutMs: 5000

  - id: planning
    command: >-
      opencode run -m <provider/model> "Read .build/STATE.md if present. Write a
      product spec to .build/spec.md. Exit 0 when done." --dir "D:\target\dir"
    timeoutMs: 180000

  - id: research
    command: >-
      opencode run -m <provider/model> "Read .build/spec.md. Research the tech stack,
      risks, and unknowns. Write findings to .build/research.md. Exit 0." --dir "D:\target\dir"
    timeoutMs: 180000

  - id: design
    command: >-
      opencode run --agent architect -m <provider/model> "Read .build/spec.md and
      .build/research.md. Write a technical design to .build/design.md. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 180000

  - id: design-critique
    command: >-
      opencode run --agent code-reviewer -m <provider/model> "Read .build/design.md
      and .build/spec.md. Critique against the spec. Write verdict to
      .build/design-critique.md with APPROVE/REVISE and P0-P2 issues. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 120000

  - id: code
    command: >-
      opencode run -m <provider/model> "Read .build/design.md and .build/spec.md.
      Implement the app in the working directory. Write a diff to .build/code.diff.
      Exit 0." --dir "D:\target\dir"
    timeoutMs: 300000
    healCommand: >-
      opencode run -m <provider/model> "Re-read .build/code.diff and fix failures.
      Exit 0." --dir "D:\target\dir"
    maxRetries: 3

  - id: review
    command: >-
      opencode run --agent code-reviewer -m <provider/model> "Read .build/code.diff
      and .build/design.md. Code review: correctness, security, readability, design
      adherence. Write findings to .build/review.md. Exit 0." --dir "D:\target\dir"
    timeoutMs: 120000

  - id: verify
    command: >-
      opencode run -m <provider/model> "Run the project's build + tests and confirm
      exit 0. Exit 0 only if they pass." --dir "D:\target\dir"
    timeoutMs: 120000
```

**Agent specialization (`--agent` flag):**
Use `--agent <name>` to route a phase to a specialized agent persona. Confirmed working:

| Phase | `--agent` | Why |
|---|---|---|
| design | `architect` | System design, architecture decisions |
| design-critique | `code-reviewer` | Design audit against spec |
| review | `code-reviewer` | Code review (correctness, security) |
| code / fix | _(none — skip)_ | Subagents like `react-expert` fall back to default |

Agents labeled `(subagent)` in `opencode agent list` can still be used with `--agent` — only
`react-expert` is known to reject and fall back. Test new agents with a quick run.

**Key differences from 6A:**
- Phases use `opencode run` instead of `powershell.exe` — the LLM does the generative work
- Model is pinned with `-m <provider/model>` (avoids provider auth mismatches)
- Timeouts are larger (3–5 min per LLM phase, 10 min for code gen)
- Each phase reads the `.build/` artifacts from previous phases — zero context drift
- Add `healCommand` + `maxRetries` on `code` and `verify` stages

**Known failure modes of the 6B archetype (and how to prevent them):**

| # | Failure | Symptom | Prevention |
|---|---|---|---|
| 1 | **Silent no-op** | Code phase exits 0 but produces no files. Tests pass on old code. | Add `produces:` with the expected diff/artifact path. The executor fails the phase if the file is missing. |
| 2 | **Disconnected critique** | Design-critique finds problems; code phase never reads the critique and ships the same bugs. | Every code prompt must include: "Also read {critique-file} — it tells you what to avoid." |
| 3 | **Phantom fields** | Architect invents field names that don't exist in the real source types (`totalTasks`, `triggers[]`, `stderr`). | Before the design phase, inject real source files as input: "Read src/types.ts before writing any field names. Do not invent fields that don't exist in these types." |
| 4 | **Self-grading** | The agent that builds decides "done." No independent gate catches an empty or wrong result. | Use `produces:` as a deterministic check. Never rely on a sub-agent's own "I'm done" signal as the only gate. |

**Which to use:**
| Goal | Pattern |
|---|---|
| Audit, triage, cron, data pipeline | 6A — shell-only |
| Build a new app, feature, or component | 6B — LLM-powered via `opencode run` |
| Mixed (e.g. AI plan + shell execute) | Combine both: `opencode run` for generative phases, then `powershell.exe` for install/build/test |

---

## 7. Anti-patterns — "wrong plans" and the fix

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

---

## 8. Pre-flight checklist

Before saving a plan, confirm:

- [ ] `planName` present and unique
- [ ] Every task has a unique `id` and a `command` that exits 0
- [ ] First task reads `STATE.md`
- [ ] Paths use `.\scripts\...` convention (relative to loop root) for scripts; `type STATE.md` for read-state
- [ ] Builds/installs have `timeoutMs: 120000`
- [ ] Exactly one concern per plan
- [ ] Last task is a verify/build that exits 0
- [ ] Every `llm:` prompt demands `{passed, reason, confidence}`
- [ ] Fix tasks carry `healCommand` + `maxRetries` (L2 only)
- [ ] Generative phases (code, design) have `produces:` set to the expected diff/artifact path
- [ ] Code phase prompts include "also read the critique file" to close the feedback loop
- [ ] Design phase prompts include "read the real source types and do not invent fields"
- [ ] No source edits unless L2 is enabled
- [ ] Did not hand-author `status`/`durationMs`/`completedAt`

---

## 9. Where this lives

`agent-loop/PLAN-WRITING-GUIDE.md`, referenced from `AGENTS.md` so the loop loads it
automatically before every run. Update this guide when the executor schema changes
(`src/types.ts` / `src/plan-executor.ts`).
