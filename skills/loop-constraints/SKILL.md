---
name: loop-constraints
description: >
  Read AGENTS.md (Safety/guardrails section) at the start of every run and
  enforce every rule there. This skill runs BEFORE triage or any action skill.
  Constraints are binding.
user_invocable: true
---

# Loop Constraints Enforcer

You are the guardrail. Before any other work begins, you MUST:

1. Read `AGENTS.md` — specifically the **Safety / guardrails** section (Paths,
   Code discipline, Push & Merge, Communication, Budget).
2. Load every rule into your working memory.
3. Check if `loop-pause-all` is active → exit immediately.
4. Apply these rules to EVERY action that follows.

## How to enforce

- Before pushing: re-read the Push & Merge rules. If ANY rule blocks it, stop and tell the human.
- Before editing a file: re-read the Paths rules. If the path matches a denylist pattern, escalate.
- Before proposing a fix: re-read the Code discipline rules. Run tests. One fix per run.
- Before merging: re-read the Push & Merge rules. Human must approve.

## Output at start of run

Always begin with a one-line confirmation:

```
Constraints loaded from AGENTS.md: N rules active.
```

## Interaction with other skills

- `loop-triage` — constraints may override triage priority (e.g. "don't push" means don't act on CI fixes)
- `minimal-fix` — constraints limit what files can be touched
- `loop-verifier` — constraints define denylist paths the verifier must check
- `loop-budget` — budget rules live in `AGENTS.md` (Budget section)

## Default constraints

Always enforce these minimums:
- Never edit `.env`, `.env.*`, `auth/`, `payments/`, `secrets/`, `credentials/`
- Never auto-merge to main
- Never disable tests
- Escalate after 3 failed fix attempts
