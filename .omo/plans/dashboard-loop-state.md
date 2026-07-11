# dashboard-loop-state - Work Plan

## TL;DR (For humans)

**What you'll get:** Your dashboard will show live progress from the running loop — the current state (init/run/verify/done), which iteration it's on, and a table of every phase with its status, how long it took, and expandable output logs.

**Why this approach:** The phase loop already writes its progress to disk on every step (`_agent-loop-output/STATE.md`) — we just need the dashboard server to read that file and pass it through. Zero changes to the loop itself, minimal code on the server side, and the dashboard directly reuses its existing WebSocket live-update mechanism.

**What it will NOT do:** No change to how you launch or run the loop. No change to the loop code or its plan files. No React, bundler, or new dependencies — the dashboard stays a single self-contained HTML file. No new CLI flags.

**Effort:** Short (6 todos, one per file/concern)
**Risk:** Low — file-already-written pattern, no loop changes, no new dependencies

**Decisions to sanity-check:** 
- File-poll was chosen over loop-push (loop keeps doing what it does; the daemon reads).
- Vanilla-JS kept over htmx/React (htmx would fight the existing WS model; no build needed).
- **Loop ↔ daemon path contract (CRITICAL):** `writeBothStates` writes to `resolve('_agent-loop-output')` which is **CWD-relative** (src/state.ts:141). The daemon poller MUST use the identical resolution `resolve(process.cwd(), '_agent-loop-output')` so it reads the same file the loop writes. **Constraint: the standalone `start` loop and the daemon must be launched from the same working directory**, or polling reads null. This is documented in Scope below. No CLI flag is added; the `loopStateDir` constructor opt defaults to this path and accepts a test override.
- **Todo 6 QA uses the already-available browser-testing (Chrome DevTools MCP) skill, NOT a Playwright npm script** — Playwright is not a dependency and the "no new deps" guardrail stands. See Todo 6.

---

> TL;DR (machine): Short/6-todo plan. Daemon polls _agent-loop-output/STATE.md (resolve(process.cwd(),'_agent-loop-output') to match OUTPUT_DIR exactly) and surfaces LoopState via /state + WS. Dashboard gets a Loop card with phases table. badgeHtml fixed for pass/fail. Integration test (Bun) + browser QA via Chrome DevTools MCP (NO Playwright dep). No loop changes, no React, no CLI flag, no new deps.

