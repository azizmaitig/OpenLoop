# L3 Evolve Pass — Issue Breakdown

Source: `docs/prd-l3-evolve-pass.md` + `docs/adr/0019-l3-evolve-pass.md`.
All issues are independently grabbable. Dependencies noted per issue; the human gate (no auto-merge) applies to every code-changing issue. Engine (`agent-loop/src/`) and `spec-factory/` content remain LOCKED — L3 touches only the loop's config/intake layer.

---

## Issue 1 — L2 must log build outcome to `loop-run-log.md`  [PREREQ for L3 signal]
**Labels:** `ready-for-agent`, `l2`, `observability`
**Depends on:** none
**Blocks:** Issue 4 (evolve plan needs the signal)

**What:** Extend `plans/l2-executor.ps1` (stages `verify` / `stamp-built`) to append one line to `loop-run-log.md` per build:
- On success: `{ts, loop:L2, spec_N, event:built}`
- On verifier reject: `{ts, loop:L2, spec_N, event:rejected, detail:<reason>}`

Use `-LiteralPath` / `Join-Path` (space-in-path safe). Append-only; never rewrite the file.

**Acceptance:**
- [ ] `l2-executor.ps1` writes `built-N` on success and `rejected-N: <reason>` on reject.
- [ ] Line matches the shared format `{ts, loop, spec_N, event, detail}` parsable by a regex.
- [ ] Space-in-path safe (vault root has spaces).
- [ ] Contract test: stub the log file, run both stages, assert two correctly-formed lines.

---

## Issue 2 — L1 must log each draft run to `loop-run-log.md`
**Labels:** `ready-for-agent`, `l1`, `observability`
**Depends on:** none
**Blocks:** Issue 4 (evolve pass needs draft evidence)

**What:** Extend `plans/l1-draft-increment.ps1` to append one line per run:
- On draft: `{ts, loop:L1, spec_N, event:drafted, detail:<idea>}`
- On idle (empty inbox / blocked gate): `{ts, loop:L1, spec_N:-, event:idle}`
- On speckit failure: `{ts, loop:L1, spec_N:-, event:failed, detail:<exit>}`

**Acceptance:**
- [ ] Every L1 run appends exactly one line (drafted / idle / failed).
- [ ] `spec_N` correlates with the `evolve-N` L1 just wrote (or `-` when idle/failed).
- [ ] Append-only; no LLM cost (pure PowerShell).
- [ ] Contract test: recorder stub asserts the line shape for drafted + idle + failed.

---

## Issue 3 — Combo-trigger script `l3-should-evolve.ps1` (cheap pre-check, no LLM)
**Labels:** `ready-for-agent`, `l3`, `trigger`
**Depends on:** Issue 1 + Issue 2 (needs real log data to be meaningful, but the script itself is buildable standalone)
**Blocks:** Issue 4 (the evolve plan calls this)

**What:** A PowerShell script that reads `loop-run-log.md` and exits 0 (wake LLM) ONLY when BOTH hold:
- (a) **pattern**: same topic rejected ≥3× consecutively, OR ≥K (default 3) consecutive `stalled`/`idle-without-built` specs.
- (b) **min-runs**: ≥N (default 5) L1 runs since the last `evolved-proposal` entry.

Otherwise exits 0 with NO proposal (idle — mirrors L1's idle contract, no false failure). Pure PowerShell, no `opencode` call.

**Acceptance:**
- [ ] Exits 0-to-wake only when (pattern AND min-runs) both true.
- [ ] Exits idle (no proposal) when pattern absent, OR min-runs not met.
- [ ] Detects 3 consecutive `rejected-N` same topic via log scan.
- [ ] Detects missing `built-N` stalls (fallback signal).
- [ ] Unit test feeds crafted log lines; asserts trigger decisions (≥4 cases).

---

## Issue 4 — L3 evolve plan `spec-evolve.yaml` (LLM step that proposes)
**Labels:** `ready-for-agent`, `l3`, `plan`
**Depends on:** Issue 1, Issue 2, Issue 3
**Blocks:** none (observes; proposes only)

**What:** New plan `plans/spec-evolve.yaml` (own daemon port 3003, slow cron e.g. off L1's grid). Tasks:
1. `read-state` — `type STATE.md`
2. `check-trigger` — call `l3-should-evolve.ps1`; if idle, exit 0 (L3 idles this cycle)
3. `evolve` — LLM step (`opencode run`, CWD = spec-factory): read the relevant `loop-run-log.md` entries + rejected `evolve-N` specs, emit `spec-evolve-proposals.md` + a `.patch`
4. `verify-proposal` — assert proposal file has required fields + non-empty patch; assert target files NOT modified directly

**Acceptance:**
- [ ] Plan parses via `plan-executor` (same loader as L1/L2).
- [ ] `check-trigger` idles cleanly (exit 0) when no pattern.
- [ ] LLM step writes proposal + patch; never edits target files directly.
- [ ] `verify-proposal` fails loud if no proposal despite triggered pattern.
- [ ] Scope B respected: proposals target only intake prompt / gate threshold / plan task structure — never `agent-loop/src/` or `spec-factory/` content.

---

## Issue 5 — Proposal output format + human-review workflow (`spec-evolve-proposals.md` + `.patch`)
**Labels:** `ready-for-agent`, `l3`, `human-gate`
**Depends on:** Issue 4
**Blocks:** none

**What:** Define the proposal file schema and the review workflow. Each entry:
`{date, trigger_pattern, target_file, current→proposed, why, confidence}`. The `.patch` is a `git diff`-shaped file the human `git apply`s. After applying, the human clears the entry. Document the workflow in `AGENTS.md` (new recurring duty, like daily STATE.md review).

**Acceptance:**
- [ ] Schema enforced by `verify-proposal` (all fields present).
- [ ] `.patch` applies cleanly to the proposed target via `git apply --check`.
- [ ] `AGENTS.md` updated with the "review `spec-evolve-proposals.md`" duty.
- [ ] No `gh` dependency (local patch only); draft-PR path noted as future upgrade.

---

## Dependency map

```
Issue 1 (L2 log) ─┐
                  ├─> Issue 3 (combo-trigger) ─> Issue 4 (evolve plan) ─> Issue 5 (proposal+patch)
Issue 2 (L1 log) ─┘
```

Issue 3 can be built in parallel with 1+2 (script is standalone), but only becomes meaningful once 1+2 feed real log data. Issue 4 requires all three. Issue 5 follows 4.

## Suggested grab order
1. Issue 1 + Issue 2 (parallel — both are pure PowerShell log-append, unblock everything)
2. Issue 3 (combo-trigger)
3. Issue 4 (evolve plan)
4. Issue 5 (proposal + human-review workflow)
