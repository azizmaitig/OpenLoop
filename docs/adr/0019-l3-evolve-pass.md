# ADR-0019 — L3 evolve pass: the slow loop that rewrites the fast loops

- **Status:** Accepted
- **Date:** 2026-07-20
- **Supersedes:** none
- **Related:** ADR-0018 (L1 idea intake & speckit execution), ADR-0001 (parallel N+1/N, two-daemon topology), ADR-0013 (observability), CONTEXT.md (evolve-pass glossary)
- **Scope:** `agent-loop/plans/spec-creator.yaml` (L1) + a new L3 plan; `loop-run-log.md` (shared evidence); `spec-evolve-proposals.md` (proposal output). No `agent-loop/src/` or `spec-factory/` edits (both locked).

## Context

The spec-factory prototype has a **two-loop topology**: L1 (port 3001, cron `*/15`) drafts `evolve-N.md` specs from a one-line inbox idea; L2 (port 3002, watchDir) claims, builds, and stamps `built-N`. This was designed (ADR-0018) and the daemon autonomy bugs were fixed separately.

Research review (2026-07-20) of the autonomous-agent-loop literature — the *Evolve Run* pattern (aibuilderclub), Escher-Loop / Autogenesis (closed-loop self-evolution), `loop-engineering` (L1→L2→L3 graduation), ARIS (Type-A/B gates, combo-triggers), coze-loop (trace→evaluation feedback), and the Spec-Driven Loop / Kitchen Loop patterns — converged on one finding:

> **A two-loop topology where both loops do domain work does not *compound*; it only *repeats*.** Without a *slow* loop pointed at the fast loops — one that reads their run history and rewrites their own config, contract, triggers, and mechanical steps — the system rediscovers the same dead ends every run and burns tokens without getting sharper or cheaper.

The spec-factory's L1 and L2 are both domain loops. There is **no third loop** that improves them. Additionally, two concrete gaps were found:
1. **No run evidence.** L1 writes `evolve-N.md` (the artifact) but logs nothing about *how the draft went*. The evolve pass would have no evidence to learn from (loop-engineering anti-pattern #10: "only STATE.md, no history of what the loop did").
2. **No rejection signal.** L1 and L2 are separate daemons (ADR-0001 Amendment: isolated module globals). L1 cannot tell whether L2 built or rejected its spec except by inferring from a missing `built-N` — weak, and the PRD's `verify-draft` only checks the artifact count, not outcomes.

This ADR specifies the L3 evolve pass to close both gaps.

## Decision

Five decisions, resolved by grilling (one question at a time) against the existing `AGENTS.md` guardrails (human gate required, never auto-merge, max 3 fix attempts, engine + spec-factory locked).

### 1. Scope = B (propose, human merges)
The evolve pass rewrites the *fast loops' own artifacts* — the `specify` seed prompt, the `gate-evolve` threshold, and (proposed, human-gated) `spec-creator.yaml` task ordering / timeouts and the `l1-*.ps1` helpers. It is **never** autonomous-merge. It writes a proposal; a human applies it. This preserves the locked-engine / human-gate invariants while still enabling compounding improvement.

*Rejected:* (A) narrow-only — too weak to fix root causes like a vague `specify` prompt. (C) full self-modifying — violates the human-gate guardrail.

### 2. Trigger = C gated by A (combo-trigger, not bare cron)
A **cheap deterministic script** (no LLM) runs every L1 tick and answers: "is there a pattern worth learning?" It scans `loop-run-log.md` for (a) a rejection/stagnation cluster — same topic rejected ≥3×, or ≥K consecutive stalled specs — AND (b) a minimum run count since the last evolve pass. Only when both hold does it wake the **LLM** evolve pass.

This is the "anti-busywork" rule made structural: the expensive component runs only when the free check proves there is something to fix. It reuses the existing `gate-evolve.ps1` pattern (cheap pre-check before expensive work).

*Rejected:* (A) every-N-runs-only — fires even with no rejection pattern (token waste). (B) bare slower cron — wakes on empty evidence.

### 3. Evidence = A (extend shared `loop-run-log.md`)
L1's `l1-draft-increment.ps1` appends one line per run: `run_id, spec_N, idea, speckit_exit, artifact_guard_result`. The evolve pass reads this file. Proposals are written to a **separate** `spec-evolve-proposals.md` so the merge decision is isolated from history. Reuses the engine's existing append-only run-log contract (anti-pattern #10 cure, already in architecture).

### 4. Rejection signal = C (both daemons log to shared `loop-run-log.md`, correlated by N)
L2 also appends its build outcome to the **same** `loop-run-log.md`: `built-N` on success, `rejected-N: <reason>` on verifier reject. Entries carry the spec number N so the evolve pass correlates "L1 drafted N" with "L2 built/rejected N" with no inference.

*Consequence:* this requires L2 to actually log its outcome — an explicit sub-task, since the PRD lists L2 as "wired and tested" but does not confirm run-logging. (Fallback if L2 logging is delayed: L1 infers rejection from missing `built-N` within K ticks — weaker, accepted temporarily.)

### 5. Human gate = A (proposal markdown + ready-to-apply patch)
The evolve pass emits `spec-evolve-proposals.md` (each entry: `{date, trigger_pattern, target_file, current→proposed, why, confidence}`) **plus** a `.patch` file. The human reads the markdown, `git apply` if good, and clears the entry. No `gh` dependency (currently unavailable per PRD status), no extra issue noise. Satisfies the human-gate invariant directly.

*Future upgrade:* once `gh` auth returns, the pass may open a draft PR (option B) instead of a local patch.

## Consequences

- **Positive:** The two-loop topology becomes a three-speed topology that *compounds* — L1 drafts, L2 builds, L3 tightens the drafts/builds over time. Matches 2026 best practice (Evolve Run, Escher-Loop, loop-engineering L3).
- **Positive:** Rejection/stagnation now has an explicit, correlated signal instead of L1 guessing from missing `built-N`.
- **Positive:** Token cost bounded — LLM evolve pass only wakes on proven pattern + min run count.
- **Negative:** Adds a third daemon/plan (`spec-evolve.yaml`) and a shared-log format both daemons must honor. Log format drift between L1/L2 would corrupt the signal.
- **Negative:** Requires L2 run-logging work (currently unconfirmed) — a prerequisite sub-task before the evolve pass can function.
- **Negative:** Human must periodically review `spec-evolve-proposals.md` or the loop stops improving (the "review the proposals" step is the new human duty, analogous to daily STATE.md review in AGENTS.md).

## Out of Scope (this ADR)

- Implementing the L3 plan or the `l1-draft-increment.ps1` log-append / L2 log-append — those are issues split from the resulting PRD.
- The v9 Feedback Controller (ADR-0012) — related (systematic self-healing) but engine-internal; the evolve pass is config-layer, outside the locked engine.
- Mode 1 (full `constitution → specify → plan → tasks`) speckit flow — deferred per ADR-0018.