## Scope
### Must have
- Daemon polls `_agent-loop-output/STATE.md` (the loop's progress file) on an interval and caches as `loopState`.
- **Poll path MUST equal the loop's write path exactly:** resolve as `resolve(process.cwd(), '_agent-loop-output')` (mirrors `OUTPUT_DIR = resolve('_agent-loop-output')` at src/state.ts:141). Do NOT use `this.baseDir` — `baseDir` may differ from CWD. **Documented constraint: standalone `start` loop and daemon must share CWD.**
- Two sub-systems surfaced: daemon state (`getState()`) + loop state (`LoopState` from the phase loop).
- `DaemonAPI.getState()` widened to include `loopState: LoopState | null`.
- WS `state_change` broadcast includes `loopState`.
- Dashboard Live page gains a "Loop" card: `currentState` badge, `iteration`, `startTime`, `errors`, and a phases table (name, status badge, duration, expandable stdout/stderr).
- `badgeHtml` maps `pass`→completed and `fail`→failed correctly.
- Integration test: write fake STATE.md, assert `GET /state` includes loopState.
- Playwright QA: dashboard renders the Loop card from mock data.
- Existing test suite (`bun test`) passes after all changes.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No changes to loop-runner.ts, loop.ts, cli.ts, or the `start` phase-loop process.
- No changes to the root `STATE.md` (StateMdFrontmatter / AGENTS convention file).
- No React, htmx, bundler, or build-pipeline changes — vanilla-JS SPA extended in-place.
- No orchestrator/child-loop changes.
- No `--loop-state-dir` CLI flag — uses existing OUTPUT_DIR path (`_agent-loop-output`). The `loopStateDir` constructor opt exists ONLY for programmatic/test injection; it is not a CLI flag.
- No new npm/bundler dependencies. This INCLUDES Playwright — Todo 6 uses the already-available Chrome DevTools MCP, not a Playwright script.
- **Loop ↔ daemon CWD contract:** the standalone `start` loop and the daemon MUST be launched from the same working directory, because both `writeBothStates` (state.ts:141) and the poller resolve `_agent-loop-output` relative to CWD. If they differ, polling silently reads null. This is a documented constraint, not a code fix.
- No changes to how the loop executes or writes its state — the loop already writes the data; this only reads it.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + Playwright.
- Evidence: .omo/evidence/task-<N>-dashboard-loop-state.md
- Daemon integration test: write a fake `_agent-loop-output/STATE.md` with a minimal LoopState, start daemon, assert `GET /state` response includes `loopState` with the expected fields, and the WS `state_change` initial message also carries `loopState`.
- Browser QA (Chrome DevTools MCP, no new dep): start daemon with injected fake STATE.md, open `/dashboard`, assert the "Loop" card renders with correct phase names/statuses/durations and expand/collapse works.
- Existing test suite: `bun test` must pass with no regressions.
- All artifacts journaled in `.omo/evidence/` and cleaned up on completion.

## Execution strategy
### Parallel execution waves
Wave 1 (parallel):
- Todo 1: Daemon poller (readState import, loopState dir, poll interval, cache)
- Todo 2: badgeHtml pass/fail fix
Wave 2 (depends on 1+2):
- Todo 3: DaemonAPI widen + routes (getState return type, loopState in WS)
Wave 3 (depends on 3):
- Todo 4: Dashboard Loop card UI
Wave 4 (parallel, depends on 4):
- Todo 5: Integration test
- Todo 6: Playwright QA

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
|---|---|---|---|
| 1. Daemon poller | — | 3 | 2 |
| 2. badgeHtml fix | — | 3 | 1 |
| 3. API widen + routes | 1, 2 | 4 | — |
| 4. Dashboard Loop card | 3 | 5, 6 | — |
| 5. Integration test | 4 | — | 6 |
| 6. Playwright QA | 4 | — | 5 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch — never rewrite the headers above. -->

- [ ] 1. Daemon-side: import readState, add STATE.md polling interval
  What to do / Must NOT do: In src/daemon.ts: (a) import `readState` from `state.js` (add to the existing state.js import line 10). (b) Add two fields: `private _loopState: LoopState | null = null;` and `private _loopStateInterval: ReturnType<typeof setInterval> | null = null;` (place near line 22-23). (c) Add `loopStateDir` to the constructor opts TYPE: `opts?: { cron?: string; watchDir?: string; loopsConfig?: string; planPath?: string; loopStateDir?: string }` (line 39). (d) In the constructor BODY (after `this.baseDir = baseDir ?? resolve('.');` at line 54), set `const loopStateDir = opts?.loopStateDir ?? resolve(process.cwd(), '_agent-loop-output');` — MUST be in the body, NOT a destructured default, because `this.baseDir`/`process.cwd()` is not available in parameter default evaluation. (e) Start the interval inside `start()` after `_stateInterval` (near line 242): `this._loopStateInterval = setInterval(async () => { if (this._status.status !== 'running') return; try { this._loopState = await readState(resolve(loopStateDir, 'STATE.md')); } catch { /* keep previous value */ } }, 2000);`. (f) In `stop()` (line 261-270) add `if (this._loopStateInterval) clearInterval(this._loopStateInterval);`. Must NOT touch loop-runner.ts, loop.ts, cli.ts. Must NOT add a CLI flag. The poll path `resolve(process.cwd(), '_agent-loop-output')` MUST match OUTPUT_DIR (src/state.ts:141) so the daemon reads the same file the loop writes.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 3
  References: src/daemon.ts:10 (state import), src/daemon.ts:17-30 (constructor, opts), src/daemon.ts:22-23 (interval fields), src/daemon.ts:36-40 (constructor signature), src/daemon.ts:54 (baseDir set), src/daemon.ts:239-242 (_stateInterval), src/daemon.ts:261-270 (stop), src/state.ts:35-66 (readState async), src/state.ts:141 (OUTPUT_DIR = '_agent-loop-output'), src/types.ts:54-61 (LoopState)
  Acceptance criteria: `import { readState }` compiles. Daemon compiles with `_loopState` and `_loopStateInterval` fields. `bun test` passes. When no STATE.md exists, `this._loopState` is `null` (readState returns null). Callback is `async` and `await`s readState so the stored value is a resolved `LoopState`, not a Promise. `stop()` clears `_loopStateInterval`.
  QA: happy path — fake STATE.md created at the CWD-relative `_agent-loop-output/STATE.md`, after one 2s tick `getState().loopState` is populated; failure — no STATE.md, loopState stays null; evidence dir: `.omo/evidence/task-1-dashboard-loop-state.md`
  Commit: Y | feat(daemon): import readState and add loopState polling from _agent-loop-output

- [ ] 2. Dashboard: fix badgeHtml for pass/fail
  What to do/Must NOT do: Add `if (s === 'pass') cls = 'completed'; else if (s === 'fail') cls = 'failed';` to badgeHtml in src/dashboard/index.html around line 630. Must NOT restructure the function.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 3
  References: src/dashboard/index.html:627-637 (badgeHtml function), src/types.ts:38 (OutcomeStatus = 'pass' | 'fail' | 'error')
  Acceptance criteria: A "pass" status renders with green `.completed` CSS. A "fail" renders with red `.failed` CSS.
  QA: happy — `badgeHtml('pass')` returns span with `completed` class; failure — `badgeHtml('unknown')` falls through to `pending` style; evidence: `.omo/evidence/task-2-dashboard-loop-state.md`
  Commit: Y | fix(dashboard): add pass/fail to badgeHtml status mapping

- [ ] 3. DaemonAPI + routes: widen getState return type, include loopState in WS broadcast
  What to do / Must NOT do: In src/daemon-api.ts:19, change `getState()` return type to include `loopState: LoopState | null`. In src/daemon.ts:80-90, return `loopState: this._loopState ?? null`. In src/daemon.ts:241, confirm the WS broadcast already calls `getState()` so loopState flows automatically (it does: line 241 splats `this.getState()`). In src/routes.ts:35-36, confirm no change needed — GET /state returns `api.getState()` — loopState appears. Must NOT create a new WS message type.
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 4
  References: src/daemon-api.ts:19 (getState return type), src/daemon.ts:80-90 (getState impl), src/daemon.ts:241 (WS broadcast calls getState), src/routes.ts:33-36 (GET /state returns getState)
  Acceptance criteria: GET /state returns JSON with `loopState` key. WS state_change carries `loopState` in the `data` field.
  QA: happy — daemon running with fake STATE.md, both GET /state and WS message include loopState; failure — no STATE.md, loopState: null in both; evidence: `.omo/evidence/task-3-dashboard-loop-state.md`
  Commit: Y | feat(api): include loopState in /state and WS state_change

- [ ] 4. Dashboard: add Loop card to Live page
  What to do / Must NOT do: Add a `<section class="card">` in `liveHtml()` between Daemon Status and Current Task. Conditionally render: when `state.loopState` is null → `<p class="empty">No loop running</p>`. When populated → render `currentState` as badge (init→pending, run→running, verify→pending, done→completed), `iteration`, `startTime`, `errors` (red error-state), and a phases table: columns Name, Status (badgeHtml), Duration (durationStr), Stdout (truncated <pre class="logs">, expand toggle), Stderr (same). Reuse `badgeHtml`, `durationStr`, `esc`, `timeStr` from existing helpers. Must not break existing Daemon Status / Current Task / Queue / Children sections. Must not add JS dependencies.
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 5, 6
  References: src/dashboard/index.html:734-837 (liveHtml + bindLiveEvents), src/dashboard/index.html:627 (badgeHtml), 618 (durationStr), 612 (esc), 639 (timeStr), src/types.ts:54-61 (LoopState), src/types.ts:38-52 (OutcomeStatus, ExecutionResult, PhaseResult)
  Acceptance criteria: With loopState in /state, Dashboard shows a "Loop" card with state badge, iteration count, phases table. Without loopState, shows "No loop running".
  QA: happy — phases table shows correct names and statuses; failure — null state shows empty-state text; evidence: `.omo/evidence/task-4-dashboard-loop-state.md`
  Commit: Y | feat(dashboard): add Loop card to Live page showing phase-loop progress

- [ ] 5. Integration test: daemon polls and surfaces loopState via /state + WS
  What to do / Must NOT do: Write test in `__tests__/dashboard-loop.test.ts` (create new file). Tests: (1) create temp dir `TMP`, write fake STATE.md (YAML frontmatter or JSON) with a `LoopState` (currentState='run', iteration=3, phaseResults={ 'test': { status:'pass', exitCode:0, durationMs:500, stdout:'ok', stderr:'', evidencePath:'', pluginResults:{}, judgment:{passed:true, reason:'exit code', confidence:1} } }). (2) Instantiate a real `Daemon`: `const d = new Daemon(0, TMP, { loopStateDir: TMP });` then `await d.start();`. (3) BRIDGE THE 2s POLL: either `await new Promise(r => setTimeout(r, 2200))` to let one `_loopStateInterval` tick run, OR expose/await the poll by calling `d.getState()` after the tick — do NOT assert before the poll has run (race). (4) call `const res = await (await fetch('http://localhost:'+d.port+'/state')).json();` assert `res.loopState.currentState === 'run'`, `res.loopState.iteration === 3`, `res.loopState.phaseResults.test.status === 'pass'`. (5) on a fresh daemon with no STATE.md, assert `getState().loopState === null`. (6) `d.stop();`. Follow existing pattern in `__tests__/daemon-v6.test.ts` (real Daemon + HTTP). Must NOT modify existing tests.
  Parallelization: Wave 4 | Blocked by: 4 | Blocks: —
  References: __tests__/daemon-v6.test.ts (real-Daemon test pattern), src/daemon.ts:36-40 (constructor incl. new loopStateDir opt), src/state.ts:35-66 (readState), src/types.ts:54-61 (LoopState), src/daemon-api.ts (interface), src/daemon.ts (class)
  Acceptance criteria: Test passes with `bun test` in project root.
  QA: happy — correct STATE.md + 2.2s wait produces correct loopState values in GET /state; failure — absent STATE.md produces loopState null; evidence: `.omo/evidence/task-5-dashboard-loop-state.md`
  Commit: Y | test: add daemon loopState integration test

- [ ] 6. Browser QA: dashboard renders Loop card from live daemon (via Chrome DevTools MCP — NO new dependency)
  What to do / Must NOT do: Use the **browser-testing-with-devtools** skill (Chrome DevTools MCP, already available) — do NOT write a Playwright npm script (Playwright is not a dependency; "no new deps" stands). Steps: (1) create temp dir with a fake `STATE.md` (2 phases, currentState='run', iteration=3). (2) Start a Daemon on a random port `new Daemon(0, TMP, { loopStateDir: TMP })` and `d.start()`. (3) Drive a headless Chrome via the DevTools MCP: navigate to `http://localhost:<port>/dashboard`, wait for the "Loop" card. (4) Screenshot cropped to the Loop card. (5) Assert (via DOM snapshot/text) the two phase names + statuses are visible, iteration shows "3", state badge shows "running". Save screenshot to `.omo/evidence/task-6-dashboard-loop-state.png`. (6) `d.stop()`. Must NOT modify source files.
  Parallelization: Wave 4 | Blocked by: 4 | Blocks: —
  References: .opencode/skills/browser-testing-with-devtools/SKILL.md (DevTools MCP usage — already installed), src/dashboard/index.html (target rendering), src/daemon.ts (start/stop, loopStateDir opt)
  Acceptance criteria: Screenshot shows a "Loop" card with two phase rows, iteration count "3", and state badge "running".
  QA: happy — 2-phase state renders both rows; failure — null state renders "No loop running"; evidence: `.omo/evidence/task-6-dashboard-loop-state.png`
  Commit: N | (QA artifact; not a source commit)

## Final verification wave
- [ ] F1. Plan compliance audit: all Must have items complete; no Must NOT have violated.
- [ ] F2. Code quality review: at least one reviewer confirms no `as any`, no type suppression, no empty catch.
- [ ] F3. Manual acceptance gate (HUMAN, not agent-executed): user launches the standalone `start` loop and the daemon from the SAME working directory, opens `/dashboard`, confirms the Loop card shows live data. Recorded as a manual sign-off only — does NOT count toward the "zero human intervention" agent-QA claim (covered by F2 + Todos 5/6).
- [ ] F4. Scope fidelity: no loop-runner.ts changes, no React/bundler, no CLI flag, no new npm dependency (incl. Playwright).

## Commit strategy
- 5 source commits + 1 QA artifact (not committed), conventional style as listed per todo.
- Commits are local only; never push or merge without human approval.
- Chore: `feat(daemon)`, `feat(api)`, `feat(dashboard)`, `fix(dashboard)`, `test(daemon)`.

## Success criteria
- GET /state returns loopState matching the running phase loop's STATE.md file.
- WS state_change carries loopState for live dashboard updates.
- Dashboard shows a Loop card with: state badge, iteration, phases table with stdout/stderr.
- badgeHtml correctly maps pass→completed, fail→failed.
- `bun test` passes (existing + new integration test).
- Playwright QA screenshot shows correct Loop card rendering.
- The standalone `start` phase loop (separate process) continues to work independently — its progress appears on the dashboard served by the daemon.
