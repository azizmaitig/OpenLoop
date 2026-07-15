# Agentic-Driven Loop — guide

> **Read `PLAN-WRITING-GUIDE.md` first.** This is the subcase for **agentic (LLM/subagent-driven) build loops** — the §6B archetype — distilled from a real run (`plans/notes-web-hybrid-build.yaml`) that exposed three gaps the general guide does not fully close. Every correction below documents the *why* (the failure we hit) so you don't repeat it.

`AGENTIC DRIVEN LOOP` = a plan where an LLM/subagent does the generative work (`opencode run`, optionally `--agent <persona>`), and adjacent shell tasks do install/build/test. It is the §6B pattern, hardened.

---

## 0. Intake — interrogate the user BEFORE writing any plan

**Directive to the LLM reader:** when you use this guide to help a user build an agentic-driven loop plan, do **NOT** emit a plan immediately. Interrogate the user first to scope the project correctly. A plan built on guessed requirements either fails the §4 gates or violates L1/L2.

Ask, then **wait for answers** — do not fabricate them.

### Minimum required questions

1. **Project kind** — web app (SPA + API), API-only, CLI, library, or UI component? This decides the phase set (e.g. no `code-frontend` for an API-only build).
2. **Target directory** — needed for every `opencode run --dir` and `produces:`. For **cross-project builds** (this guide's primary use case), use the full absolute path (e.g. `D:\target\dir`). For **in-loop plans** (audit/maintenance), relative paths work. See §6 for full convention.
3. **Stack** — prescribed (e.g. React + Vite + Express + SQLite) or let the loop research it in the `research` phase?
4. **Persistence** — does it need a database? Which? (If SQLite-on-Bun, apply §5.)
5. **Scope boundaries** — in-scope / out-of-scope (auth? multi-user? payments? cloud sync?). Prevents scope creep and L1 violations.
6. **L1 or L2?** — are you allowed to edit source? If L1, strip the `code-*` tasks (§7). If L2, confirm worktree + verifier gate.
7. **Acceptance criteria** — how do we know it is done? The user must supply — or the planning phase must emit — **machine-checkable acceptance criteria**: observable, deterministic conditions a script or sub-agent can evaluate (tests pass, build exits 0, endpoint returns 200, CRUD survives restart, lint produces no errors). Vague criteria like "looks done" or "feels complete" are not acceptable.
8. **Existing artifacts** — spec / design / critique files to feed in, or start greenfield?

### Required output

The intake **must produce** an explicit acceptance-criteria block — 3+ concrete, machine-checkable conditions — that gets embedded in the plan's `verify` phase and in the `verification` section of the template. This block is what the independent verifier evaluates. Without it, verification is subjective and the plan is incomplete.

Example:
```yaml
acceptanceCriteria:
  - "`bun test` exits 0 (all tests pass)"
  - "`bun run build` exits 0 (production build succeeds)"
  - "Server starts and responds HTTP 200 on GET /health"
  - "CRUD operations (create → read → update → delete) survive a restart"
```

### Behavior

- Only after the user answers, **construct a phase graph** from the intake signals — do not blindly fill a fixed template. See §3 for graph construction rules.
- If the user is terse, ask the **highest-leverage unknowns first**: project kind + absolute target path + L1/L2 + persistence + acceptance criteria. Propose defaults for the rest, but **confirm before writing the plan file**.
- Never assume the stack, the path, the L1/L2 mode, or what "done" means. These are the inputs that most often produce a broken or guardrail-violating plan.

## 1. What makes it "agentic"

| | §6A (shell-only) | Agentic-driven (this guide) |
|---|---|---|
| Generative work | none | `opencode run` subagents plan/design/write/review |
| Determinism | high | lower — the LLM can exit 0 without correct output |
| Where it breaks | rarely | silent no-op, disconnected critique, fragile verify gate |

You adopt this pattern for capability, and you **pay for it in verification**. All three corrections in §4 exist to make LLM failure *detectable* instead of silently passing.

---

## 2. When to use

- ✅ Build a new app / feature / component (greenfield or near-greenfield).
- ❌ Audit, triage, cron, data pipeline → use §6A (shell-only). Cheaper, deterministic.
- ❌ In **L1** mode → this pattern *edits source*. L1 is report-only. Must run under **L2** (human-enabled, git worktree, verifier gate). See §7.

---

## 2. Assign agents & skills

A plan is only as good as the agent personas and skills driving each phase. When you build a plan from this guide:

- **`--agent` takes a registered persona NAME** (`architect`, `code-reviewer`, etc.), never a filesystem path. Run `opencode agent list` to see available personas. See the reference mapping below for confirmed-working assignments.
- **Code and fix phases do NOT get `--agent`** — they use the default agent. Only design/review/critique phases use specialized personas.
- **Load relevant skill(s)** for every generative task by naming the skill explicitly in the phase prompt so the sub-agent invokes it.
- Do NOT leave phases unassigned with no relevant skills.

### Skill locations (check in this priority order)

1. `.opencode/skills/` — project skills (**PRIMARY**)
2. `00-System/Skills/` — legacy ECC skills
3. `.agents/skills/` — user-installed
4. `.claude/skills/` — user-installed (mostly overlap)
5. `.opencode/skills/obsidian-skills/` — Obsidian-specific

### Reference mapping — full-stack web build (notes-web case)

| Phase | `--agent` (persona name) | Skills to load (name) |
|---|---|---|
| planning | `planner` | `planning-and-task-breakdown`, `spec-driven-development` |
| research | — | `research`, `source-driven-development` |
| design | `architect` | `api-and-interface-design`, `spec-driven-development` |
| design-critique | `code-reviewer` | `code-review-and-quality` |
| code-backend | — | `api-and-interface-design`, `security-and-hardening`, `test-driven-development` |
| code-frontend | — | `frontend-ui-engineering`, `impeccable` |
| install-deps | — | (shell only) |
| test | — | `verification-before-completion`, `test-driven-development` |
| review | `code-reviewer` | `code-review-and-quality`, `security-review` |
| evaluate | — | `verification-before-completion` |
| verify | — | `verification-before-completion` |

### Adaptation rule
For non-web project kinds, swap the skills to match the phase's real work — never assign a skill that doesn't apply:
- **CLI / library** → drop `frontend-ui-engineering`; add `code-simplification`, `writing-skills` as relevant.
- **UI component** → `frontend-ui-engineering` + `ui-ux-pro-max` (lean heavily on these).
- **API-only** → `api-and-interface-design` + `security-and-hardening`; no frontend skills.
- **Anything touching secrets/auth** → add `security-and-hardening` + `security-review` regardless of kind.

> When you write the §8 template, merge this mapping into each phase: add `--agent <persona>` for design/review phases and the listed skill(s) by name in the prompt. Code/get phases get NO `--agent`. Do not ship a plan where a generative phase has no relevant skill loaded.

## 3. Phase graph — constructed by the planner from intake signals

Phases run sequentially through the executor (`init → run → verify → done`). The **planner's job** is to decide which phases the graph needs based on the §0 intake outputs — project kind, stack, risk profile, L1/L2 mode. This is NOT a fixed template. A full-stack web app needs different phases than an API-only microservice or a CLI tool.

### Universal rules (apply to every graph)

- `read-state` MUST be first (§5 of the general guide).
- `verify` MUST be last and exit 0 — no verify phase = no proof the work held.
- Every generative phase has `produces:` + `producedMustHaveContent: true`.
- Code/fix phases get NO `--agent`; design/review phases use a registered persona name.
- L2-only projects require `create-worktree` (before code) and `verify-independent` (before final verify).
- Every test/verify shell command redirects shim stderr (`2>&1 | Out-Null`) before checking `$LASTEXITCODE`.

### Graph construction rules (how the planner decides)

| Intake signal | What the planner does |
|---|---|
| Project kind = **full-stack web app** (SPA+API) | Include: planning, research, design, design-critique, code-backend, code-frontend, install-deps (server + client), test, review, verify. Add `verify-independent` if L2. |
| Project kind = **API-only** | Drop code-frontend, drop client install/build. Skills: no frontend skills. |
| Project kind = **CLI / library** | Drop code-frontend, drop design-critique (unless spec is complex). Skills: `code-simplification`, `writing-skills`. Timeouts shorter (code gen ≤ 300s). |
| Project kind = **UI component** | Keep design, design-critique, code-frontend. Drop research, install-deps simpler. Skills: `frontend-ui-engineering`, `ui-ux-pro-max`. |
| Stack = **known/prescribed** | Skip `research` phase — merge planning → design directly. |
| Stack = **unknown or risky** | Keep `research` phase. Consider adding a `prototype` or `spike` phase before design. |
| Security-sensitive (auth, payments, PII) | Add `security-review` after code, add `security-and-hardening` to code phase skills. |
| L2 enabled | Add `create-worktree` before code phases, add `verify-independent` (separate agent, zero shared context) before final `verify`. |
| L1 only | Strip all code/build/install phases. Stop at design-critique/review/evaluate. |
| Existing artifacts provided | Feed them as input to the relevant phases (skip generation of what's already written). |

### Example: full-stack web app (notes-web case)

This is what a full-stack web app phase graph looks like — one concrete output of the construction rules above, not the universal template:

```
read-state          type STATE.md                         (ground the run)
planning            opencode run → .build/spec.md         (produces: spec.md)
research            opencode run → .build/research.md      (produces: research.md)
design              opencode run --agent architect        (produces: design.md)
design-critique     opencode run --agent code-reviewer     (produces: design-critique.md)
code-backend        opencode run  → materialize files     (produces: src/server.ts)
code-frontend       opencode run  → materialize files     (produces: src/client.ts)
install-deps        powershell bun install (server+client)
test                powershell bun test + bun run build   (robust gate — §4.3)
review              opencode run --agent code-reviewer     (produces: review.md)
verify-independent  opencode run --agent code-reviewer     (produces: verdict-independent.md)
evaluate            opencode run → .build/evaluate.md      (produces: evaluate.md, advisory)
verify              powershell bun test + bun run build    (deterministic final gate)
```

Specialize: `design` → `architect`, `design-critique`/`review`/`verify-independent` → `code-reviewer`. Code phases → no `--agent`. See §8 for the full YAML of this graph.

---

## 4. Three non-negotiable corrections (the lessons)

These are the gaps that made `notes-web-hybrid-build.yaml` report `test`/`verify` as **fail** even though the app was correct. Each is a concrete failure we observed.

### 4.1 `produces:` gate on EVERY generative task

**Why (failure observed):** the generated backend originally shipped `node:sqlite` (does not exist on Bun) and `toBeUndefined()` (bun:sqlite returns `null`, not `undefined`). The `code-backend` task had **no `produces:` gate**, so the executor marked it `pass` on exit 0 — the wrong code was never caught at the code phase. Only the fragile shell gate (§4.3) surfaced it later, and unreliably.

**Rule:** every task that writes an artifact declares both:
```yaml
produces: D:\projects\obsidian\second brain\10-Projects\11-Active\loop-factory\notes-web\.build\code-backend.diff
producedMustHaveContent: true   # zero-length file fails the gate
```
This catches the silent no-op (general-guide Anti-pattern #1) *and* forces the LLM to actually emit the file before the phase can pass.

### 4.2 Code prompts MUST read the critique

**Why (failure observed):** `design-critique` correctly flagged the SQLite API risk, but the `code-backend`/`code-frontend` prompts never said "also read `design-critique.md`". The codegen ignored the critique and shipped the exact bug it warned about (general-guide Anti-pattern #2 — disconnected critique).

**Rule:** every code/design-implementation prompt ends with:
> Also read `D:\projects\obsidian\second brain\10-Projects\11-Active\loop-factory\notes-web\.build\design-critique.md` — it lists what to avoid. Do not repeat its P0/P1 issues.

### 4.3 Robust verify gate — never trust `$LASTEXITCODE` raw after a shim

**Why (failure observed):** `bun` on this machine is the npm shim `bun.ps1`. It writes a blank line to **stderr**. Under the executor's temp-`.cmd` → `powershell -Command` nesting, that stderr trips a `NativeCommandError`, which corrupts the exit-code gate so a *passing* `bun test` is recorded `fail`. We saw the exact signature:
```
bun.exe :
Au caractère C:\Users\azizm\AppData\Roaming\npm\bun.ps1:14 : 3
+   & "$basedir/node_modules/bun/bin/bun.exe"   $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```
The command then completed successfully (15 pass / 0 fail, build OK) — but the gate had already flipped. This is the §5 PowerShell/.NET gotcha, in the field.

**Fix (apply to every `test`/`verify` task):** redirect stderr *before* checking exit code. Any of:
```powershell
# redirect to null, then trust exit code
bun test 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }
# OR assert on output instead of exit code
bun test 2>&1 | Select-String "0 fail" | Out-Null; if (-not $?) { exit 1 }
# OR call the .exe directly, bypassing the .ps1 shim
& "$env:USERPROFILE\AppData\Roaming\npm\node_modules\bun\bin\bun.exe" test
```
`npm`/`npx`/`bun` are all `.ps1`/`.cmd` shims — **same rule applies to all of them.**

### 4.4 Code must be materialized (or applied)

**Why (failure observed):** the code phases wrote a `.diff` file to `.build/` — but **no subsequent phase ever applied that diff**. The `produces:` gate confirmed the diff existed (non-empty), the LLM exited 0, the phase passed — yet the actual source tree was never touched. This is a superset of the general-guide "silent no-op" anti-pattern: the diff was produced, but it was never materialized. The build/test phases then ran against the *old* source and passed, giving a false sense of completion.

**Rule:** every code-writing phase must be followed by an **apply-diff** phase (or the code phase itself must materialize files directly into `--dir`). When using diff-based output:

```yaml
  - id: apply-backend-diff
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir'; git apply .build/code-backend.diff; if ($LASTEXITCODE -ne 0) { exit 1 }"
    timeoutMs: 30000
```

Alternatively, make the code phase write files directly (omit the diff step) and declare `produces:` on a built artifact. Either way, a **real file on disk** — not a diff artifact — must be what `produces:` checks, and an install/test/verify phase must execute *after* the materialization.

The `produces:` gate on a generative phase is necessary but not sufficient. Add an explicit apply/materialize phase, or change the generative phase to write files, not diffs.

### 4.5 L2: worktree + independent verifier

**Why (failure observed):** the original notes-web plan ran code phases inside the main working tree with no independent verifier. The verifying agent shared context with the coding agent (same session, same model), so it graded the same blind spots the coder had. No worktree isolation meant a bad fix could corrupt the main branch irreversibly. No independent verifier meant subjective "looks done" was the only gate.

**Rule (binding for L2):**

1. **Every code-changing plan MUST run inside a git worktree.** Create it at the start of the code phase, discard on REJECT. The main branch stays clean.

2. **A SEPARATE agent/session must verify the output before merge.** Ideally a different model, zero shared context with the coding agent. This verifier reads the spec's acceptance criteria (the block produced by §0 intake) and issues APPROVE or REJECT. Coding and verifying in the same session produces a "self-grading" trap (see §6B failure mode #4).

3. **Implementation in the plan template:**
   - Add a `create-worktree` phase before the code phases.
   - Add a `verify-independent` phase (separate `opencode run`, ideally different `-m <provider/model>`, reads the acceptance-criteria block from spec, zero shared context) **before** the final `verify` shell gate.
   - The final `verify` shell gate (build/tests) is the deterministic gate; `verify-independent` is the peer-review gate. Both must pass.

4. **If worktree creation fails or the independent verifier REJECTs** after maxRetries, the plan fails terminal — do not merge.

---

## 5. SQLite-on-Bun note (if your app persists)

The notes-web backend persisted notes in SQLite. The gotchas that bit the run:

- Use `import { Database } from "bun:sqlite"` — **NOT** `node:sqlite` (does not exist on Bun; the heal command spent retries fixing exactly this).
- `bun:sqlite` returns **`null`** (not `undefined`) for missing rows → assert with `toBeNull()`, never `toBeUndefined()`.
- Use `:memory:` for CRUD tests to avoid Windows file-locking; use a unique temp file **only** for the persistence-across-reconnect test.

---

## 6. Path convention

Path convention depends on whether the plan is **in-loop** (maintenance, triage, audit) or **cross-project** (build a new app, add a feature to a different repo).

### In-loop plans (audit / maintenance / triage)

The loop runs from the `agent-loop` project root:
- Use **relative** paths: `.\scripts\foo.ps1` for scripts, `type STATE.md` for read-state.
- Plan-internal references (prompt files, reports) are relative to the loop root.
- This is the proven form used by every existing `design-calendar-*.yaml` plan.

### Cross-project build plans (agentic-driven builds)

The target is external to the loop:
- **`opencode run --dir` takes an absolute path** (`D:\path\to\target`). Never use `..\` parent-relative — it is fragile.
- **`produces:` paths are absolute** (matching `--dir`).
- `.build/` internal references inside prompts are relative to `--dir` (the target), *not* the loop root.

### Universal rules

- `read-state` stays `type STATE.md` (relative, no quotes) — the executor writes commands to a temp `.cmd` that preserves quotes, so this is the clearest form.
- `.\` prefix is unnecessary but not broken. `type STATE.md` (no prefix) is the clearest pattern.

---

## 7. L2 requirement

This pattern edits source, so it is only valid when a human has explicitly enabled **L2**. Under L2:
- Every code-changing task runs inside a git worktree.
- A verifier sub-agent APPROVE/REJECTs before merge.
- Max 3 fix attempts per item; escalate after.

If you are in L1, stop at `design-critique`/`review`/`evaluate` — those are report-only. Do not include `code-*` tasks.

---

## 8. Example: full-stack web app template (v2)

A concrete YAML output of the §3 graph construction rules for a **full-stack web app** (SPA + API, Bun/TypeScript, L2-enabled). This is ONE possible phase graph — not the universal template. For other project kinds, apply the §3 construction rules to add/remove phases and swap skills.

Uses `<provider/model>` placeholders — replace them before use. See §2 for `--agent` persona and skill conventions; see §0 for acceptance-criteria production.

### Design decisions in this example

| Decision | Why |
|---|---|
| **Model routing** — `reasoning` for design/review, `fast` for code/test/install | Design and critique need deeper reasoning; code generation and testing are cheaper with a fast model. |
| **Materialize via `--dir` directly** (no diff + apply) | Eliminates the "diff was never applied" gap (§4.4). Code phases write files directly into the target dir. |
| **Create-worktree + verify-independent phases** | Worktree isolates changes (§4.5). Verify-independent uses a SEPARATE agent/session (zero shared context) against the spec's acceptance criteria. |
| **Generic healCommand** (re-read failing output + fix) | Applies to any project; no SQLite-specific regex. |
| **Planning phase emits acceptance criteria** | The verifier and evaluate phases consume a concrete checkable block (§0 required output). |
| **`evaluate` is secondary to `verify`** | The deterministic `verify` (build/tests) is the primary gate; `evaluate` is advisory. |
| **Honest terminal states noted** | Phases explicitly handle: passed, failed (retries exhausted), aborted. |

### Template

```yaml
planName: my-agentic-build-v2
tasks:
  # ── Ground ───────────────────────────────────────────────────────────────────
  - id: read-state
    command: type STATE.md
    timeoutMs: 5000

  # ── Design (reasoning model) ─────────────────────────────────────────────────
  - id: planning
    command: >-
      opencode run --agent planner -m <reasoning/provider/model> "Read .build/STATE.md
      if present. Write a product spec to .build/spec.md. Include a machine-checkable
      'acceptanceCriteria:' block with >=3 concrete conditions the verify phase will
      check (build exits 0, tests pass, endpoint returns 200, CRUD survives restart).
      Exit 0 when done." --dir "D:\target\dir"
    timeoutMs: 180000
    produces: D:\target\dir\.build\spec.md
    producedMustHaveContent: true

  - id: research
    command: >-
      opencode run -m <fast/provider/model> "Read .build/spec.md. Research tech stack,
      risks, unknowns. Write findings to .build/research.md. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 180000
    produces: D:\target\dir\.build\research.md
    producedMustHaveContent: true

  - id: design
    command: >-
      opencode run --agent architect -m <reasoning/provider/model> "Read .build/spec.md
      and .build/research.md. Before writing: read the real source types at
      src/types.ts (or equivalent) — do not invent field names that do not exist.
      Write technical design to .build/design.md. Exit 0." --dir "D:\target\dir"
    timeoutMs: 300000
    produces: D:\target\dir\.build\design.md
    producedMustHaveContent: true

  - id: design-critique
    command: >-
      opencode run --agent code-reviewer -m <reasoning/provider/model> "Read
      .build/design.md and .build/spec.md. Critique against the spec. Write verdict
      to .build/design-critique.md with APPROVE/REVISE and P0-P2 issues. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 240000
    produces: D:\target\dir\.build\design-critique.md
    producedMustHaveContent: true

  # ── Worktree (L2 isolation) ──────────────────────────────────────────────────
  - id: create-worktree
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir'; git worktree add .worktree-build
      (git branch --show-current) 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 };
       Copy-Item -Recurse -Force .\* .\.worktree-build\; Write-Host 'worktree-ok'"
    timeoutMs: 30000
    # If worktree creation fails, plan fails terminal — do not proceed to code phases.

  # ── Code (fast model, NO --agent) ────────────────────────────────────────────
  - id: code-backend
    command: >-
      opencode run -m <fast/provider/model> "Read .build/design.md, .build/spec.md,
      and .build/design-critique.md (it lists what to avoid — do NOT repeat its P0/P1
      issues). Implement the backend by writing files directly into the current
      directory. Do NOT write a diff — materialize the actual source files. Exit 0."
      --dir "D:\target\dir\.worktree-build"
    timeoutMs: 600000
    produces: D:\target\dir\.worktree-build\src\server.ts
    producedMustHaveContent: true
    healCommand: >-
      opencode run -m <fast/provider/model> "Read the failing build/test output below.
      Re-read the existing implementation and apply the minimal fix. Write corrected
      files directly. Exit 0." --dir "D:\target\dir\.worktree-build"
    maxRetries: 3

  - id: code-frontend
    command: >-
      opencode run -m <fast/provider/model> "Read .build/design.md, .build/spec.md,
      the implemented backend, and .build/design-critique.md (avoid its P0/P1 issues).
      Implement the frontend by writing files directly into the current directory.
      Do NOT write a diff — materialize the actual source files. Exit 0."
      --dir "D:\target\dir\.worktree-build"
    timeoutMs: 600000
    produces: D:\target\dir\.worktree-build\src\client.ts
    producedMustHaveContent: true
    healCommand: >-
      opencode run -m <fast/provider/model> "Read the failing build/test output below.
      Re-read the existing implementation and apply the minimal fix. Write corrected
      files directly. Exit 0." --dir "D:\target\dir\.worktree-build"
    maxRetries: 3

  # ── Install & test ────────────────────────────────────────────────────────────
  - id: install-deps
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir\.worktree-build'; bun install 2>&1 | Out-Null;
       if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Host 'install-ok'"
    timeoutMs: 120000
    healCommand: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir\.worktree-build'; bun install --force 2>&1 | Out-Null;
       if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Host 'install-heal-ok'"
    maxRetries: 3

  - id: test
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir\.worktree-build'; bun test 2>&1 | Out-Null;
       if ($LASTEXITCODE -ne 0) { exit 1 };
       bun run build 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 };
       Write-Host 'test-ok'"
    timeoutMs: 300000
    healCommand: >-
      opencode run -m <fast/provider/model> "The test/build run failed below. Read
      the output and the existing code. Apply the minimal fix — never change
      behavior. Write corrected files directly. Exit 0."
      --dir "D:\target\dir\.worktree-build"
    maxRetries: 3

  # ── Review (reasoning model) ─────────────────────────────────────────────────
  - id: review
    command: >-
      opencode run --agent code-reviewer -m <reasoning/provider/model> "Read the
      implemented source files, .build/design.md, .build/spec.md. Code review:
      correctness, security, readability, contract adherence, design adherence.
      Write findings to .build/review.md with P0-P2 issues and a verdict. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 300000
    produces: D:\target\dir\.build\review.md
    producedMustHaveContent: true

  # ── Independent verifier (separate agent, zero shared context, different model) ──
  - id: verify-independent
    command: >-
      opencode run --agent code-reviewer -m <reasoning/provider/model> "Read
      .build/spec.md — specifically its 'acceptanceCriteria:' block. Read the
      implemented source. For EACH criterion, state PASS or FAIL with evidence.
      If ANY criterion FAILs, your verdict is REJECT. Otherwise: APPROVE.
      Write verdict to .build/verdict-independent.md. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 300000
    produces: D:\target\dir\.build\verdict-independent.md
    producedMustHaveContent: true

  # ── Evaluate (secondary — advisory, fast model) ──────────────────────────────
  - id: evaluate
    command: >-
      opencode run -m <fast/provider/model> "Read .build/spec.md (acceptance criteria),
      .build/verdict-independent.md, .build/review.md. Summarize whether the built app
      satisfies requirements. Write to .build/evaluate.md. Exit 0."
      --dir "D:\target\dir"
    timeoutMs: 120000
    produces: D:\target\dir\.build\evaluate.md
    producedMustHaveContent: true
    # Note: evaluate is advisory. The hard gates are verify-independent (APPROVE/REJECT)
    # and verify (build exit 0). evaluate may fail without failing the plan.

  # ── Deterministic verify (primary gate) ──────────────────────────────────────
  - id: verify
    command: >-
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command
      "Set-Location 'D:\target\dir\.worktree-build'; bun test 2>&1 | Out-Null;
       if ($LASTEXITCODE -ne 0) { exit 1 };
       bun run build 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 };
       Write-Host 'verify-ok'"
    timeoutMs: 300000
    healCommand: >-
      opencode run -m <fast/provider/model> "The final verify run failed below.
      Read the output and the existing code. Apply the minimal fix. Write corrected
      files directly. Exit 0." --dir "D:\target\dir\.worktree-build"
    maxRetries: 3
    # This is the final deterministic gate. If it fails after maxRetries,
    # the plan status is FAILED — do not merge.
```

---

## 9. Agentic-specific pre-flight checklist

- [ ] `planName` present, unique
- [ ] First task `read-state` (`type STATE.md`)
- [ ] L2 enabled (this plan edits source) — or strip `code-*` tasks for L1
- [ ] **Every** generative task has `produces:` + `producedMustHaveContent: true`
- [ ] Every code prompt says "also read `<critique>.md` — avoid its P0/P1 issues"
- [ ] Every `test`/`verify` task redirects shim stderr (`2>&1 | Out-Null`) before checking `$LASTEXITCODE`
- [ ] `--dir` uses absolute path for cross-project, relative for in-loop; never `..\` parent-relative
- [ ] Builds/installs `timeoutMs: 120000`; code gen `600000`
- [ ] Last task is `verify` (build/test) that exits 0
- [ ] Fix tasks carry `healCommand` + `maxRetries: 3`
- [ ] Design/review phases carry `--agent <persona-name>`; code/get phases do NOT
- [ ] Every generative task loads relevant skill(s) by name (no unassigned phase)
- [ ] Phase graph matches project kind (no `code-frontend` for API-only, no `research` for known stack, etc.)
- [ ] `create-worktree` + `verify-independent` present when L2; absent when L1

---

## 10. Why these rules — principles & references

Every rule in this guide is backed by observed failure modes and/or established research on agentic coding loops. This section collects the sources so the guide is self-justifying.

### Principles

| Principle | How it appears in this guide |
|---|---|
| **Observable contract** — the agent's output must be deterministically checkable by a script or separate agent | §0 acceptance criteria, §4.1 produces gate, §8 produces:+producedMustHaveContent |
| **Independent verifier** — the agent that builds must not be the one that judges "done" | §4.5 worktree+independent verifier, §8 verify-independent phase |
| **Worktree isolation** — code changes happen in a disposable branch/worktree, not the main tree | §4.5, §7 L2 requirement, §8 create-worktree phase |
| **Deterministic primary gate** — a shell command (build/tests) is the hard pass/fail, not an LLM opinion | §8 verify phase (final gate), §4.3 stderr redirect |
| **Stage gates** — each phase produces a checkable artifact before the next starts | §4.1 produces gate, §4.2 critique consumption, §8 phased produces chain |
| **Bounded repair** — limited retries with a specific heal command, then escalate | §4.5 maxRetries:3, §8 healCommand on code/test/verify |
| **Model routing** — use reasoning models for design/critique/review, cheap models for code/test | §8 template: `<reasoning/...>` vs `<fast/...>` |
| **No self-grading** — don't let the agent that built decide "done" | §4.5, verified by independent verifier |
| **Honest terminal states** — passed, failed (retries exhausted), aborted are explicit outcomes, not "done" | §8 template: comments on each terminal state |

### References

1. **Verdent — "Coding-agent loop that stops safely"** — Describes the observable-contract pattern and why self-terminating agents need deterministic exit conditions. Source of the "machine-checkable acceptance criteria" requirement.
2. **Mirlohi — "Don't let the agent grade itself"** — Demonstrates that self-grading agents systematically overestimate completion quality. Basis for §4.5 independent verifier.
3. **Peerlist — "Stage-gate loops for AI agents"** — Proposes sequential stage gates with explicit artifact handoffs. Maps to §3 canonical structure and the produces chain.
4. **Consensus-loop architecture** — Multi-agent verification rounds with convergence criteria. Informs §4.5 verify-independent design (separate agent, zero shared context).
5. **Augment CIV (Continuous Integration & Verification)** — Worktree-isolated agent CI/CD pattern. Basis for §4.5 worktree requirement.
6. **LoopTroop — "KitchenLoop UAT gate"** — Independent verification gate with human-in-the-loop fallback. Informs §4.5 verify-independent + §8 final verify as deterministic gate.
7. **arXiv 2606.01416 — "Self-healing agent loops"** — Reports 0% silent failures in self-healing loops with bounded retry and escalation. Basis for maxRetries:3 + generic healCommand.
8. **Make-no-mistakes agent framework** — Principle of "verify before merge" with zero shared context between builder and verifier. Informs §4.5 and §8 verify-independent.
9. **Loops-engineering guide** — Model routing recommendation: reasoning models for architecture/design, cheap models for code generation/testing. Basis for §8 model routing.
10. **Imagineers — "Ten-phase agentic lifecycle"** — Formal intake → design → critique → implement → review → verify flow. Informs §3 canonical structure and §0 intake.

---

## 11. What this guide adds vs `PLAN-WRITING-GUIDE.md`

`PLAN-WRITING-GUIDE.md` is the general contract (schema, archetypes, anti-patterns). This guide is the **agentic subcase** + the corrections the general guide implies but does not enforce:

1. `produces:` gate as a hard requirement on generative tasks (general-guide Anti-pattern #1, made mandatory here).
2. Code prompts must consume the critique (general-guide Anti-pattern #2, made mandatory here).
3. The shim/stderr/`$LASTEXITCODE` fragility (general-guide §5 warning) with the exact error and a copy-paste fix.
4. Materialization gap (§4.4): a diff was produced but never applied to source.
5. Worktree + independent verifier (§4.5): no self-grading, zero shared context.

If a plan follows this guide, an agentic build loop will report `pass`/`fail` truthfully instead of relying on subjective "looks done."
