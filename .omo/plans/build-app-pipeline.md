# build-app-pipeline - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** A reusable "recipe" (`.omo/plans/build-app-pipeline.yaml`) your loop can run against any project folder to build an app from scratch through 10 automatic stages: read state → plan → research → design → critique design → code → test → review code → evaluate quality → verify. Plus two design documents: ADR-0010 (a future upgrade that lets the loop self-decide when to move to the next stage) and ADR-0011 (a precise spec for wiring the per-stage retry/recovery feature the template references but the engine does not yet support).

**Why this approach:** The stage order comes from 2026 research (GroovyWeb, SPEC-TO-SHIP, CircleCI) and each stage is separated by a hard check (the stage's command must exit 0) before the next starts — preventing the agent from shipping wrong features, getting stuck, or losing context. Each stage writes to a FILE (not chat memory), so long builds stay reliable.

**What it will NOT do:** It will not write any TypeScript/Python application code (only `.plan.yaml` config files + ADR markdown). It will not build a specific app (you fill in the folder path via substitution). It will not edit the loop's engine (`src/`) — the planner role authors artifacts only; ADR-0011 specifies engine changes for a *separate future* change. It will not push code to production without your approval.

**Effort:** XL
**Risk:** Medium — the plan is complex (10 stages, 5 safety rails, 2 ADRs). The delivered `.yaml` must be validated by actually running it, and the engine has a hard cap on how many times a plan can loop.

**Decisions you already made (recorded):**
1. Stage order confirmed: read-state → planning → research → design → design-critique → code → test → review → evaluate → verify (+ optional deploy).
2. Per-stage retry (heal) is referenced but **not yet wired in the engine** (ADR-0009 left it dead). We keep the YAML field but ADR-0011 specs the future wiring. Real recovery today = stage timeout + command exit-0 termination + the loop iteration cap.
3. `{{TARGET_DIR}}` is a placeholder you substitute manually before running (the engine does not interpolate it).
4. L2 (source editing) must be enabled by you before running — the plan does not assume it.
5. `--max-iterations N` re-runs the WHOLE plan N times if all stages pass; N>1 means N full rebuilds. There is no per-stage retry today.

Your next move: approve this plan, then run the todos. Full execution detail follows below.

---

## TL;DR (machine): Deliverables: `.omo/plans/build-app-pipeline.yaml` (10-stage reusable template, manual `{{TARGET_DIR}}` substitution) + `docs/adr/0010-stage-pipeline.md` (Path B design) + `docs/adr/0011-heal-wiring.md` (future heal spec, no src). 6 todos, 3 waves. XL effort, Medium risk. Planner-only — no code in `src/`. 5 safety rails (R1 redefined: heal is documented no-op-until-wired; real guard = timeout + exit-0 + iteration cap).

## Scope
### Must have
- A reusable, templated `build-app-pipeline.yaml` (placeholder `{{TARGET_DIR}}`) that drives the agent-loop through the evidence-based SDLC stage order with verification gates (command exit 0) between every stage.
- Stage order: `read-state → planning → research → design → design-critique → code → test → review → evaluate → verify` (optional `deploy`).
- Each stage delegates work to a subagent via `opencode run "..."` — a **literal shell command** that invokes the `opencode` CLI as a subprocess (the proven pattern from `plans/design-calendar-round1.yaml`, which uses this exact form; note that file's runs failed for unrelated reasons — it is cited only for the command SHAPE, not as a success example). Gated by command exit code (0 = pass).
- Five beginner safety rails (see Execution strategy). **R1 is redefined**: `healCommand`/`maxRetries` are authored into the YAML but are **no-ops until ADR-0011 is implemented** (ADR-0009 confirmed they are currently unwired). The *real* infinite-loop guard is: per-stage `timeoutMs`, command exit-0 termination, and the `--max-iterations` cap (hard-capped at 20 by `config.ts`).
- ADR-0010 (`docs/adr/0010-stage-pipeline.md`): future Path B stage-pipeline layer (meta-plan + StageManager + plan-generator). Explicitly labelled speculative where it depends on config not yet present.
- ADR-0011 (`docs/adr/0011-heal-wiring.md`): precise spec for wiring `healCommand`/`maxRetries` into `PhaseDef` + `plan-executor.ts` mapping + `execute-phases.ts` revival. Spec only — no `src/` edits in this plan.
- A documented **manual substitution step** for `{{TARGET_DIR}}` (envsubst/sed) run by the owner before `loop.ts start`.
- An explicit **L2 precondition** in Scope + TL;DR: owner MUST enable L2 (source editing) before running; worker does not assume it.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- MUST NOT implement any TypeScript/JavaScript code in `src/` — this plan only authors a `.plan.yaml` file and two ADR markdowns. (Planner role: artifacts only. ADR-0011 describes src changes for a SEPARATE future change; it does not perform them.)
- MUST NOT edit `.env`, `auth/`, `payments/`, `secrets/`, `credentials/` (per `AGENTS.md` safety).
- MUST NOT enable parallel stage execution — stages are strictly sequential (reaffirms ADR-0002; real plans are sequential chains; `execute-phases.ts` runs phases in array order).
- MUST NOT let the `code` stage add features absent from the approved spec (scope-creep rail).
- MUST NOT trust an LLM `passed:true` as the final gate — `verify` is a non-LLM exit-0 build/test gate. NOTE: in non-LLM-controller mode (`resolveHardcoded`, `loop-runner.ts:120-125`), an LLM `passed:false` does NOT fail a phase unless the command also exits non-zero. LLM verdicts are advisory; the command exit code is the hard gate. `design-critique`/`review`/`evaluate` therefore gate nothing by themselves.
- MUST NOT set `--max-iterations` above 20 (hard cap in `config.ts:18-21`). This is a CLI flag, not a YAML field.
- One concern per plan: this plan authors the *pipeline template + 2 ADRs*; it does not build any specific app, and it does not wire heal (that is ADR-0011's separate future change).

## Preconditions (owner must satisfy before running the generated plan)
1. **L2 enabled.** `AGENTS.md`: "Do not edit source code until the human explicitly enables L2." The `code`/`test` stages of the generated plan edit source. If L2 is not enabled, running the plan violates loop policy. The planner cannot flip this; it is a human runtime toggle.
2. **`{{TARGET_DIR}}` substituted.** The executor (`plan-executor.ts:84-106`) does a literal `parseYaml` — there is NO variable interpolation. The owner must replace `{{TARGET_DIR}}` with the real absolute project path (e.g. via `envsubst`) before `loop.ts start`. The template ships with the placeholder; it will not run as-is.
3. **`opencode` on PATH.** Every delegating stage runs `opencode run "..."` as a shell command. If `opencode` is not resolvable in the loop's shell, every such stage fails (non-zero exit) and the plan terminates.
4. **`--max-iterations` chosen deliberately.** N=1 = single pass. N>1 = the whole plan re-loops N times if all stages pass (`loop-runner.ts:122` → `COMPLETE` only at `iteration >= maxIterations-1`). There is NO per-stage retry. Pick N=1 for a one-shot build; pick N>1 only if you want full re-runs on pass (expensive: N full rebuilds).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after (the authored `.plan.yaml` is validated by a yaml parse + schema check + a real `--max-iterations 1` run; the ADRs by existence + content grep).
- Evidence: `.omo/evidence/task-<N>-build-app-pipeline.<ext>`
- Validation commands the worker MUST run (after substitution in Precondition 2):
  - Schema/parse check: `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.omo/plans/build-app-pipeline.yaml','utf8'))"` must not throw.
  - Stage count + order check: node script (see Todo 6) asserting the 10 ids in order, `verify` last (or `deploy` if enabled), `read-state` first.
  - ADR existence: `test -f docs/adr/0010-stage-pipeline.md && test -f docs/adr/0011-heal-wiring.md`.
  - Real run (substituted): `bun run loop.ts start --plan .omo/plans/build-app-pipeline.yaml --max-iterations 1 2>&1 | head -30` must show `[plan-executor] Loaded 10 phases from ...` (or 11 with deploy) and must NOT throw `Missing required field: planName`. NOTE: this is a FULL execution of one iteration (all stages run their commands), not a dry load — it will invoke subagents via `opencode run`. Treat it as a real smoke run, not a no-op.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

Wave 1 — Author the templated plan YAML (stages + gates + rails + substitution note).
Wave 2 — Author ADR-0010 (Path B) + ADR-0011 (heal spec).
Wave 3 — Validate all artifacts + final verification wave.

### The five beginner safety rails (load-bearing — baked into every stage task)
- **R1 Infinite-loop / recovery guard (REDEFINED):** The YAML authors `healCommand` + `maxRetries: 3` on the `code` stage, but per ADR-0009 (`execute-phases.ts` heal/retry block was DELETED — there is no code there to revive, only a comment; `plan-executor.ts:25-38` does not map these fields; `PhaseDef` has no such fields in `types.ts:3-12`) they are **NO-OPS until ADR-0011 is implemented**. The *real* guard today is: per-stage `timeoutMs` (caps a hung stage), command exit-0 termination (a failing stage ends the run — `execute-phases.ts:104-110`), and the `--max-iterations` cap (hard 20 in `config.ts:18-21`). Do NOT claim the plan "retries the stage" — it does not yet. ADR-0011 specs making it real (re-adding the block, not reviving dormant code).
- **R2 Context-rot guard:** every stage writes its output to a FILE in `{{TARGET_DIR}}/.build/` (e.g. `spec.md`, `design.md`, `code.diff`); the next stage READS that file. No accumulated chat context. (Rationale: long-agent context drift — Zylos/AgentMarketCap.)
- **R3 Scope-creep guard:** the `code` task prompt includes explicit NON-GOALS and "do not add features absent from `spec.md`" (ContextArk).
- **R4 Evidence-not-claim:** `verify` is a non-LLM hard gate (build + test exit 0, `execute-phases.ts:183`). `evaluate` (LLM `passed/reason/confidence`) is ADVISORY only — and per `loop-runner.ts:44-45`/`resolveHardcoded`, even `design-critique`/`review` LLM `passed:false` does NOT fail the phase unless the command exits non-zero (guide §4). Trust the artifact, not the claim (BirJob).
- **R5 Checkpoint/resume:** relies on `.checkpoint.json` resume (`loop-runner.ts:139-165` prompts Y/n after a prior run). Note `budget.ts:55` flips to `report_only` at 80% of the daily run cap (default 100/24h) — but `checkBudget` is called on the daemon/task-processor path, not necessarily on a direct `start`; a single `start` run is unlikely to hit it. Keep runs within budget regardless.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 author yaml header+read-state+planning | — | 2 | 5,6 |
| 2 author research+design+design-critique | 1 | 3 | — |
| 3 author code+test+review+evaluate+verify | 2 | 4 | — |
| 4 author optional deploy stage | 3 | 5,6 | — |
| 5 write ADR-0010 | — | 6 | 1,2,3,4 |
| 6 write ADR-0011 + validate artifacts | 1,2,3,4,5 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [ ] 1. Author plan header + read-state + planning stages
  What to do / Must NOT do: Create `.omo/plans/build-app-pipeline.yaml`. Start with `planName: build-app`, then tasks `read-state` (command `type STATE.md`, timeoutMs 5000, no quotes — guide §5) and `planning` (delegates via `opencode run "...write spec.md into {{TARGET_DIR}}/.build/spec.md..." --dir "{{TARGET_DIR}}"`, timeoutMs 180000). Each task MUST have unique `id` + `command` that exits 0. MUST NOT hand-author `status`/`durationMs`/`completedAt` (executor owns them, guide §3). MUST NOT set `healCommand`/`maxRetries` here (only the `code` stage references them, and only as documented no-ops). MUST NOT hardcode a real path — ship `{{TARGET_DIR}}` and rely on the Preconditions substitution step.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2
  References (executor has NO interview context - be exhaustive): PLAN-WRITING-GUIDE.md §2-§5 (read-state first, type STATE.md no quotes, command always runs even with llm), plans/design-calendar-round1.yaml (opencode run command SHAPE only — its runs failed, do not copy its status fields), src/plan-executor.ts:21-50 (task→phase mapping: only id/command/timeoutMs/llm copied; planName required or throws "Missing required field: planName" at :101-103), src/cli.ts:154-157 (--plan loads path), src/types.ts:72-84 (PlanYamlTask/PlanYamlDoc schema).
  Acceptance criteria (agent-executable): `node -e "const y=require('js-yaml');const d=y.load(require('fs').readFileSync('.omo/plans/build-app-pipeline.yaml','utf8'));if(!d.planName)throw'no name';if(d.tasks[0].id!=='read-state')throw'read-state not first';if(!d.tasks.find(t=>t.id==='read-state'))throw'no read-state';if(d.tasks.find(t=>!t.command))throw'cmd missing';if(d.tasks.find(t=>t.status||t.durationMs))throw'hand-authored machine fields';console.log('OK',d.tasks.length)"`
  QA scenarios (name the exact tool + invocation): happy — yaml parses, has planName + read-state first + planning; failure — deleting planName makes parsePlanYaml throw "Missing required field: planName" (proves executor guard at plan-executor.ts:101-103). Evidence .omo/evidence/task-1-build-app-pipeline.json
  Commit: Y | feat(plans): add build-app pipeline header + read-state + planning stages

- [ ] 2. Author research + design + design-critique stages
  What to do / Must NOT do: Append tasks `research` (opencode run writes `{{TARGET_DIR}}/.build/research.md`, timeoutMs 180000), `design` (opencode run writes `{{TARGET_DIR}}/.build/design.md` + ADR, timeoutMs 180000), `design-critique` (opencode run READS design.md, outputs `{{TARGET_DIR}}/.build/design-critique.md` with approve/revise; carries an `llm:` block with `provider: opencode` returning {passed,reason,confidence}; timeoutMs 120000; MUST NOT modify code). R2: each reads the prior artifact file. R3 not yet (applies to code). MUST NOT let design-critique edit source. MUST NOT imply critique gates the flow — per loop-runner.ts:44-45 a `passed:false` here does NOT fail the phase unless the command exits non-zero (R4 note).
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3
  References: PLAN-WRITING-GUIDE.md §4 (llm must return passed/reason/confidence; command ALWAYS runs even with llm), alluxi 2026 (Discovery→Architecture stages), SPEC-TO-SHIP (Architect→Planner flow), docs/adr/0002-plan-driven-execution.md, loop-runner.ts:120-125 (resolveHardcoded ignores llm.passed).
  Acceptance criteria (agent-executable): `node -e "const y=require('js-yaml');const d=y.load(require('fs').readFileSync('.omo/plans/build-app-pipeline.yaml','utf8'));['research','design','design-critique'].forEach(id=>{if(!d.tasks.find(t=>t.id===id))throw'_missing_'+id});const c=d.tasks.find(t=>t.id==='design-critique');if(!c.llm||!c.llm.prompt.includes('passed'))throw'critique needs llm passed shape';if(!c.command)throw'critique needs a real command (guide §1: llm never replaces command)';console.log('OK')"`
  QA scenarios: happy — three stages present, design-critique has llm prompt demanding passed/reason/confidence AND a real command; failure — removing `command` from design-critique fails the check (proves guide §1 contract). Evidence .omo/evidence/task-2-build-app-pipeline.json
  Commit: Y | feat(plans): add research + design + design-critique stages

- [ ] 3. Author code + test + review + evaluate + verify stages
  What to do / Must NOT do: Append `code` (opencode run implements from design.md into {{TARGET_DIR}}, writes `{{TARGET_DIR}}/.build/code.diff`, timeoutMs 300000; prompt includes NON-GOALS + "do not add features absent from spec.md" [R3]; authors `healCommand` (identical to command) + `maxRetries: 3` documented as NO-OP-UNTIL-ADR-0011 [R1 redefined]; runs in a git worktree — the `code` command MUST create it via `git worktree add` (per src/worktree.ts:23-35) or pass `--dir` into an existing worktree, satisfying AGENTS.md "use a git worktree for every code-changing attempt"), `test` (command runs build+test in {{TARGET_DIR}}, timeoutMs 120000, exit 0 = pass [R4 evidence gate]), `review` (opencode run reads code.diff, writes `{{TARGET_DIR}}/.build/review.md`, llm passed/reason/confidence, timeoutMs 120000), `evaluate` (opencode run LLM quality verdict vs acceptance criteria → {passed,reason,confidence}, ADVISORY only [R4], timeoutMs 120000), `verify` (FINAL non-LLM hard gate: build+test exit 0 in {{TARGET_DIR}}, timeoutMs 120000, NO llm block). R2: code/test/review/evaluate all read artifact files. MUST NOT make evaluate the final gate. MUST NOT claim code retries on failure (R1 redefined: no per-stage retry exists today).
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 4
  References: PLAN-WRITING-GUIDE.md §5-§7 (verify-last, build timeout 120000, one concern per plan, L2 source edits permitted ONLY if owner enabled L2 — see Preconditions), src/worktree.ts (git worktree isolation — note: worktree is created by the loop/owner, not auto-by plan; the code command should cd into or use --dir for the target), TestQuality/QA.tech (QA gate before ship), BirJob (trust artifact not claim), execute-phases.ts:183 (exit-0 = pass), loop-runner.ts:120-125.
  Acceptance criteria (agent-executable): `node -e "const y=require('js-yaml');const d=y.load(require('fs').readFileSync('.omo/plans/build-app-pipeline.yaml','utf8'));const ids=d.tasks.map(t=>t.id);['code','test','review','evaluate','verify'].forEach(id=>{if(!ids.includes(id))throw'missing_'+id});const code=d.tasks.find(t=>t.id==='code');if(!code.healCommand||code.maxRetries!==3)throw'code references heal rail (no-op-until-ADR-0011)';if(code.llm)throw'code must not be llm-gated';const last=d.tasks[d.tasks.length-1];if(last.id!=='verify')throw'verify must be last';if(last.llm)throw'verify must be non-LLM';console.log('OK')"`
  QA scenarios: happy — all 5 stages present, code references heal rail, verify is final + non-LLM; failure — adding an `llm` block to `verify` fails the "verify must be non-LLM" check (proves R4). Evidence .omo/evidence/task-3-build-app-pipeline.json
  Commit: Y | feat(plans): add code + test + review + evaluate + verify stages with safety rails

- [ ] 4. Author optional deploy stage (commented/conditional)
  What to do / Must NOT do: Append an OPTIONAL `deploy` task (opencode run ships {{TARGET_DIR}} via its existing CI/CD, timeoutMs 180000) placed AFTER verify, guarded by a YAML comment "enable only if final goal = running app; human approval required before any push/merge (AGENTS.md)". MUST NOT make deploy mandatory (build-from-scratch goal may be tested code, not deployed). Keep plan valid if deploy is commented out (last stage = verify).
  Parallelization: Wave 1 | Blocked by: 3 | Blocks: 5,6
  References: alluxi 2026 Stage 5 (Deployment), AGENTS.md (human approval before push/merge), PLAN-WRITING-GUIDE.md §5 (never push without approval).
  Acceptance criteria (agent-executable): `node -e "const y=require('js-yaml');const d=y.load(require('fs').readFileSync('.omo/plans/build-app-pipeline.yaml','utf8'));const last=d.tasks[d.tasks.length-1];if(last.id!=='verify'&&last.id!=='deploy')throw'last must be verify or deploy';console.log('OK',last.id)"`
  QA scenarios: happy — last is verify (deploy optional/commented); failure — inserting a stray task after deploy fails the "last is verify/deploy" check. Evidence .omo/evidence/task-4-build-app-pipeline.json
  Commit: Y | feat(plans): add optional deploy stage (conditional)

- [ ] 5. Write ADR-0010 stage-pipeline design (Path B)
  What to do / Must NOT do: Create `docs/adr/0010-stage-pipeline.md` recording: problem (loop re-runs whole plan, no cross-stage state, no self-advance), decision (add `pipeline.yaml` meta-plan: stages[] each → sub-plan + onPass→nextStage / onFail→loopStage; add `StageManager` persisting cross-stage product state to `{{TARGET_DIR}}/.build/stages.yaml`; optional `plan-generator` LLM task). For the `fileWatch` trigger claim: the trigger EXISTS in `src/orchestrator.ts:158-162` and enqueues `bun run loop.ts start --plan "<path>" --max-iterations 1` (`orchestrator.ts:150`) — but it requires a configured `ChildLoopDef` with `watchDir` in a `loops.yaml`, which does NOT currently exist. Label the auto-pickup as SPECULATIVE (depends on a future child-loop config). Consequences + the 5 rails from this plan become StageManager responsibilities. MUST NOT implement code (ADR only). Number sequentially after ADR-0009 (docs/adr/0009-recovery-guard-separation.md).
  Parallelization: Wave 2 | Blocked by: — | Blocks: 6
  References: docs/adr/0002-plan-driven-execution.md, docs/adr/0003-checkpoint-crash-recovery.md, src/orchestrator.ts:140-164 (LoopOrchestrator trigger enqueue + fileWatch), src/plan-executor.ts:21-50 (beforeLoop/afterLoop), CONTEXT.md (v8 architecture, no parallel execution), ADR-0002 (no parallel), src/types.ts:165-176 (TriggerDef/ChildLoopDef — shows fileWatch needs explicit config).
  Acceptance criteria (agent-executable): `test -f docs/adr/0010-stage-pipeline.md && grep -q "pipeline.yaml" docs/adr/0010-stage-pipeline.md && grep -q "StageManager" docs/adr/0010-stage-pipeline.md && grep -qi "speculative\|not yet\|future" docs/adr/0010-stage-pipeline.md`
  QA scenarios: happy — ADR exists, names pipeline.yaml + StageManager + flags the fileWatch auto-pickup as speculative; failure — removing the speculative flag fails the grep. Evidence .omo/evidence/task-5-build-app-pipeline.md
  Commit: Y | docs(adr): add 0010 stage-pipeline design for self-advancing builds

- [ ] 6. Write ADR-0011 heal-wiring spec + validate artifacts + record evidence
  What to do / Must NOT do: (a) Create `docs/adr/0011-heal-wiring.md` — a PRECISE SPEC (no src edits) for the separate future change that makes R1 real: add `healCommand?: string` + `maxRetries?: number` to `PhaseDef` (src/types.ts:3-12); map them in `beforeLoop` (plan-executor.ts:25-38); revive the heal/retry block in `execute-phases.ts` (currently deleted dead code per ADR-0009) routing through `RecoveryStrategy.healAndRetry` (src/recovery.ts). State explicitly this plan does NOT implement it. (b) Run the validation commands from Verification strategy (after manual `{{TARGET_DIR}}` substitution per Preconditions): yaml parse + load check, ADR existence, and a real `--max-iterations 1` start that loads 10 (or 11) stages without throwing "Missing required field". Write `.omo/evidence/task-6-build-app-pipeline.md` summarizing results. MUST NOT edit src/; MUST NOT actually build an app (template only).
  Parallelization: Wave 3 | Blocked by: 1,2,3,4,5 | Blocks: F1-F4
  References: src/cli.ts:154-157 (--plan path), src/loop-runner.ts:129-181 (runLoop + checkpoint resume prompt), src/plan-executor.ts:21-50 + 84-106, src/execute-phases.ts:104-110 (post-fail hook), src/recovery.ts (RecoveryStrategy), ADR-0009 (heal left unwired), config.ts:18-21 (maxIterations cap 20).
  Acceptance criteria (agent-executable): `bun run loop.ts start --plan .omo/plans/build-app-pipeline.yaml --max-iterations 1 2>&1 | head -30` shows "[plan-executor] Loaded 10 phases" (or 11 with deploy) and no "Missing required field" error. Plus: `test -f docs/adr/0011-heal-wiring.md && grep -q "PhaseDef" docs/adr/0011-heal-wiring.md && grep -q "plan-executor" docs/adr/0011-heal-wiring.md`. Plus the node yaml checks from tasks 1-4 all print OK.
  QA scenarios: happy — plan loads 10 stages, both ADRs present, yaml checks OK; failure — corrupting planName to empty makes start throw "Missing required field: planName" (proves executor guard). Evidence .omo/evidence/task-6-build-app-pipeline.md
  Commit: Y | docs(adr): add 0011 heal-wiring spec + test(plans): validate build-app pipeline + ADRs

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — verify `.omo/plans/build-app-pipeline.yaml` follows `PLAN-WRITING-GUIDE.md` checklist: planName unique, every task has unique id + command (llm tasks included — guide §1), first task reads STATE.md (type STATE.md, no quotes), last task is verify (or deploy if enabled), builds have timeoutMs 120000, no hand-authored status/durationMs, L2-aware (source edits permitted ONLY if owner enabled L2 — Preconditions). Violation = blocker.
- [ ] F2. Schema integrity — all 10 (or 11 with deploy) tasks parse via `js-yaml`, every `id` unique, no duplicate names, every `command` is non-empty string, every `llm` block has `passed/reason/confidence` shape, `verify` has NO llm block, `code` references heal rail (healCommand+maxRetries:3) documented as no-op-until-ADR-0011. Evidence in `.omo/evidence/F2-build-app-pipeline.md`.
- [ ] F3. Real manual QA — human performs (after `{{TARGET_DIR}}` substitution): open the generated `.yaml`, confirm stage order matches the evidence-based sequence, confirm `read-state` uses `type STATE.md` (no quotes), confirm `code` carries `healCommand`+`maxRetries` (and understands they are no-ops until ADR-0011), confirm `verify` is last + non-LLM, confirm L2 is enabled before running. Log findings to `.omo/evidence/F3-build-app-pipeline.md`.
- [ ] F4. Scope fidelity — confirm NO edits to `src/` files (planner role; ADR-0011 is spec-only), no `.env`/`auth`/`payments`/`secrets` paths, ADR-0010 matches Path B plan (speculative where unbuilt), ADR-0011 specifies heal wiring without implementing it. Violation: blocker.

## Commit strategy
Conventional commits per todo (above). No single squashed commit — each todo commits its artifact so the planner's work is reviewable and revertible.

## Success criteria
- `.omo/plans/build-app-pipeline.yaml` exists, parses, loads 10 (or 11) phases via `--plan` (after `{{TARGET_DIR}}` substitution).
- `docs/adr/0010-stage-pipeline.md` exists, names `pipeline.yaml` + `StageManager` + optional `plan-generator`, and flags the fileWatch auto-pickup as speculative.
- `docs/adr/0011-heal-wiring.md` exists, precisely specs heal wiring (PhaseDef + plan-executor + execute-phases/recovery) WITHOUT editing src.
- The YAML satisfies all 10 items of `PLAN-WRITING-GUIDE.md` §8 pre-flight checklist (read after applying the Preconditions: L2 enabled, TARGET_DIR substituted, opencode on PATH, --max-iterations chosen).
- Every stage from `read-state` to `verify` is present, in order, gated by command exit 0.
- `code` stage references `healCommand` + `maxRetries: 3` (R1), explicitly documented as NO-OP-UNTIL-ADR-0011. `verify` stage has NO LLM block (R4: non-LLM hard gate).
- Every stage prompt instructs writing to a file in `{{TARGET_DIR}}/.build/` (R2). `code` prompt includes explicit NON-GOALS (R3).
- Preconditions section makes L2 / TARGET_DIR substitution / opencode-on-PATH / --max-iterations semantics explicit and owner-owned (not assumed).
- Owner can substitute `{{TARGET_DIR}}`, enable L2, and run `bun run loop.ts start --plan .omo/plans/build-app-pipeline.yaml --max-iterations 1` to build a new app from scratch (understanding N>1 = N full rebuilds, no per-stage retry).

(End of file)
