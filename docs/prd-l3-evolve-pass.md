# PRD: L3 evolve pass — the slow loop that rewrites the fast loops

> **Status:** Draft — intended for `azizmaitig/Loop` issue tracker, but GitHub auth unavailable on this machine.
> **Created:** 2026-07-20
> **Labels:** `ready-for-agent`
> **Related:** ADR-0019, ADR-0018, `prd-l1-spec-creation-loop.md`, `docs/adr/0019-l3-evolve-pass.md`

## Problem Statement

The spec-factory prototype has a **two-loop topology** (ADR-0018): L1 (port 3001, cron `*/15`) drafts `evolve-N.md` specs from a one-line inbox idea; L2 (port 3002, watchDir) claims, builds, and stamps `built-N`. Without a *slow* loop pointed at these fast loops, the system **repeats rather than compounds** — it rediscovers the same dead ends every run and burns tokens without getting sharper or cheaper (Evolve Run pattern, Escher-Loop, `loop-engineering` L1→L3 graduation; surveyed 2026-07-20).

Two concrete gaps block compounding today:

1. **No run evidence.** L1 writes `evolve-N.md` (the artifact) but logs nothing about *how the draft went*. The evolve pass would have no evidence to learn from (`loop-engineering` anti-pattern #10: "only STATE.md, no history of what the loop did").
2. **No rejection signal.** L1 and L2 are separate daemons (ADR-0001 Amendment: isolated module globals). L2's `spec-executor.yaml` runs `l2-executor.ps1` stages but **does not append its outcome to `loop-run-log.md`**. L1 cannot tell whether L2 built or rejected its spec except by inferring from a missing `built-N` — weak, and `verify-draft` only checks the artifact count, not outcomes.

This PRD specifies **L3**: a slow loop that reads the shared run log and *proposes* edits to the fast loops' own artifacts (intake prompt, gate threshold, plan task structure), gated so the LLM only wakes when there is proven something to learn.

## Solution

L3 is a **third daemon/plan** (`spec-evolve.yaml`, its own port, slow cadence) that does no domain work. Each run:

1. A **cheap deterministic combo-trigger** (`l3-should-evolve.ps1`, no LLM) scans `loop-run-log.md` for (a) a rejection/stagnation cluster — same topic rejected ≥3×, or ≥K consecutive stalled specs — AND (b) a minimum run count since the last evolve pass (e.g. 5–10 L1 runs). Exits 0 (wake LLM) only if both hold; else exits 0 with no proposal (idle, no false failure — mirrors L1's idle contract).
2. If triggered, an LLM step reads the relevant `loop-run-log.md` entries + the rejected `evolve-N` specs and produces **proposed edits** to the fast loops' artifacts.
3. The proposals are written to `spec-evolve-proposals.md` (each: `{date, trigger_pattern, target_file, current→proposed, why, confidence}`) **plus** a ready-to-apply `.patch` file. The LLM does NOT edit the target files directly.
4. A human reviews `spec-evolve-proposals.md`, `git apply`s the patch if good, and clears the entry. This satisfies the `AGENTS.md` human-gate invariant (no auto-merge, draft-PR-style review) without requiring `gh` auth.

The shared evidence contract: both L1 and L2 append to `loop-run-log.md`, each entry carrying the spec number **N** so the evolve pass correlates "L1 drafted N" with "L2 built/rejected N".

## User Stories

1. As a developer, I want L3 to wake the LLM **only** when `loop-run-log.md` shows a real rejection/stagnation pattern plus enough runs to learn from, so that token spend is bounded and the loop compounds instead of spinning.
2. As a developer, I want L3 to read a single correlated run log (L1 drafts + L2 outcomes by N), so that it can attribute a rejected spec to the exact L1 draft that produced it.
3. As a developer, I want L3 to **propose** changes (markdown + patch), never auto-apply, so that the human-gate invariant holds and I stay in control of what the loops become.
4. As a developer, I want L3 to idle cleanly (exit 0, no proposal) when no pattern is found, so that "nothing to improve" is a first-class success state, not a silent no-op or false failure.
5. As a developer, I want L3 to fail loudly (non-zero exit) when the LLM step crashes or writes no proposal despite a triggered pattern, so that silent no-ops are caught.
6. As a developer, I want L2 to record its build outcome (`built-N` / `rejected-N: <reason>`) to `loop-run-log.md`, so that the evolve pass has an explicit, correlated rejection signal instead of inferring from a missing `built-N`.
7. As a developer, I want L1 to record each draft run (`run_id, spec_N, idea, speckit_exit, artifact_guard_result`) to `loop-run-log.md`, so that the evolve pass has evidence of how drafting went.
8. As a developer, I want the proposal file + patch to be human-reviewable and clearable, so that reviewing proposals becomes a routine duty (like the daily STATE.md review in `AGENTS.md`).

## Implementation Decisions

- **L3 exec model**: one combo-trigger PowerShell script (no LLM) + one LLM step (`opencode run` with a `/speckit`-style or plain prompt) that reads the log and emits the proposal file + patch. No `--dir` flag (PLAN-WRITING-GUIDE P2: chokes on space paths); the script `Push-Location`s into the spec-factory workspace CWD as L1 does.
- **Trigger = C gated by A** (ADR-0019 §2): the combo-trigger is a cheap pre-check that must pass BOTH a pattern test (rejection/stagnation cluster) AND a min-run-count test before waking the LLM. Reuses the `gate-evolve.ps1` pattern (cheap gate before expensive work).
- **Scope = B** (ADR-0019 §1): L3 may propose edits to the `specify` seed prompt, the `gate-evolve` threshold, and (human-gated) `spec-creator.yaml` task ordering / timeouts and the `l1-*.ps1` helpers. It never edits `agent-loop/src/` (locked engine) or `spec-factory/` command content (locked reference deliverables) — only the loop's own config/intake layer.
- **Evidence = A** (ADR-0019 §3): L1's `l1-draft-increment.ps1` appends one line per run to `loop-run-log.md`; L2's `l2-executor.ps1` appends its outcome. The evolve pass reads this file; proposals go to a **separate** `spec-evolve-proposals.md` so history and pending-changes don't mix.
- **Rejection signal = C** (ADR-0019 §4): L2 appends `rejected-N: <reason>` on verifier reject (and `built-N` on success), correlated by N. Fallback if L2 logging is delayed: L1 infers rejection from missing `built-N` within K ticks — weaker, accepted temporarily, but the explicit signal is the target.
- **Human gate = A** (ADR-0019 §5): proposal markdown + `.patch`; human `git apply` + clear entry. No `gh` dependency (currently unavailable per L1 PRD status). Future: draft PR once `gh` auth returns.
- **Log format**: append-only, one JSON-ish line per entry, fields `{ts, loop, spec_N, event, detail}`. `loop` ∈ {L1, L2, L3}; `event` ∈ {drafted, idle, rejected, built, stalled, evolved-proposal}. Deterministic parser in `l3-should-evolve.ps1` — no LLM needed to read it.
- **Two-daemon isolation preserved**: L3 is its OWN daemon process (own port, e.g. 3003) — NOT folded into L1/L2, because ADR-0001 Amendment requires isolated module globals. L3 reads the shared file but does not share a process with L1/L2.
- **Space-in-path**: every filesystem op uses `-LiteralPath` / `Join-Path`; the engine writes each command to a temp `.cmd` so quotes/spaces survive (same hardening as L1).

## Testing Decisions

- **Single seam**: contract tests on `l3-should-evolve.ps1` (the combo-trigger) via a recorder stub — verifies it exits 0 only when (pattern AND min-runs) hold, and 0-with-no-proposal when not. No LLM needed.
- **Log-format parser test**: a unit test that feeds crafted `loop-run-log.md` lines (3 consecutive `rejected-N` same topic; missing `built-N` stalls) and asserts the trigger detects the cluster. Mirrors `bug2-space-path.test.ts` (spawn+spy) and `loop-plan.test.ts` (config parsing) prior art.
- **Proposal output test**: given a triggered pattern, assert the LLM step (stubbed) writes `spec-evolve-proposals.md` with the required fields and a non-empty `.patch`; assert it does NOT modify the target files directly.
- **What is tested (target: 5–6 tests)**: trigger fires on cluster+min-runs; trigger idles on no pattern; trigger idles below min-run-count; L2 `rejected-N` parsed and correlated; proposal file + patch emitted, target untouched; missing CLI / crash fails loud.
- **What is NOT tested by automation**: live LLM evolve run (requires real LLM — manual only). L1→L3 and L2→L3 end-to-end (requires running daemons — manual integration).
- **A good test** verifies external behavior through the public interface (script exit code + files written), not implementation details.

## Out of Scope

- **`agent-loop/src/` edits**: engine locked. L3 is config/intake-layer only.
- **`spec-factory/` content edits**: prototype's `.opencode/commands/speckit.*`, `.specify/`, `CONTEXT.md`, `specs/` locked reference deliverables. L3 proposes, human applies.
- **v9 Feedback Controller (ADR-0012)**: engine-internal systematic self-healing. L3 is config-layer, outside the locked engine. Distinct concern.
- **Mode 1 (full) speckit flow**: deferred per ADR-0018.
- **Auto-merge / draft PR**: out until `gh` auth returns; gate = local proposal + patch.
- **Choosing the concrete throwaway product** (ADR-0002 Q3=b): remains unfilled.

## Further Notes

- This PRD is the implementation plan for ADR-0019, which was reached by grilling (5 decisions: scope B, trigger C-gated-A, evidence A, signal C, gate A) on 2026-07-20, informed by a literature + repo survey (Evolve Run, Escher-Loop, Autogenesis, `loop-engineering`, ARIS, coze-loop, Spec-Driven Loop / Kitchen Loop).
- **Prerequisite (blocks L3 function)**: L2 must log its outcome to `loop-run-log.md` (Issue 1 below). Until then the evolve pass can only infer rejection weakly. L1 log-append (Issue 2) is also prerequisite for full evidence.
- The L1/L2 merge (`fix/daemon-autonomy-bugs`, commit `9c16a81`) is done and verified; the two-loop pipeline now parses and is wired. L3 observes it.
- The human duty added: periodically review `spec-evolve-proposals.md` (analogous to daily STATE.md review in `AGENTS.md`). If unreviewed, the loop stops improving — that is acceptable and by design (human stays the gate).
